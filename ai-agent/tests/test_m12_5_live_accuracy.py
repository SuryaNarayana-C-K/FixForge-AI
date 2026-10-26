"""
FixForge M12.5 — Live Repair Accuracy Validation Automated Test Suite.
Tests live vs golden separation, baseline preconditions, explicit outcome classification,
independent test execution, test-file SHA-256 hash integrity, regression detection,
missing telemetry handling, reproducible report persistence, and false VERIFIED prevention.
"""

import asyncio
import json
from pathlib import Path
import tempfile
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.benchmark import (
    BenchmarkCaseResult,
    BenchmarkReport,
    BenchmarkSummaryMetrics,
    LiveBenchmarkCase,
    LiveBenchmarkRunner,
    compare_benchmark_reports,
    compute_benchmark_metrics,
    get_live_case,
    list_live_cases,
)
from app.benchmark.live_runner import compute_file_sha256
from app.patch.applier import PatchApplier
from app.runner import ExecutionResult


def test_live_vs_golden_separation():
    """Verify live repair and golden validation execution modes are strictly separated."""
    live_res = BenchmarkCaseResult(
        fixture_id="live-1",
        name="Live Case",
        category="arithmetic",
        eligible_for_repair=True,
        status="REPAIRED",
        is_verified=True,
        duration_ms=1200,
        execution_mode="live_repair",
        model_name="gemini-2.0-flash",
        model_calls=1,
    )
    golden_res = BenchmarkCaseResult(
        fixture_id="golden-1",
        name="Golden Case",
        category="arithmetic",
        eligible_for_repair=True,
        status="CORRECT_REPAIR",
        is_verified=True,
        duration_ms=300,
        execution_mode="golden_validation",
    )

    live_metrics = compute_benchmark_metrics([live_res])
    golden_metrics = compute_benchmark_metrics([golden_res])

    assert live_metrics.execution_mode == "live_repair"
    assert golden_metrics.execution_mode == "golden_validation"
    assert live_metrics.repair_success_rate == 1.0
    assert golden_metrics.repair_success_rate == 1.0


def test_baseline_precondition_failure_invalid_case():
    """Verify that when baseline tests unexpectedly pass, outcome is INVALID_CASE."""
    case = get_live_case("live_py_precondition_invalid")
    assert case is not None

    runner = LiveBenchmarkRunner(timeout_seconds=10.0, cleanup_after_run=True, execution_mode="dry_run")
    result = asyncio.run(runner.run_case(case, run_id="test-run-invalid"))

    assert result.status == "INVALID_CASE"
    assert result.baseline_precondition_satisfied is False
    assert result.is_verified is False
    assert "precondition" in (result.error_details or "").lower()

    metrics = compute_benchmark_metrics([result])
    assert metrics.invalid_cases_count == 1
    # Invalid cases must NOT be counted as successful repairs or eligible completed cases
    assert metrics.repair_success_rate is None
    assert metrics.eligible_completed_cases == 0


def test_correct_outcome_classification_matrix():
    """Verify all explicit M12.5 outcomes are correctly handled in metrics aggregation."""
    cases = [
        BenchmarkCaseResult(
            fixture_id="c1", name="Repaired Bug", category="arithmetic",
            eligible_for_repair=True, status="REPAIRED", is_verified=True, duration_ms=1000
        ),
        BenchmarkCaseResult(
            fixture_id="c2", name="Failed Repair", category="arithmetic",
            eligible_for_repair=True, status="FAILED", is_verified=False, duration_ms=1200
        ),
        BenchmarkCaseResult(
            fixture_id="c3", name="Regression Bug", category="arithmetic",
            eligible_for_repair=True, status="REGRESSION", is_verified=False, duration_ms=1100,
            regression_detected=True
        ),
        BenchmarkCaseResult(
            fixture_id="c4", name="Abstained Bug", category="insufficient_evidence",
            eligible_for_repair=False, status="ABSTAINED", is_verified=False, duration_ms=500,
            abstention_selected=True
        ),
        BenchmarkCaseResult(
            fixture_id="c5", name="Timed Out Bug", category="timeout",
            eligible_for_repair=True, status="TIMEOUT", is_verified=False, duration_ms=30000
        ),
        BenchmarkCaseResult(
            fixture_id="c6", name="Infra Error Bug", category="arithmetic",
            eligible_for_repair=True, status="INFRA_ERROR", is_verified=False, duration_ms=200,
            infra_error_details="Docker daemon unavailable"
        ),
        BenchmarkCaseResult(
            fixture_id="c7", name="Invalid Case Bug", category="invalid_case",
            eligible_for_repair=False, status="INVALID_CASE", is_verified=False, duration_ms=100,
            baseline_precondition_satisfied=False
        ),
    ]

    metrics = compute_benchmark_metrics(cases)

    assert metrics.total_cases == 7
    assert metrics.completed_cases == 6  # 7 - 1 infra error
    assert metrics.eligible_repair_cases == 5  # c1, c2, c3, c5, c6 = 5 eligible
    assert metrics.correct_repairs == 1
    # Eligible completed cases excludes infra error and invalid case
    assert metrics.eligible_completed_cases == 4  # c1, c2, c3, c5
    assert metrics.repair_success_rate == 0.25  # 1 / 4
    assert metrics.regressions_introduced == 1
    assert metrics.timeout_cases_count == 1
    assert metrics.infra_error_cases_count == 1
    assert metrics.invalid_cases_count == 1
    assert metrics.false_verified_count == 0


