"""
Patch planning, generation, validation, and application nodes for FixForge LangGraph.
"""

from datetime import datetime, timezone
import hashlib
from pathlib import Path
from typing import Any


from app.candidate import (
    CandidateEvaluator,
    CandidateRanker,
    TransactionalPromoter,
    compute_diff_hash,
    deduplicate_candidates,
)
from app.context.context_selector import ContextSelector
from app.patch.applier import PatchApplier
from app.patch.validator import PatchValidator
from app.patch_schemas import (
    GeneratedPatch,
    PatchApplicationResult,
    PatchPlan,
    PatchValidationResult,
    RepairCandidate,
    RootCauseAnalysis,
)
from app.providers.factory import get_llm_provider


async def patch_planning_node(state: dict[str, Any]) -> dict[str, Any]:
    timestamps = state.get("timestamps", {})
    timestamps["patch_planning"] = datetime.now(timezone.utc).isoformat()

    agent_events = list(state.get("agent_events", []))
    agent_events.append({
        "event": "PATCH_PLAN_CREATED",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "state": "PATCH_PLANNING",
    })

    root_cause_data = state.get("root_cause_analysis", {})
    if not root_cause_data or root_cause_data.get("failure_type") == "none":
        plan = PatchPlan(
            objective="No patch required; baseline tests passed.",
            files_to_modify=[],
            changes=[],
            risks=[],
        )
        return {
            "current_state": "PATCH_PLANNING",
            "patch_plan": plan.model_dump(),
            "timestamps": timestamps,
            "agent_events": agent_events,
        }

    repo_path = Path(state["repository_path"])
    selector = ContextSelector()
    selected_context = selector.select_context(
        workspace_root=repo_path,
        failures=state.get("failures", []),
        project_structure=state.get("project_structure"),
    )

    # Build retry memory if previous attempts failed
    attempt_history = state.get("attempt_history", [])
    retry_context = ""
    if attempt_history:
        retry_context = "\n\nPREVIOUS FAILED ATTEMPTS (DO NOT REPEAT THESE MISTAKES):\n"
        for prev in attempt_history:
            att_num = prev.get("attempt_number", "?")
            prev_patch = prev.get("patch") or prev.get("generated_patch") or {}
            prev_diff = prev_patch.get("diff", "")
            prev_val = prev.get("validation", {})
            prev_test = prev.get("verification_result", {})
            prev_error = prev_val.get("errors") or prev_test.get("traceback") or prev_test.get("output") or "Failed verification"
            retry_context += f"- Attempt {att_num}: Changed files: {prev_patch.get('files', [])}\n"
            if prev_diff:
                retry_context += f"  Diff attempted:\n{prev_diff[:400]}\n"
            retry_context += f"  Failure reason: {prev_error}\n"

    # Incorporate selected hypothesis context if available
    selected_hyp = state.get("selected_hypothesis") or {}
    hyp_context = ""
    if selected_hyp:
        hyp_context = (
            f"\n\nSELECTED ROOT CAUSE HYPOTHESIS ({selected_hyp.get('hypothesis_id', 'hyp-1')}):\n"
            f"- Statement: {selected_hyp.get('root_cause_statement', '')}\n"
            f"- Relevant Files: {selected_hyp.get('relevant_files', [])}\n"
            f"- Proposed Strategy: {selected_hyp.get('proposed_repair_strategy', '')}\n"
            f"- Causal Explanation: {selected_hyp.get('causal_explanation', '')}\n"
        )

    prompt_messages = [
        {
            "role": "system",
            "content": (
                "You are FixForge's Patch Planning Agent.\n"
                "Formulate a minimal, targeted patch plan to resolve the root cause.\n"
                "STRICT RULES:\n"
                "1. NEVER plan to modify or delete test files. Tests are strictly READ-ONLY.\n"
                "2. Plan the smallest change necessary (prefer 1-5 line changes over whole-file rewrites).\n"
                "3. Preserve existing APIs and backward compatibility."
            ),
        },
        {
            "role": "user",
            "content": (
                f"Root Cause Analysis:\n{root_cause_data}\n"
                f"{hyp_context}\n"
                f"Code Context:\n{selected_context.format_prompt_context()}"
                f"{retry_context}\n\n"
                "Create a structured PatchPlan."
            ),
        },
    ]

    t0 = datetime.now(timezone.utc)
    llm = get_llm_provider()
    plan = await llm.generate_structured(prompt_messages, PatchPlan)
    duration_ms = int((datetime.now(timezone.utc) - t0).total_seconds() * 1000)
    timestamps["patch_planning_duration_ms"] = duration_ms
    total_calls = state.get("total_llm_calls", 0) + 1

    # Sanitize plan: remove any test files from planned files_to_modify
    from app.context.code_context import is_test_path
    safe_files = [f for f in plan.files_to_modify if not is_test_path(f)]
    plan.files_to_modify = safe_files

    return {
        "current_state": "PATCH_PLANNING",
        "patch_plan": plan.model_dump(),
        "total_llm_calls": total_calls,
        "timestamps": timestamps,
        "agent_events": agent_events,
    }


