"""
Root cause analysis node for FixForge LangGraph.
Distinguishes observed facts from hypotheses and evidence.
"""

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.context.context_selector import ContextSelector
from app.patch_schemas import RootCauseAnalysis
from app.providers.factory import get_llm_provider
from app.workspace import WorkspaceManager


async def root_cause_analysis_node(state: dict[str, Any]) -> dict[str, Any]:
    timestamps = state.get("timestamps", {})
    timestamps["root_cause_analysis"] = datetime.now(timezone.utc).isoformat()

    attempt = state.get("attempt_number", 1)
    print(f"[ATTEMPT {attempt}] START", flush=True)

    agent_events = list(state.get("agent_events", []))
    agent_events.append({
        "event": "ROOT_CAUSE_ANALYSIS_STARTED",
        "attempt": attempt,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "state": "ROOT_CAUSE_ANALYSIS",
    })

    failures = state.get("failures", [])
    repo_path = Path(state["repository_path"])

    baseline = state.get("baseline_result", {})
    baseline_exit_code = baseline.get("exit_code", 0)
    baseline_total = baseline.get("total", 0)

    if not failures:
        if baseline_exit_code != 0 or baseline_total == 0:
            analysis = RootCauseAnalysis(
                summary=f"No tests were collected or baseline test execution failed (exit code {baseline_exit_code}, {baseline_total} tests collected).",
                failure_type="no_tests_collected",
                root_cause=f"Test runner exited with code {baseline_exit_code} with {baseline_total} tests collected. Test assertions were not discovered or executable.",
                observed=f"Exit code: {baseline_exit_code}, Total tests: {baseline_total}",
                hypothesis="Repository test configuration, naming convention, or file layout mismatch.",
                evidence=[],
                confidence=0.1,
            )
        else:
            # Genuine clean pass with positive tests
            analysis = RootCauseAnalysis(
                summary="All baseline tests passed. No active failure detected.",
                failure_type="none",
                root_cause="Baseline test suite executed cleanly with 0 failures.",
                observed="All tests reported PASSED.",
                hypothesis="Repository code conforms to current test assertions.",
                evidence=[],
                confidence=1.0,
            )
        agent_events.append({
            "event": "ROOT_CAUSE_IDENTIFIED",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "summary": analysis.summary,
        })
        return {
            "current_state": "ROOT_CAUSE_ANALYSIS",
            "root_cause_analysis": analysis.model_dump(),
            "root_cause_confidence": analysis.confidence,
            "relevant_files": [],
            "timestamps": timestamps,
            "agent_events": agent_events,
        }

    # 1. Select context safely using ContextSelector
    selector = ContextSelector()
    selected_context = selector.select_context(
        workspace_root=repo_path,
        failures=failures,
        project_structure=state.get("project_structure"),
    )

    formatted_context = selected_context.format_prompt_context()

    # 2. Check for previous attempt memory
    attempt_num = state.get("attempt_number", 1)
    attempt_history = state.get("attempt_history", [])
    history_feedback = ""
    if attempt_num > 1 and attempt_history:
        prev = attempt_history[-1]
        prev_patch = ""
        if isinstance(prev.get("patch"), dict):
            prev_patch = prev.get("patch", {}).get("diff", "")
        elif isinstance(prev.get("generated_patch"), dict):
            prev_patch = prev.get("generated_patch", {}).get("diff", "")
        elif prev.get("patch"):
            prev_patch = str(prev.get("patch"))

        prev_verif = prev.get("verification", {}) or prev.get("verification_result", {}) or {}
        history_feedback = (
            f"\n\n### PREVIOUS ATTEMPT {attempt_num - 1} EXECUTION FEEDBACK:\n"
            f"- Attempt Status: {prev.get('status')}\n"
            f"- Previous Patch:\n```diff\n{prev_patch}\n```\n"
            f"- Verification Outcome: {prev_verif.get('status')}, {prev_verif.get('failed', 0)} failed tests\n"
            f"- Stdout snippet:\n```text\n{str(prev_verif.get('stdout', ''))[:600]}\n```\n"
            "CRITICAL: The previous patch FAILED during test verification. "
            "Do NOT repeat the exact same reasoning or patch. Identify why the previous attempt failed and propose a refined root cause."
        )

    # 3. Build prompt distinguishing facts from hypotheses and supporting multiple hypotheses
    prompt_messages = [
        {
            "role": "system",
            "content": (
                "You are FixForge's Root Cause Debugging Agent.\n"
                "Your objective is to analyze real test failures, traceback lines, and source code.\n"
                "CRITICAL PRINCIPLES:\n"
                "1. OBSERVED FACTS: What the test run actually produced (exact return value, error, or exception).\n"
                "2. AI HYPOTHESIS: Your reasoning explaining why the observed failure occurred.\n"
                "3. SOURCE EVIDENCE: For each evidence item, reference the exact file, line number, reason, "
                "observed_behavior, expected_behavior, and associated failing_test.\n"
                "4. MULTI-HYPOTHESIS DIAGNOSIS: When evidence supports multiple potential explanations "
                "(e.g., caller vs callee, arithmetic vs boundary, logic error vs missing exception handler, "
                "or misleading comments), formulate up to 3 bounded hypotheses in `hypotheses`. "
                "Each hypothesis must have: hypothesis_id ('hyp-1', 'hyp-2'...), root_cause_statement, "
                "relevant_files, supporting_evidence, observed_behavior, expected_behavior, causal_explanation, "
                "confidence_score [0.0-1.0], missing_evidence_or_assumptions, and proposed_repair_strategy.\n"
                "5. ABSTENTION: If evidence is insufficient, contradictory, or missing, set "
                "abstention_recommended=True with a clear abstention_reason.\n\n"
                "Do NOT guess or invent files. Reference only real files and line numbers."
            ),
        },
        {
            "role": "user",
            "content": (
                f"Failures detected during testing:\n{failures}\n\n"
                f"{formatted_context}\n"
                f"{history_feedback}\n\n"
                "Analyze the root cause and provide structured output with candidate hypotheses."
            ),
        },
    ]

    llm = get_llm_provider()
    analysis = await llm.generate_structured(prompt_messages, RootCauseAnalysis)
    total_calls = state.get("total_llm_calls", 0) + 1

    # 4. Validate evidence: ensure cited evidence files actually exist in repo
    valid_evidence = []
    for ev in analysis.evidence:
        target_f = (repo_path / ev.file).resolve()
        if target_f.is_file() and target_f.is_relative_to(repo_path):
            valid_evidence.append(ev)
    analysis.evidence = valid_evidence

    # 5. Populate default hypothesis if none were returned
    from app.patch_schemas import DiagnosisHypothesis
    from app.hypothesis.ranker import rank_hypotheses

    if not analysis.hypotheses:
        cited_files = [f"{ev.file}:{ev.line}" if ev.line else ev.file for ev in valid_evidence]
        if not cited_files and selected_context.focal_source_files:
            cited_files = selected_context.focal_source_files[:2]

        default_hyp = DiagnosisHypothesis(
            hypothesis_id="hyp-1",
            root_cause_statement=analysis.summary,
            relevant_files=cited_files,
            supporting_evidence=[f"{ev.file}: {ev.reason}" for ev in valid_evidence],
            observed_behavior=analysis.observed,
            expected_behavior="Pass all test assertions without regressions.",
            causal_explanation=analysis.root_cause,
            confidence_score=analysis.confidence,
            missing_evidence_or_assumptions=[],
            proposed_repair_strategy="Apply minimal fix to cited files.",
        )
        analysis.hypotheses = [default_hyp]

    # 6. Rank hypotheses deterministically using HypothesisRanker
    raw_output = state.get("baseline_result", {}).get("stdout", "")
    ranked_hypotheses = rank_hypotheses(analysis.hypotheses, failures, repo_path, test_output=raw_output)
    analysis.hypotheses = ranked_hypotheses

    selected_hyp = ranked_hypotheses[0] if ranked_hypotheses else None
    if selected_hyp:
        analysis.primary_hypothesis_id = selected_hyp.hypothesis_id
        # Check for abstention condition: very low ranking score with unverified assumptions
        if selected_hyp.ranking_score is not None and selected_hyp.ranking_score < 15.0 and selected_hyp.missing_evidence_or_assumptions:
            analysis.abstention_recommended = True
            if not analysis.abstention_reason:
                analysis.abstention_reason = (
                    f"Top hypothesis '{selected_hyp.hypothesis_id}' scored {selected_hyp.ranking_score} "
                    f"due to unverified assumptions and insufficient runtime evidence."
                )

    relevant_files = list(selected_context.file_contexts.keys())

    print(f"[ATTEMPT {attempt}] ROOT_CAUSE: {analysis.summary} (hypotheses={len(analysis.hypotheses)}, top={analysis.primary_hypothesis_id})", flush=True)

    agent_events.append({
        "event": "ROOT_CAUSE_IDENTIFIED",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "summary": analysis.summary,
        "confidence": analysis.confidence,
        "top_hypothesis": analysis.primary_hypothesis_id,
        "hypotheses_count": len(analysis.hypotheses),
        "abstention_recommended": analysis.abstention_recommended,
    })

    return {
        "current_state": "ROOT_CAUSE_ANALYSIS",
        "root_cause_analysis": analysis.model_dump(),
        "root_cause_confidence": analysis.confidence,
        "hypotheses": [h.model_dump() for h in analysis.hypotheses],
        "primary_hypothesis_id": analysis.primary_hypothesis_id,
        "selected_hypothesis": selected_hyp.model_dump() if selected_hyp else None,
        "abstention": analysis.abstention_recommended,
        "abstention_reason": analysis.abstention_reason or "",
        "relevant_files": relevant_files,
        "repository_context": {
            "focal_test_file": selected_context.focal_test_file,
            "focal_source_files": selected_context.focal_source_files,
            "total_characters": selected_context.total_characters,
        },
        "timestamps": timestamps,
        "agent_events": agent_events,
        "total_llm_calls": total_calls,
    }