def test_regression_detection():
    """Verify that regressions against baseline assertions are caught and classified."""
    case = get_live_case("live_py_regression_inducing")
    assert case is not None

    runner = LiveBenchmarkRunner(timeout_seconds=15.0, cleanup_after_run=True, execution_mode="dry_run")
    result = asyncio.run(runner.run_case(case, run_id="test-run-reg"))

    assert result.status == "REGRESSION"
    assert result.regression_detected is True
    assert result.is_verified is False
    assert result.regression_details is not None

    metrics = compute_benchmark_metrics([result])
    assert metrics.regressions_introduced == 1
    assert metrics.regression_rate > 0


def test_independent_test_execution_and_failure():
    """Verify that independent held-out tests verify generalization and fail when fix is incomplete."""
    case = get_live_case("live_py_discount")
    assert case is not None

    runner = LiveBenchmarkRunner(timeout_seconds=20.0, cleanup_after_run=True, execution_mode="dry_run")
    result = asyncio.run(runner.run_case(case, run_id="test-run-indep"))

    assert result.status == "REPAIRED"
    assert result.independent_tests_passed is True
    assert result.is_verified is True


def test_test_file_hash_integrity_violation():
    """Verify that tampering with or modifying protected test files triggers VIOLATION."""
    case = get_live_case("live_py_discount")
    assert case is not None

    runner = LiveBenchmarkRunner(timeout_seconds=15.0, cleanup_after_run=True, execution_mode="dry_run")

    original_apply = PatchApplier.apply_patch

    def tampered_apply(self, patch):
        test_file = self.workspace_root / "tests" / "test_pricing.py"
        if test_file.exists():
            test_file.write_text(test_file.read_text(encoding="utf-8") + "\n# Tampered by agent\n", encoding="utf-8")
        return original_apply(self, patch)

    with patch.object(PatchApplier, "apply_patch", tampered_apply):
        result = asyncio.run(runner.run_case(case, run_id="test-tamper"))
        assert result.test_integrity_violation is True
        assert result.is_verified is False
        assert result.status == "FAILED"
        assert "Test integrity violation" in (result.error_details or "")


def test_missing_model_telemetry_reported_as_null():
    """Verify that missing model telemetry is reported as None (null), never fabricated as 0."""
    result = BenchmarkCaseResult(
        fixture_id="live-telemetry",
        name="Telemetry Case",
        category="boundary",
        eligible_for_repair=True,
        status="REPAIRED",
        is_verified=True,
        duration_ms=800,
        model_calls=0,
        token_usage=None,  # Not provided
        cost_usd=None,     # Not provided
    )

    metrics = compute_benchmark_metrics([result])
    assert metrics.total_tokens is None
    assert metrics.total_cost_usd is None

    # Serialized dump should contain null, not 0
    dumped = json.loads(metrics.model_dump_json())
    assert dumped["total_tokens"] is None
    assert dumped["total_cost_usd"] is None


def test_reproducible_report_serialization():
    """Verify benchmark report contains all required reproducibility metadata and no secrets."""
    runner = LiveBenchmarkRunner(timeout_seconds=10.0, cleanup_after_run=True, execution_mode="dry_run")
    report = asyncio.run(runner.run_all(cases=[get_live_case("live_py_discount")], save_report=False))

    assert report.run_id.startswith("live-")
    assert report.execution_mode == "dry_run"
    assert report.git_commit is not None
    assert report.fixture_version == "1.2.5"
    assert len(report.case_results) == 1

    report_json = report.model_dump_json()
    assert "AIzaSy" not in report_json
    assert "Bearer" not in report_json
    assert "GEMINI_API_KEY" not in report_json