async def patch_generation_node(state: dict[str, Any]) -> dict[str, Any]:
    timestamps = state.get("timestamps", {})
    timestamps["patch_generation"] = datetime.now(timezone.utc).isoformat()

    agent_events = list(state.get("agent_events", []))
    agent_events.append({
        "event": "PATCH_GENERATION_STARTED",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "state": "PATCH_GENERATION",
    })

    patch_plan_data = state.get("patch_plan", {})
    if not patch_plan_data or not patch_plan_data.get("files_to_modify"):
        empty_patch = GeneratedPatch(
            files=[],
            diff="",
            explanation="No files to modify in patch plan.",
        )
        return {
            "current_state": "PATCH_GENERATION",
            "generated_patch": empty_patch.model_dump(),
            "patch_hash": "",
            "is_duplicate_patch": False,
            "timestamps": timestamps,
            "agent_events": agent_events,
        }

    repo_path = Path(state["repository_path"])
    selector = ContextSelector()
    selected_context = selector.select_context(
        workspace_root=repo_path,
        failures=state.get("failures", []),
        project_structure=state.get("project_structure"),
    )

    # Build retry memory if previous attempts failed
    attempt_history = state.get("attempt_history", [])
    retry_context = ""
    if attempt_history:
        retry_context = "\n\nPREVIOUS FAILED ATTEMPTS (DO NOT REPEAT THESE MISTAKES):\n"
        for prev in attempt_history:
            att_num = prev.get("attempt_number", "?")
            prev_patch = prev.get("patch") or prev.get("generated_patch") or {}
            prev_diff = prev_patch.get("diff", "")
            prev_val = prev.get("validation", {})
            prev_test = prev.get("verification_result", {})
            prev_error = prev_val.get("errors") or prev_test.get("traceback") or prev_test.get("output") or "Failed verification"
            retry_context += f"- Attempt {att_num}: Changed files: {prev_patch.get('files', [])}\n"
            if prev_diff:
                retry_context += f"  Diff attempted:\n{prev_diff[:400]}\n"
            retry_context += f"  Failure reason: {prev_error}\n"

    prompt_messages = [
        {
            "role": "system",
            "content": (
                "You are FixForge's Patch Generation Agent.\n"
                "Your task is to generate a clean UNIFIED DIFF (--- a/... +++ b/...) to fix the defect.\n"
                "CRITICAL REQUIREMENTS:\n"
                "1. Output ONLY a valid unified diff with exact line context.\n"
                "2. Minimal patch: change only the specific 1-5 faulty lines.\n"
                "3. NEVER modify test files. Do not weaken assertions or delete tests.\n"
                "4. Do NOT include natural-language remarks inside the diff string itself."
            ),
        },
        {
            "role": "user",
            "content": (
                f"Patch Plan:\n{patch_plan_data}\n\n"
                f"Root Cause:\n{state.get('root_cause_analysis', {})}\n\n"
                f"Code Context:\n{selected_context.format_prompt_context()}"
                f"{retry_context}\n\n"
                "Generate the GeneratedPatch with unified diff."
            ),
        },
    ]

    t0 = datetime.now(timezone.utc)
    llm = get_llm_provider()
    max_cands = min(3, max(1, state.get("max_candidates", 3)))
    attempt = state.get("attempt_number", 1)
    hypotheses = state.get("hypotheses", [])
    primary_hyp_id = state.get("primary_hypothesis_id") or "hyp-1"

    # 1. Check if candidates were pre-populated (e.g. from benchmark fixture or caller input on attempt 1)
    pre_populated = state.get("candidates", [])
    candidate_objs: list[RepairCandidate] = []
    has_pre_populated = bool(pre_populated and attempt == 1 and not state.get("generated_patch"))
    if has_pre_populated:
        for idx, rc in enumerate(pre_populated, start=1):
            c_obj = RepairCandidate.model_validate(rc) if isinstance(rc, dict) else rc
            if not c_obj.diff_hash:
                c_obj.diff_hash = compute_diff_hash(c_obj.diff)
            candidate_objs.append(c_obj)
    else:
        # Generate distinct candidates from top hypotheses (up to max_cands, default 3)
        hyps_to_use = hypotheses[:max_cands] if hypotheses else []
        if not hyps_to_use:
            # Generate primary candidate
            generated = await llm.generate_structured(prompt_messages, GeneratedPatch)
            total_calls = state.get("total_llm_calls", 0) + 1
            cand = RepairCandidate(
                candidate_id=f"cand-{attempt}-1",
                hypothesis_id=primary_hyp_id,
                rationale=generated.explanation or "Minimal patch generated for top-ranked hypothesis",
                files=generated.files,
                changed_files=generated.files,
                diff=generated.diff,
                diff_hash=compute_diff_hash(generated.diff),
                generation_metadata={
                    "model": getattr(llm, "model_name", "gemini"),
                    "hypothesis_id": primary_hyp_id,
                },
                status="PENDING",
            )
            candidate_objs.append(cand)
        else:
            for idx, hyp in enumerate(hyps_to_use, start=1):
                h_id = hyp.get("hypothesis_id", f"hyp-{idx}")
                hyp_prompt_context = (
                    f"\n\nTARGET ROOT CAUSE HYPOTHESIS ({h_id}):\n"
                    f"- Statement: {hyp.get('root_cause_statement', '')}\n"
                    f"- Relevant Files: {hyp.get('relevant_files', [])}\n"
                    f"- Proposed Strategy: {hyp.get('proposed_repair_strategy', '')}\n"
                    f"- Causal Explanation: {hyp.get('causal_explanation', '')}\n"
                )
                cand_messages = [
                    prompt_messages[0],
                    {
                        "role": "user",
                        "content": (
                            f"Patch Plan:\n{patch_plan_data}\n\n"
                            f"{hyp_prompt_context}\n"
                            f"Root Cause:\n{state.get('root_cause_analysis', {})}\n\n"
                            f"Code Context:\n{selected_context.format_prompt_context()}"
                            f"{retry_context}\n\n"
                            f"Generate a minimal GeneratedPatch specifically resolving hypothesis {h_id}."
                        ),
                    },
                ]
                gen = await llm.generate_structured(cand_messages, GeneratedPatch)
                total_calls = state.get("total_llm_calls", 0) + idx
                cand = RepairCandidate(
                    candidate_id=f"cand-{attempt}-{idx}",
                    hypothesis_id=h_id,
                    rationale=gen.explanation or f"Minimal patch resolving hypothesis {h_id}",
                    files=gen.files,
                    changed_files=gen.files,
                    diff=gen.diff,
                    diff_hash=compute_diff_hash(gen.diff),
                    generation_metadata={
                        "model": getattr(llm, "model_name", "gemini"),
                        "hypothesis_id": h_id,
                    },
                    status="PENDING",
                )
                candidate_objs.append(cand)

    duration_ms = int((datetime.now(timezone.utc) - t0).total_seconds() * 1000)
    timestamps["patch_generation_duration_ms"] = duration_ms
    total_calls = state.get("total_llm_calls", 0) + len(candidate_objs)

    # 2. Deduplicate equivalent candidate patches before execution
    unique_cands, dup_cands = deduplicate_candidates(candidate_objs)
    all_candidates = unique_cands + dup_cands

    if dup_cands:
        for dup in dup_cands:
            agent_events.append({
                "event": "DUPLICATE_PATCH_DETECTED",
                "attempt": attempt,
                "candidate_id": dup.candidate_id,
                "duplicate_of": dup.duplicate_of,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "warning": f"Candidate {dup.candidate_id} has equivalent diff to {dup.duplicate_of}",
            })

    first_cand = unique_cands[0] if unique_cands else (all_candidates[0] if all_candidates else None)
    patch_hash = first_cand.diff_hash if first_cand else ""
    diff_clean = (first_cand.diff or "").strip() if first_cand else ""

    # Check for duplicate patch against previous attempts (M5 retry memory)
    is_prev_duplicate = False
    for prev in state.get("attempt_history", []):
        prev_patch = prev.get("patch") or prev.get("generated_patch") or {}
        if prev.get("patch_hash") == patch_hash or prev_patch.get("diff", "").strip() == diff_clean:
            is_prev_duplicate = True
            break

    if is_prev_duplicate:
        agent_events.append({
            "event": "DUPLICATE_PATCH_DETECTED",
            "attempt": attempt,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "warning": "Generated patch matches a previously failed attempt patch",
        })

    print(
        f"[ATTEMPT {attempt}] CANDIDATES_GENERATED: count={len(all_candidates)}, "
        f"unique={len(unique_cands)}, duplicates={len(dup_cands)}",
        flush=True,
    )

    agent_events.append({
        "event": "PATCH_GENERATED",
        "attempt": attempt,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "files": first_cand.changed_files if first_cand else [],
        "diff_length": len(first_cand.diff) if first_cand else 0,
        "patch_hash": patch_hash[:8] if patch_hash else "",
        "candidate_id": first_cand.candidate_id if first_cand else "",
        "hypothesis_id": first_cand.hypothesis_id if first_cand else "",
    })

    agent_events.append({
        "event": "CANDIDATES_GENERATED",
        "attempt": attempt,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "total_candidates": len(all_candidates),
        "unique_candidates": len(unique_cands),
        "duplicate_candidates": len(dup_cands),
        "candidate_ids": [c.candidate_id for c in all_candidates],
    })

    first_patch = GeneratedPatch(
        files=first_cand.changed_files if first_cand else [],
        diff=first_cand.diff if first_cand else "",
        explanation=first_cand.rationale if first_cand else "",
    )

    return {
        "current_state": "PATCH_GENERATION",
        "generated_patch": first_patch.model_dump(),
        "candidates": [c.model_dump() for c in all_candidates],
        "selected_candidate": first_cand.model_dump() if first_cand else None,
        "patch_hash": patch_hash,
        "is_duplicate_patch": is_prev_duplicate or bool(dup_cands and not unique_cands),
        "total_llm_calls": total_calls,
        "timestamps": timestamps,
        "agent_events": agent_events,
    }


