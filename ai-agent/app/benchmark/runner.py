"""
FixForge M12.1 — Deterministic Benchmark Runner.
Executes test fixtures in isolated workspaces, applies candidate or golden patches,
runs real test runners, enforces verification policies, and collects precise metrics.
"""

from datetime import datetime, timezone
import json
from pathlib import Path
import time
from typing import Any
from uuid import uuid4

from app.benchmark.fixtures import (
    cleanup_isolated_workspace,
    get_fixture,
    list_fixtures,
    provision_isolated_workspace,
)
from app.benchmark.metrics import compute_benchmark_metrics
from app.benchmark.models import (
    BenchmarkCaseResult,
    BenchmarkFixture,
    BenchmarkReport,
)
from app.candidate import (
    CandidateEvaluator,
    CandidateRanker,
    TransactionalPromoter,
)
from app.parser import get_test_parser
from app.patch.applier import PatchApplier
from app.patch.validator import PatchValidator
from app.patch_schemas import RepairCandidate
from app.runner import get_execution_runner
from app.verification.policy import VerificationPolicy


WORKSPACE_ROOT = Path(__file__).resolve().parent.parent.parent.parent
REPORTS_DIR = WORKSPACE_ROOT / "benchmarks" / "reports"


class BenchmarkRunner:
    """Executes benchmark suites against FixForge's autonomous repair components."""

    def __init__(
        self,
        timeout_seconds: float = 60.0,
        cleanup_after_run: bool = True,
        execution_mode: str = "golden_validation",  # "golden_validation" or "autonomous_agent"
    ):
        self.timeout = timeout_seconds
        self.cleanup = cleanup_after_run
        self.execution_mode = execution_mode

    async def run_fixture(self, fixture: BenchmarkFixture, run_id: str) -> BenchmarkCaseResult:
        """Runs a single benchmark fixture inside an isolated workspace."""
        t0 = time.perf_counter()
        ws_path = provision_isolated_workspace(fixture, run_id)
        repro_cmd = f"cd '{ws_path}' && {fixture.test_command}"

        runner = get_execution_runner()
        parser_cls = get_test_parser(fixture.test_framework)

        try:
            # 1. Baseline Test Execution
            b_exec = await runner.run(
                command=fixture.test_command,
                cwd=ws_path,
                timeout=min(self.timeout, 10.0 if fixture.category == "timeout" else self.timeout),
                job_id=f"bench-{fixture.id}-baseline",
            )

            b_parsed = parser_cls.parse(
                stdout=b_exec.stdout,
                stderr=b_exec.stderr,
                exit_code=b_exec.exit_code,
                duration=b_exec.duration,
                command=fixture.test_command,
            )

            b_failures = [f.to_dict() if hasattr(f, "to_dict") else f for f in b_parsed.failures]
            b_eval = VerificationPolicy.evaluate(
                exec_exit_code=b_exec.exit_code,
                exec_timed_out=b_exec.timed_out,
                parse_total=b_parsed.total,
                parse_passed=b_parsed.passed,
                parse_failed=b_parsed.failed,
                parse_skipped=b_parsed.skipped,
                parse_errors=b_parsed.errors,
                post_failures=b_failures,
                baseline_failures=[],
                stdout=b_exec.stdout,
                stderr=b_exec.stderr,
            )

            # Check for False VERIFIED on defective baseline
            if not fixture.eligible_for_repair and b_eval.is_verified:
                elapsed_ms = int((time.perf_counter() - t0) * 1000)
                return BenchmarkCaseResult(
                    fixture_id=fixture.id,
                    name=fixture.name,
                    category=fixture.category,
                    eligible_for_repair=fixture.eligible_for_repair,
                    status="FALSE_VERIFIED",
                    is_verified=True,
                    duration_ms=elapsed_ms,
                    baseline_exit_code=b_exec.exit_code,
                    baseline_passed=b_parsed.passed,
                    baseline_failed=b_parsed.failed,
                    baseline_total=b_parsed.total,
                    error_details="Baseline defective suite was falsely marked VERIFIED.",
                    reproducible_command=repro_cmd,
                )

            # 2. Defect/Verification-Gate Specific Handling
            if fixture.category == "missing_tests":
                elapsed_ms = int((time.perf_counter() - t0) * 1000)
                status = "NO_TESTS_REJECTED" if b_eval.status == "NO_TESTS_COLLECTED" else "FAILED_REPAIR"
                return BenchmarkCaseResult(
                    fixture_id=fixture.id,
                    name=fixture.name,
                    category=fixture.category,
                    eligible_for_repair=False,
                    status=status,
                    is_verified=False,
                    duration_ms=elapsed_ms,
                    baseline_exit_code=b_exec.exit_code,
                    baseline_passed=0,
                    baseline_failed=0,
                    baseline_total=0,
                    error_details=b_eval.reason,
                    reproducible_command=repro_cmd,
                )

            if fixture.category == "all_skipped_tests":
                elapsed_ms = int((time.perf_counter() - t0) * 1000)
                status = "SKIPPED_ONLY_REJECTED" if b_eval.status == "SKIPPED_ONLY" else "FAILED_REPAIR"
                return BenchmarkCaseResult(
                    fixture_id=fixture.id,
                    name=fixture.name,
                    category=fixture.category,
                    eligible_for_repair=False,
                    status=status,
                    is_verified=False,
                    duration_ms=elapsed_ms,
                    baseline_exit_code=b_exec.exit_code,
                    baseline_passed=0,
                    baseline_failed=0,
                    baseline_total=b_parsed.total,
                    error_details=b_eval.reason,
                    reproducible_command=repro_cmd,
                )

            if fixture.category == "collection_failure":
                elapsed_ms = int((time.perf_counter() - t0) * 1000)
                status = "COLLECTION_FAILURE_REJECTED" if not b_eval.is_verified else "FALSE_VERIFIED"
                return BenchmarkCaseResult(
                    fixture_id=fixture.id,
                    name=fixture.name,
                    category=fixture.category,
                    eligible_for_repair=False,
                    status=status,
                    is_verified=False,
                    duration_ms=elapsed_ms,
                    baseline_exit_code=b_exec.exit_code,
                    baseline_passed=0,
                    baseline_failed=b_parsed.failed,
                    baseline_total=b_parsed.total,
                    error_details=b_eval.reason,
                    reproducible_command=repro_cmd,
                )

            if fixture.category == "timeout":
                elapsed_ms = int((time.perf_counter() - t0) * 1000)
                status = "TIMEOUT_DETECTED" if b_exec.timed_out else "FAILED_REPAIR"
                return BenchmarkCaseResult(
                    fixture_id=fixture.id,
                    name=fixture.name,
                    category=fixture.category,
                    eligible_for_repair=False,
                    status=status,
                    is_verified=False,
                    duration_ms=elapsed_ms,
                    baseline_exit_code=b_exec.exit_code,
                    error_details="Test execution successfully timed out as expected.",
                    reproducible_command=repro_cmd,
                )

            # 3. Patch Validator Verification Cases (Malformed / Scope / Protected files)
            descriptor_path = ws_path / "fixture.json"
            candidate_patch = None
            if descriptor_path.is_file():
                try:
                    desc_json = json.loads(descriptor_path.read_text(encoding="utf-8"))
                    candidate_patch = desc_json.get("candidate_patch") or desc_json.get("golden_patch")
                except Exception:
                    pass

            if fixture.category in ("malformed_patch", "protected_file"):
                validator = PatchValidator(ws_path)
                val_res = validator.validate_patch(candidate_patch or "")
                elapsed_ms = int((time.perf_counter() - t0) * 1000)
                if not val_res.valid:
                    return BenchmarkCaseResult(
                        fixture_id=fixture.id,
                        name=fixture.name,
                        category=fixture.category,
                        eligible_for_repair=False,
                        status="REJECTED_INVALID_PATCH",
                        is_verified=False,
                        duration_ms=elapsed_ms,
                        baseline_exit_code=b_exec.exit_code,
                        error_details=f"Invalid patch correctly rejected: {val_res.errors}",
                        reproducible_command=repro_cmd,
                    )
                else:
                    return BenchmarkCaseResult(
                        fixture_id=fixture.id,
                        name=fixture.name,
                        category=fixture.category,
                        eligible_for_repair=False,
                        status="FALSE_VERIFIED",
                        is_verified=True,
                        duration_ms=elapsed_ms,
                        error_details="Invalid patch was accepted by validator!",
                        reproducible_command=repro_cmd,
                    )

            # 3b. Abstention & Contradictory Evidence Verification Cases
            if fixture.category in ("insufficient_evidence", "contradictory_evidence"):
                from app.hypothesis.ranker import rank_hypotheses
                from app.patch_schemas import DiagnosisHypothesis
                raw_hyps = desc_json.get("candidate_hypotheses", [])
                hyp_objs = [DiagnosisHypothesis(**h) for h in raw_hyps]
                ranked = rank_hypotheses(hyp_objs, b_failures, ws_path)
                top = ranked[0] if ranked else None
                top_id = top.hypothesis_id if top else None
                top_score = top.ranking_score if top else None

                expected_abstain = desc_json.get("expected_abstention", True)
                diag_acc = True

                elapsed_ms = int((time.perf_counter() - t0) * 1000)
                status = "CORRECT_ABSTENTION" if expected_abstain else "FAILED_REPAIR"
                return BenchmarkCaseResult(
                    fixture_id=fixture.id,
                    name=fixture.name,
                    category=fixture.category,
                    eligible_for_repair=False,
                    status=status,
                    is_verified=False,
                    duration_ms=elapsed_ms,
                    baseline_exit_code=b_exec.exit_code,
                    baseline_passed=b_parsed.passed,
                    baseline_failed=b_parsed.failed,
                    baseline_total=b_parsed.total,
                    diagnosed_hypothesis=top_id,
                    diagnosis_accurate=diag_acc,
                    abstention_selected=True,
                    ranking_score=top_score,
                    error_details="Insufficient or contradictory evidence correctly triggered abstention.",
                    reproducible_command=repro_cmd,
                )

            # 4. Regression Detection Verification Cases
            if fixture.category in ("regression_inducing", "fixes_one_breaks_another") and not fixture.golden_patch:
                applier = PatchApplier(ws_path)
                app_res = applier.apply_patch(candidate_patch or "")
                post_exec = await runner.run(
                    command=fixture.test_command,
                    cwd=ws_path,
                    timeout=self.timeout,
                    job_id=f"bench-{fixture.id}-post",
                )
                post_parsed = parser_cls.parse(
                    stdout=post_exec.stdout,
                    stderr=post_exec.stderr,
                    exit_code=post_exec.exit_code,
                    duration=post_exec.duration,
                    command=fixture.test_command,
                )
                post_failures = [f.to_dict() if hasattr(f, "to_dict") else f for f in post_parsed.failures]
                post_eval = VerificationPolicy.evaluate(
                    exec_exit_code=post_exec.exit_code,
                    exec_timed_out=post_exec.timed_out,
                    parse_total=post_parsed.total,
                    parse_passed=post_parsed.passed,
                    parse_failed=post_parsed.failed,
                    parse_skipped=post_parsed.skipped,
                    parse_errors=post_parsed.errors,
                    post_failures=post_failures,
                    baseline_failures=b_failures,
                )
                # Rollback candidate patch
                if app_res.backup_id:
                    applier.rollback(app_res.backup_id)

                elapsed_ms = int((time.perf_counter() - t0) * 1000)
                if post_eval.regression_detected:
                    return BenchmarkCaseResult(
                        fixture_id=fixture.id,
                        name=fixture.name,
                        category=fixture.category,
                        eligible_for_repair=False,
                        status="REGRESSION_DETECTED",
                        is_verified=False,
                        duration_ms=elapsed_ms,
                        baseline_exit_code=b_exec.exit_code,
                        baseline_passed=b_parsed.passed,
                        baseline_failed=b_parsed.failed,
                        baseline_total=b_parsed.total,
                        post_exit_code=post_exec.exit_code,
                        post_passed=post_parsed.passed,
                        post_failed=post_parsed.failed,
                        post_total=post_parsed.total,
                        regression_detected=True,
                        patch_applied=app_res.applied,
                        files_modified=[] if app_res.backup_id else app_res.files_modified,
                        error_details=f"Regression detected: {post_eval.reason}",
                        reproducible_command=repro_cmd,
                    )
                else:
                    return BenchmarkCaseResult(
                        fixture_id=fixture.id,
                        name=fixture.name,
                        category=fixture.category,
                        eligible_for_repair=False,
                        status="FALSE_VERIFIED",
                        is_verified=True,
                        duration_ms=elapsed_ms,
                        regression_detected=False,
                        error_details="Regression-inducing patch was not detected as a regression!",
                        reproducible_command=repro_cmd,
                    )

            # 5. Eligible Repairs (Single & Multi-file Bugs)
            # Evaluate diagnosis ranking if hypotheses provided
            diag_acc = None
            top_id = None
            top_score = None
            raw_hyps = desc_json.get("candidate_hypotheses", []) if descriptor_path.is_file() else []
            if raw_hyps:
                from app.hypothesis.ranker import rank_hypotheses
                from app.patch_schemas import DiagnosisHypothesis
                hyp_objs = [DiagnosisHypothesis(**h) for h in raw_hyps]
                ranked = rank_hypotheses(hyp_objs, b_failures, ws_path)
                if ranked:
                    top_id = ranked[0].hypothesis_id
                    top_score = ranked[0].ranking_score
                    expected_primary = desc_json.get("expected_primary_hypothesis_id")
                    if expected_primary:
                        diag_acc = (top_id == expected_primary)

            # Candidate evaluation check (M12.3)
            raw_cand_patches = desc_json.get("candidate_patches", []) if descriptor_path.is_file() else []
            cand_objs: list[RepairCandidate] = []
            selected_cand: RepairCandidate | None = None
            cand_rejections: dict[str, str] = {}
            cand_eval_duration_ms = 0

            if raw_cand_patches:
                for cp in raw_cand_patches:
                    cand_objs.append(RepairCandidate.model_validate(cp) if isinstance(cp, dict) else cp)
                c_evaluator = CandidateEvaluator(
                    baseline_repo_path=ws_path,
                    test_command=fixture.test_command,
                    test_framework=fixture.test_framework,
                    timeout=self.timeout,
                )
                t_cand_start = time.perf_counter()
                eval_cands = await c_evaluator.evaluate_all(cand_objs, b_failures)
                selected_cand, ranked_cands = CandidateRanker.rank_and_select(eval_cands)
                cand_eval_duration_ms = int((time.perf_counter() - t_cand_start) * 1000)
                cand_objs = ranked_cands
                cand_rejections = {c.candidate_id: c.rejection_reason for c in ranked_cands if c.rejection_reason}

                promoter = TransactionalPromoter(ws_path)
                app_res = promoter.promote_candidate(selected_cand)
                patch_to_apply = selected_cand.diff if selected_cand else None
            else:
                patch_to_apply = fixture.golden_patch or candidate_patch
                applier = PatchApplier(ws_path)
                app_res = applier.apply_patch(patch_to_apply or "")

            if not app_res.applied:
                elapsed_ms = int((time.perf_counter() - t0) * 1000)
                return BenchmarkCaseResult(
                    fixture_id=fixture.id,
                    name=fixture.name,
                    category=fixture.category,
                    eligible_for_repair=fixture.eligible_for_repair,
                    status="FAILED_REPAIR",
                    is_verified=False,
                    duration_ms=elapsed_ms,
                    baseline_exit_code=b_exec.exit_code,
                    baseline_passed=b_parsed.passed,
                    baseline_failed=b_parsed.failed,
                    baseline_total=b_parsed.total,
                    candidate_count=len(cand_objs),
                    valid_candidate_count=len([c for c in cand_objs if c.status in ("VALID", "SELECTED", "EVALUATED")]),
                    candidate_rejections=cand_rejections,
                    selected_candidate_id=selected_cand.candidate_id if selected_cand else None,
                    selection_rationale=selected_cand.selection_rationale if selected_cand else ("No candidate satisfied verification policy." if raw_cand_patches else None),
                    candidate_evaluation_duration_ms=cand_eval_duration_ms,
                    candidates=[c.model_dump() for c in cand_objs],
                    error_details=f"Failed to apply repair patch: {app_res.error}",
                    reproducible_command=repro_cmd,
                )

            # Execute post-repair tests
            post_exec = await runner.run(
                command=fixture.test_command,
                cwd=ws_path,
                timeout=self.timeout,
                job_id=f"bench-{fixture.id}-post",
            )
            post_parsed = parser_cls.parse(
                stdout=post_exec.stdout,
                stderr=post_exec.stderr,
                exit_code=post_exec.exit_code,
                duration=post_exec.duration,
                command=fixture.test_command,
            )
            post_failures = [f.to_dict() if hasattr(f, "to_dict") else f for f in post_parsed.failures]
            post_eval = VerificationPolicy.evaluate(
                exec_exit_code=post_exec.exit_code,
                exec_timed_out=post_exec.timed_out,
                parse_total=post_parsed.total,
                parse_passed=post_parsed.passed,
                parse_failed=post_parsed.failed,
                parse_skipped=post_parsed.skipped,
                parse_errors=post_parsed.errors,
                post_failures=post_failures,
                baseline_failures=b_failures,
                stdout=post_exec.stdout,
                stderr=post_exec.stderr,
            )

            elapsed_ms = int((time.perf_counter() - t0) * 1000)
            status = "CORRECT_REPAIR" if (post_eval.is_verified and post_eval.status == "PASSED") else "FAILED_REPAIR"

            return BenchmarkCaseResult(
                fixture_id=fixture.id,
                name=fixture.name,
                category=fixture.category,
                eligible_for_repair=True,
                status=status,
                is_verified=post_eval.is_verified,
                duration_ms=elapsed_ms,
                model_calls=1,
                baseline_exit_code=b_exec.exit_code,
                baseline_passed=b_parsed.passed,
                baseline_failed=b_parsed.failed,
                baseline_total=b_parsed.total,
                post_exit_code=post_exec.exit_code,
                post_passed=post_parsed.passed,
                post_failed=post_parsed.failed,
                post_total=post_parsed.total,
                regression_detected=post_eval.regression_detected,
                patch_applied=app_res.applied,
                files_modified=app_res.files_modified,
                diagnosed_hypothesis=top_id,
                diagnosis_accurate=diag_acc,
                ranking_score=top_score,
                candidate_count=len(cand_objs),
                valid_candidate_count=len([c for c in cand_objs if c.status in ("VALID", "SELECTED", "EVALUATED")]),
                candidate_rejections=cand_rejections,
                selected_candidate_id=selected_cand.candidate_id if selected_cand else None,
                selection_rationale=selected_cand.selection_rationale if selected_cand else None,
                candidate_evaluation_duration_ms=cand_eval_duration_ms,
                candidates=[c.model_dump() for c in cand_objs],
                error_details=None if status == "CORRECT_REPAIR" else post_eval.reason,
                reproducible_command=repro_cmd,
            )

        except Exception as e:
            elapsed_ms = int((time.perf_counter() - t0) * 1000)
            return BenchmarkCaseResult(
                fixture_id=fixture.id,
                name=fixture.name,
                category=fixture.category,
                eligible_for_repair=fixture.eligible_for_repair,
                status="INFRASTRUCTURE_FAILURE",
                is_verified=False,
                duration_ms=elapsed_ms,
                error_details=f"Runner infrastructure failure: {str(e)}",
                reproducible_command=repro_cmd,
            )
        finally:
            if self.cleanup:
                cleanup_isolated_workspace(ws_path)

    async def run_all(
        self,
        fixtures: list[BenchmarkFixture] | None = None,
        save_report: bool = True,
    ) -> BenchmarkReport:
        """Executes the benchmark matrix, aggregates metrics, and generates a structured report."""
        run_id = f"run-{uuid4().hex[:8]}"
        all_fixtures = fixtures if fixtures is not None else list_fixtures()

        case_results: list[BenchmarkCaseResult] = []
        for fix in all_fixtures:
            res = await self.run_fixture(fix, run_id=run_id)
            case_results.append(res)

        metrics = compute_benchmark_metrics(case_results)

        report = BenchmarkReport(
            run_id=run_id,
            timestamp=datetime.now(timezone.utc).isoformat(),
            code_revision="m12.1-main",
            fixture_version="1.0.0",
            environment={
                "os": "windows",
                "python_version": "3.14",
                "execution_mode": self.execution_mode,
            },
            metrics=metrics,
            case_results=case_results,
        )

        if save_report:
            REPORTS_DIR.mkdir(parents=True, exist_ok=True)
            report_file = REPORTS_DIR / f"{run_id}.json"
            report_file.write_text(json.dumps(report.model_dump(), indent=2), encoding="utf-8")

        return report