def test_benchmark_comparison_compatibility_warning():
    """Verify that comparing live_repair against golden_validation flags compatibility mismatch."""
    report_live = BenchmarkReport(
        run_id="live-run-101",
        execution_mode="live_repair",
        metrics=BenchmarkSummaryMetrics(execution_mode="live_repair", total_cases=5, correct_repairs=4),
        case_results=[
            BenchmarkCaseResult(fixture_id="c1", name="C1", category="arithmetic", eligible_for_repair=True, status="REPAIRED", is_verified=True, duration_ms=1000)
        ]
    )
    report_golden = BenchmarkReport(
        run_id="golden-run-102",
        execution_mode="golden_validation",
        metrics=BenchmarkSummaryMetrics(execution_mode="golden_validation", total_cases=5, correct_repairs=5),
        case_results=[
            BenchmarkCaseResult(fixture_id="c1", name="C1", category="arithmetic", eligible_for_repair=True, status="CORRECT_REPAIR", is_verified=True, duration_ms=200)
        ]
    )

    comparison = compare_benchmark_reports(report_live, report_golden)
    assert comparison.is_compatible is False
    assert "Execution mode mismatch" in comparison.compatibility_reason


def test_prevention_of_false_verified():
    """Verify that defective cases (regressions, failing assertions, test tampering) are never VERIFIED."""
    defective_cases = [
        # Regression marked verified
        BenchmarkCaseResult(
            fixture_id="c_reg", name="Reg", category="arithmetic", eligible_for_repair=True,
            status="REPAIRED", is_verified=True, regression_detected=True, duration_ms=500
        ),
        # Test integrity violation marked verified
        BenchmarkCaseResult(
            fixture_id="c_tamper", name="Tamper", category="arithmetic", eligible_for_repair=True,
            status="REPAIRED", is_verified=True, test_integrity_violation=True, duration_ms=500
        ),
        # Ineligible case marked verified
        BenchmarkCaseResult(
            fixture_id="c_ineligible", name="Ineligible", category="missing_tests", eligible_for_repair=False,
            status="REPAIRED", is_verified=True, duration_ms=500
        ),
        # Failing assertions marked verified
        BenchmarkCaseResult(
            fixture_id="c_failed", name="Failed", category="arithmetic", eligible_for_repair=True,
            status="FAILED", is_verified=True, post_failed=1, duration_ms=500
        ),
    ]

    metrics = compute_benchmark_metrics(defective_cases)
    # All 4 must be flagged as false verified!
    assert metrics.false_verified_count == 4
    assert metrics.false_verified_rate == 1.0


def test_javascript_live_case_execution():
    """Verify JavaScript live case runs cleanly using Node.js native test runner."""
    case = get_live_case("live_js_stats")
    assert case is not None
    assert case.language == "javascript"

    runner = LiveBenchmarkRunner(timeout_seconds=15.0, cleanup_after_run=True, execution_mode="dry_run")
    result = asyncio.run(runner.run_case(case, run_id="test-run-js"))

    assert result.status == "REPAIRED"
    assert result.independent_tests_passed is True
    assert result.is_verified is True
    assert result.test_integrity_violation is False


def test_benchmark_workspace_provisioning_inside_dedicated_root():
    """Verify benchmark workspaces are provisioned strictly inside the dedicated .benchmark_workspaces directory."""
    from app.benchmark.live_runner import BENCHMARK_WORKSPACES_ROOT, WORKSPACE_ROOT
    from app.workspace import WorkspaceManager

    case = get_live_case("live_py_discount")
    assert case is not None

    runner = LiveBenchmarkRunner(cleanup_after_run=False, execution_mode="dry_run")
    run_id = "test-ws-isolation-check"
    ws_path = runner._provision_isolated_workspace(case, run_id=run_id)

    try:
        assert ws_path.exists()
        assert ws_path.is_dir()

        # Must resolve inside BENCHMARK_WORKSPACES_ROOT
        bench_root = BENCHMARK_WORKSPACES_ROOT.resolve()
        project_root = WORKSPACE_ROOT.resolve()
        assert ws_path.is_relative_to(bench_root)
        assert ws_path.is_relative_to(project_root)
        assert ws_path != bench_root
        assert ws_path != project_root

        # WorkspaceManager must accept this workspace without traversal errors
        wm = WorkspaceManager()
        resolved_ws = wm.resolve_repository_path(str(ws_path))
        assert resolved_ws == ws_path
    finally:
        runner._safe_cleanup_workspace(ws_path)
        assert not ws_path.exists()