async def patch_validation_node(state: dict[str, Any]) -> dict[str, Any]:
    timestamps = state.get("timestamps", {})
    t0 = datetime.now(timezone.utc)
    timestamps["patch_validation"] = t0.isoformat()

    agent_events = list(state.get("agent_events", []))
    agent_events.append({
        "event": "PATCH_VALIDATION_STARTED",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "state": "PATCH_VALIDATION",
    })

    repo_path = Path(state["repository_path"])
    raw_candidates = state.get("candidates", [])
    candidate_objs: list[RepairCandidate] = []
    if raw_candidates:
        for rc in raw_candidates:
            candidate_objs.append(RepairCandidate.model_validate(rc) if isinstance(rc, dict) else rc)
    elif state.get("generated_patch"):
        gp = state["generated_patch"]
        cand = RepairCandidate(
            candidate_id=f"cand-{state.get('attempt_number', 1)}-1",
            hypothesis_id=state.get("primary_hypothesis_id") or "hyp-1",
            rationale=gp.get("explanation", ""),
            files=gp.get("files", []),
            changed_files=gp.get("files", []),
            diff=gp.get("diff", ""),
            diff_hash=compute_diff_hash(gp.get("diff", "")),
            status="PENDING",
        )
        candidate_objs.append(cand)

    # Determine allowed files
    allowed_files: set[str] = set()
    for f in state.get("patch_plan", {}).get("files_to_modify", []):
        if f:
            allowed_files.add(f)
    for ev in state.get("root_cause_analysis", {}).get("evidence", []):
        if isinstance(ev, dict) and ev.get("file_path"):
            allowed_files.add(ev["file_path"])
    for sf in state.get("root_cause_analysis", {}).get("suspected_files", []):
        if sf:
            allowed_files.add(sf)

    # Check whether to run isolated candidate evaluation (M12.3) or static validation (M4/M5)
    is_candidate_eval_mode = (
        state.get("evaluate_candidates", False)
        or state.get("route_to_human_review_on_no_candidates", False)
        or len(candidate_objs) > 1
    )

    attempt = state.get("attempt_number", 1)
    eval_duration_ms = 0
    candidate_rejections: dict[str, str] = {}
    selected_cand = None
    gen_patch = state.get("generated_patch")
    patch_hash = state.get("patch_hash", "")

    if is_candidate_eval_mode:
        agent_events.append({
            "event": "CANDIDATE_EVALUATION_STARTED",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "candidate_count": len(candidate_objs),
            "state": "PATCH_VALIDATION",
        })

        evaluator = CandidateEvaluator(
            baseline_repo_path=repo_path,
            test_command=state.get("test_command", "pytest"),
            test_framework=state.get("test_framework", "pytest"),
            timeout=60.0,
            focal_test_command=state.get("focal_test_command"),
            allowed_files=list(allowed_files) if allowed_files else None,
        )
        baseline_failures = state.get("failure_signatures", []) or state.get("failures", [])
        evaluated_cands = await evaluator.evaluate_all(candidate_objs, baseline_failures)

        selected_cand, ranked_cands = CandidateRanker.rank_and_select(evaluated_cands)
        eval_duration_ms = int((datetime.now(timezone.utc) - t0).total_seconds() * 1000)
        timestamps["candidate_evaluation_duration_ms"] = eval_duration_ms

        for c in ranked_cands:
            if c.rejection_reason:
                candidate_rejections[c.candidate_id] = c.rejection_reason

        if selected_cand:
            print(
                f"[ATTEMPT {attempt}] CANDIDATE_SELECTED: id={selected_cand.candidate_id}, "
                f"score={selected_cand.ranking_score:.2f}, rationale={selected_cand.selection_rationale}",
                flush=True,
            )
            agent_events.append({
                "event": "CANDIDATE_SELECTED",
                "attempt": attempt,
                "candidate_id": selected_cand.candidate_id,
                "score": selected_cand.ranking_score,
                "rationale": selected_cand.selection_rationale,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })
            val_result = selected_cand.validation or PatchValidationResult(
                valid=True,
                status="VALID",
                errors=[],
                warnings=[],
                files_to_modify=selected_cand.changed_files,
                lines_added=selected_cand.lines_added,
                lines_removed=selected_cand.lines_removed,
            )
            selected_dict = selected_cand.model_dump()
            gen_patch = GeneratedPatch(
                files=selected_cand.changed_files,
                diff=selected_cand.diff,
                explanation=selected_cand.rationale,
            ).model_dump()
            patch_hash = selected_cand.diff_hash
        else:
            print(
                f"[ATTEMPT {attempt}] NO_CANDIDATE_SELECTED: {len(ranked_cands)} evaluated, all rejected: {candidate_rejections}",
                flush=True,
            )
            agent_events.append({
                "event": "ALL_CANDIDATES_REJECTED",
                "attempt": attempt,
                "candidate_count": len(ranked_cands),
                "rejections": candidate_rejections,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })
            has_review = any(
                c.validation and c.validation.status == "REQUIRES_REVIEW" for c in ranked_cands
            )
            val_status = "REQUIRES_REVIEW" if has_review else "INVALID"
            errors_list = list(candidate_rejections.values()) if candidate_rejections else ["No candidate patch qualified."]
            val_result = PatchValidationResult(
                valid=False,
                status=val_status,
                errors=errors_list,
                warnings=[],
                files_to_modify=[],
                lines_added=0,
                lines_removed=0,
            )
            selected_dict = None
    else:
        # Standard single-candidate validation (M4/M5)
        if state.get("is_duplicate_patch", False):
            val_result = PatchValidationResult(
                valid=False,
                status="INVALID",
                errors=["Duplicate patch rejected: generated patch is identical to a previously failed attempt patch."],
                warnings=[],
                files_to_modify=[],
                lines_added=0,
                lines_removed=0,
            )
        else:
            patch_data = state.get("generated_patch", {})
            diff_text = patch_data.get("diff", "")

            validator = PatchValidator(repo_path)
            val_result = validator.validate_patch(
                diff_text,
                allowed_files=list(allowed_files) if allowed_files else None,
            )

        ranked_cands = candidate_objs
        if ranked_cands:
            c0 = ranked_cands[0]
            c0.validation = val_result
            c0.status = "VALID" if val_result.valid else ("REQUIRES_REVIEW" if val_result.status == "REQUIRES_REVIEW" else "INVALID")
            if not val_result.valid:
                c0.rejection_reason = "; ".join(val_result.errors)
            selected_dict = c0.model_dump() if val_result.valid else None
        else:
            selected_dict = None

    if val_result.valid:
        print(f"[ATTEMPT {attempt}] PATCH_VALIDATED: valid=True, status={val_result.status}", flush=True)
    else:
        print(f"[ATTEMPT {attempt}] PATCH_VALIDATED: valid=False, status={val_result.status}, errors={val_result.errors}", flush=True)

    agent_events.append({
        "event": "PATCH_VALIDATED",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "valid": val_result.valid,
        "status": val_result.status,
        "errors": val_result.errors,
    })

    return {
        "current_state": "PATCH_VALIDATION",
        "patch_validation": val_result.model_dump(),
        "candidates": [c.model_dump() for c in ranked_cands],
        "selected_candidate": selected_dict,
        "generated_patch": gen_patch,
        "patch_hash": patch_hash,
        "candidate_rejections": candidate_rejections,
        "selection_rationale": selected_cand.selection_rationale if selected_cand else ("No candidate satisfied verification policy." if is_candidate_eval_mode else "Single candidate validated."),
        "candidate_evaluation_duration_ms": eval_duration_ms,
        "route_to_human_review_on_no_candidates": state.get("route_to_human_review_on_no_candidates", False),
        "timestamps": timestamps,
        "agent_events": agent_events,
    }


async def patch_application_node(state: dict[str, Any]) -> dict[str, Any]:
    timestamps = state.get("timestamps", {})
    timestamps["patch_application"] = datetime.now(timezone.utc).isoformat()

    agent_events = list(state.get("agent_events", []))
    validation_data = state.get("patch_validation", {})
    repo_path = Path(state["repository_path"])
    promoter = TransactionalPromoter(repo_path)
    attempt = state.get("attempt_number", 1)

    if not validation_data.get("valid", False):
        app_result = promoter.promote_candidate(None)
        print(f"[ATTEMPT {attempt}] PATCH_APPLICATION_SKIPPED: patch validation failed.", flush=True)
        agent_events.append({
            "event": "PATCH_APPLIED",
            "attempt": attempt,
            "applied": False,
            "status": "FAILED",
            "files_modified": [],
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })
        return {
            "current_state": "PATCH_APPLICATION",
            "patch_application": app_result.model_dump(),
            "timestamps": timestamps,
            "agent_events": agent_events,
        }

    # Promote candidate transactionally into main repository workspace
    selected_dict = state.get("selected_candidate")
    if selected_dict:
        cand_obj = RepairCandidate.model_validate(selected_dict)
    else:
        # Fall back to generated_patch if available
        gp = state.get("generated_patch", {})
        cand_obj = RepairCandidate(
            candidate_id=f"cand-{attempt}-1",
            hypothesis_id="hyp-1",
            files=gp.get("files", []),
            diff=gp.get("diff", ""),
            status="VALID",
        )

    app_result = promoter.promote_candidate(cand_obj)
    print(f"[ATTEMPT {attempt}] PATCH_APPLIED: applied={app_result.applied}, files={app_result.files_modified}", flush=True)

    agent_events.append({
        "event": "PATCH_APPLIED",
        "attempt": attempt,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "applied": app_result.applied,
        "status": app_result.status,
        "files_modified": app_result.files_modified,
    })
    if cand_obj:
        agent_events.append({
            "event": "CANDIDATE_PROMOTED",
            "attempt": attempt,
            "candidate_id": cand_obj.candidate_id,
            "applied": app_result.applied,
            "status": app_result.status,
            "files_modified": app_result.files_modified,
            "backup_id": app_result.backup_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })

    return {
        "current_state": "PATCH_APPLICATION",
        "patch_application": app_result.model_dump(),
        "timestamps": timestamps,
        "agent_events": agent_events,
    }