def test_benchmark_workspace_traversal_rejection():
    """Verify that path traversal attempts in run_id or case_id are rejected."""
    from app.workspace import WorkspaceSecurityError

    case = get_live_case("live_py_discount")
    assert case is not None

    runner = LiveBenchmarkRunner(cleanup_after_run=False, execution_mode="dry_run")

    # Traversal in run_id
    with pytest.raises(WorkspaceSecurityError, match="Path traversal detected"):
        runner._provision_isolated_workspace(case, run_id="../../escaped_run")

    with pytest.raises(WorkspaceSecurityError, match="Path traversal detected"):
        runner._provision_isolated_workspace(case, run_id=r"..\..\escaped_run")


def test_benchmark_workspace_cleanup_safety_never_deletes_roots():
    """Verify cleanup only removes specific temporary case workspaces, never project root or parents."""
    from app.benchmark.live_runner import BENCHMARK_WORKSPACES_ROOT, WORKSPACE_ROOT

    runner = LiveBenchmarkRunner()

    # Attempt cleanup on project root
    runner._safe_cleanup_workspace(WORKSPACE_ROOT)
    assert WORKSPACE_ROOT.exists()

    # Attempt cleanup on benchmark root
    runner._safe_cleanup_workspace(BENCHMARK_WORKSPACES_ROOT)
    assert BENCHMARK_WORKSPACES_ROOT.exists()

    # Attempt cleanup on an outside directory
    outside_dir = WORKSPACE_ROOT.parent
    runner._safe_cleanup_workspace(outside_dir)
    assert outside_dir.exists()


def test_deduplicate_case_results_preserves_single_authoritative_outcome_and_attempts():
    """Verify that multiple retry records for the same fixture ID collapse into one authoritative outcome."""
    from app.benchmark.metrics import deduplicate_case_results

    attempt1 = BenchmarkCaseResult(
        fixture_id="live_py_regression_inducing",
        name="Regression Bug",
        category="regression_inducing",
        eligible_for_repair=False,
        status="INFRA_ERROR",
        is_verified=False,
        duration_ms=1200,
        infra_error_details="Temporary infrastructure timeout during provisioning",
    )
    attempt2 = BenchmarkCaseResult(
        fixture_id="live_py_regression_inducing",
        name="Regression Bug",
        category="regression_inducing",
        eligible_for_repair=False,
        status="REGRESSION",
        is_verified=False,
        duration_ms=2500,
        regression_detected=True,
        error_details="Patch introduced regressions: test_base_preserved failed",
    )

    deduped = deduplicate_case_results([attempt1, attempt2])
    assert len(deduped) == 1
    authoritative = deduped[0]
    assert authoritative.status == "REGRESSION"
    assert authoritative.regression_detected is True
    # The previous attempt must be preserved in attempts history
    assert len(authoritative.attempts) == 1
    assert authoritative.attempts[0]["status"] == "INFRA_ERROR"

    metrics = compute_benchmark_metrics([attempt1, attempt2])
    assert metrics.total_cases == 1
    assert metrics.regressions_introduced == 1
    assert metrics.infra_error_cases_count == 0


def test_live_repair_requires_model_calls_for_repair_accuracy():
    """Verify that zero-model-call executions in live_repair mode never count toward live AI repair accuracy."""
    zero_call_case = BenchmarkCaseResult(
        fixture_id="live_py_discount",
        name="Discount",
        category="boundary",
        eligible_for_repair=True,
        status="REPAIRED",
        is_verified=True,
        duration_ms=1000,
        execution_mode="live_repair",
        model_calls=0,  # Faked or mocked with zero calls
    )

    metrics = compute_benchmark_metrics([zero_call_case])
    # Must NOT count as a correct repair because no model was called
    assert metrics.correct_repairs == 0
    assert metrics.repair_success_rate == 0.0
    # Must be caught as false verified
    assert metrics.false_verified_count == 1


def test_regression_inducing_fixture_evaluated_via_test_evidence():
    """Verify regression_inducing fixture evaluates candidate patch and detects REGRESSION from real test evidence."""
    case = get_live_case("live_py_regression_inducing")
    assert case is not None

    runner = LiveBenchmarkRunner(timeout_seconds=15.0, cleanup_after_run=True, execution_mode="live_repair")
    result = asyncio.run(runner.run_case(case, run_id="test-run-reg-live"))

    assert result.status == "REGRESSION"
    assert result.regression_detected is True
    assert result.is_verified is False
    assert result.post_failed >= 1  # test_base_preserved failed
    assert "Regression detected" in (result.error_details or "")

    metrics = compute_benchmark_metrics([result])
    assert metrics.regressions_introduced == 1
    assert metrics.false_verified_count == 0


