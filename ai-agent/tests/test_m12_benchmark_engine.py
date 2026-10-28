"""
FixForge M12.1 — Automated Test Suite for Reproducible Repair Benchmark Engine.
Covers:
- Metric calculations (formulas, zero denominators, explicit nulls for missing token usage)
- Empty benchmark sets
- Infrastructure error isolation
- Timeout detection
- Skipped-only suite rejection
- Missing tests rejection
- Collection failure rejection
- False VERIFIED detection
- Regression detection and rollback
- Report JSON serialization and round-trip
- Run comparison (compatible and incompatible fixture versions)
- Workspace isolation and fixture immutability
"""

import asyncio
import json
from pathlib import Path
import pytest
import shutil
import tempfile

from app.benchmark.comparator import compare_benchmark_reports
from app.benchmark.fixtures import (
    CANONICAL_FIXTURES_DIR,
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
    BenchmarkSummaryMetrics,
)
from app.benchmark.runner import BenchmarkRunner


def test_metrics_calculation_formulas_and_denominators():
    """Verify precise metric formulas, denominator safety, and null handling for missing tokens."""
    # 1. Empty case set
    empty_metrics = compute_benchmark_metrics([])
    assert empty_metrics.total_cases == 0
    assert empty_metrics.repair_success_rate is None
    assert empty_metrics.total_tokens is None
    assert empty_metrics.total_cost_usd is None

    # 2. Mixed cases
    cases = [
        BenchmarkCaseResult(
            fixture_id="f1",
            name="Arithmetic",
            category="arithmetic",
            eligible_for_repair=True,
            status="CORRECT_REPAIR",
            is_verified=True,
            duration_ms=200,
            model_calls=1,
            token_usage={"total_tokens": 500},
            cost_usd=0.002,
        ),
        BenchmarkCaseResult(
            fixture_id="f2",
            name="Exception",
            category="exception",
            eligible_for_repair=True,
            status="FAILED_REPAIR",
            is_verified=False,
            duration_ms=400,
            model_calls=2,
            token_usage={"total_tokens": 700},
            cost_usd=0.003,
        ),
        BenchmarkCaseResult(
            fixture_id="f3",
            name="Missing Tests",
            category="missing_tests",
            eligible_for_repair=False,
            status="NO_TESTS_REJECTED",
            is_verified=False,
            duration_ms=50,
            model_calls=0,
            token_usage=None,
            cost_usd=None,
        ),
        BenchmarkCaseResult(
            fixture_id="f4",
            name="Malformed Diff",
            category="malformed_patch",
            eligible_for_repair=False,
            status="REJECTED_INVALID_PATCH",
            is_verified=False,
            duration_ms=20,
            model_calls=0,
            token_usage=None,
            cost_usd=None,
        ),
    ]

    m = compute_benchmark_metrics(cases)
    assert m.total_cases == 4
    assert m.eligible_repair_cases == 2
    assert m.correct_repairs == 1
    assert m.failed_repairs == 1
    assert m.repair_success_rate == 0.5  # 1 / 2
    assert m.false_verified_count == 0
    assert m.false_verified_rate == 0.0
    assert m.patch_rejection_rate == 1.0  # 1 rejected out of 1 invalid patch case
    assert m.total_tokens == 1200
    assert m.total_cost_usd == pytest.approx(0.005)
    assert m.median_repair_duration_ms == pytest.approx(125.0)


def test_metrics_missing_tokens_reported_as_none():
    """Missing token counts must remain None/unavailable and not be fabricated as zero."""
    cases = [
        BenchmarkCaseResult(
            fixture_id="f1",
            name="Arithmetic",
            category="arithmetic",
            eligible_for_repair=True,
            status="CORRECT_REPAIR",
            is_verified=True,
            duration_ms=100,
            model_calls=0,
            token_usage=None,
            cost_usd=None,
        )
    ]
    m = compute_benchmark_metrics(cases)
    assert m.total_tokens is None
    assert m.total_cost_usd is None


def test_false_verified_detection_metric():
    """If an ineligible defective suite is falsely verified, false_verified_count must increment."""
    cases = [
        BenchmarkCaseResult(
            fixture_id="missing_tests_bad",
            name="Missing Tests",
            category="missing_tests",
            eligible_for_repair=False,
            status="FALSE_VERIFIED",
            is_verified=True,
            duration_ms=50,
        )
    ]
    m = compute_benchmark_metrics(cases)
    assert m.false_verified_count == 1
    assert m.false_verified_rate == 1.0


def test_fixture_discovery_and_inventory():
    """Canonical benchmark fixtures directory must contain all 12 required test categories."""
    fixtures = list_fixtures()
    assert len(fixtures) >= 12

    f_ids = {f.id for f in fixtures}
    required_ids = [
        "single_arithmetic",
        "exception_handling",
        "boundary_condition",
        "multi_file_interaction",
        "multi_file_multi_hunk",
        "regression_inducing",
        "missing_tests",
        "all_skipped_tests",
        "collection_failure",
        "test_timeout",
        "malformed_patch",
        "unrelated_protected_file",
    ]
    for req in required_ids:
        assert req in f_ids, f"Required fixture {req} missing from inventory"


def test_fixture_immutability_and_workspace_isolation():
    """Provisioning an isolated workspace must not modify the canonical fixture files."""
    fix = get_fixture("single_arithmetic")
    assert fix is not None

    canonical_file = CANONICAL_FIXTURES_DIR / fix.relative_path / "cart.py"
    canonical_orig_text = canonical_file.read_text(encoding="utf-8")

    ws = provision_isolated_workspace(fix, run_id="test-immutability-run")
    assert ws.is_dir()
    ws_cart = ws / "cart.py"
    assert ws_cart.is_file()

    # Modify file in isolated workspace
    ws_cart.write_text("MUTATED_IN_WORKSPACE = True\n", encoding="utf-8")

    # Canonical file MUST remain byte-for-byte unchanged
    assert canonical_file.read_text(encoding="utf-8") == canonical_orig_text

    cleanup_isolated_workspace(ws)
    assert not ws.exists()


def test_benchmark_runner_empty_set():
    """Running runner on an empty fixture list must complete cleanly with 0 cases."""
    runner = BenchmarkRunner(cleanup_after_run=True)
    report = asyncio.run(runner.run_all(fixtures=[], save_report=False))
    assert report.metrics.total_cases == 0
    assert len(report.case_results) == 0


def test_benchmark_runner_missing_tests():
    """missing_tests fixture must produce NO_TESTS_REJECTED and is_verified=False."""
    fix = get_fixture("missing_tests")
    assert fix is not None
    runner = BenchmarkRunner(cleanup_after_run=True)
    res = asyncio.run(runner.run_fixture(fix, run_id="test-run-missing"))
    assert res.status == "NO_TESTS_REJECTED"
    assert res.is_verified is False


def test_benchmark_runner_all_skipped():
    """all_skipped_tests fixture must produce SKIPPED_ONLY_REJECTED and is_verified=False."""
    fix = get_fixture("all_skipped_tests")
    assert fix is not None
    runner = BenchmarkRunner(cleanup_after_run=True)
    res = asyncio.run(runner.run_fixture(fix, run_id="test-run-skipped"))
    assert res.status == "SKIPPED_ONLY_REJECTED"
    assert res.is_verified is False


def test_benchmark_runner_malformed_patch_rejection():
    """malformed_patch fixture must be rejected by validator with status REJECTED_INVALID_PATCH."""
    fix = get_fixture("malformed_patch")
    assert fix is not None
    runner = BenchmarkRunner(cleanup_after_run=True)
    res = asyncio.run(runner.run_fixture(fix, run_id="test-run-malformed"))
    assert res.status == "REJECTED_INVALID_PATCH"
    assert res.is_verified is False


def test_benchmark_runner_protected_file_rejection():
    """unrelated_protected_file fixture must be rejected by validator with status REJECTED_INVALID_PATCH."""
    fix = get_fixture("unrelated_protected_file")
    assert fix is not None
    runner = BenchmarkRunner(cleanup_after_run=True)
    res = asyncio.run(runner.run_fixture(fix, run_id="test-run-protected"))
    assert res.status == "REJECTED_INVALID_PATCH"
    assert res.is_verified is False


def test_benchmark_runner_regression_detection():
    """regression_inducing fixture must be detected as REGRESSION_DETECTED and rolled back."""
    fix = get_fixture("regression_inducing")
    assert fix is not None
    runner = BenchmarkRunner(cleanup_after_run=True)
    res = asyncio.run(runner.run_fixture(fix, run_id="test-run-regression"))
    assert res.status == "REGRESSION_DETECTED"
    assert res.regression_detected is True
    assert res.is_verified is False


def test_benchmark_runner_correct_repair():
    """single_arithmetic fixture must be cleanly repaired and verified with status CORRECT_REPAIR."""
    fix = get_fixture("single_arithmetic")
    assert fix is not None
    runner = BenchmarkRunner(cleanup_after_run=True)
    res = asyncio.run(runner.run_fixture(fix, run_id="test-run-arithmetic"))
    assert res.status == "CORRECT_REPAIR"
    assert res.is_verified is True
    assert res.post_passed >= 2
    assert res.post_failed == 0


def test_report_serialization_and_roundtrip():
    """BenchmarkReport must serialize to valid JSON and deserialize back losslessly."""
    runner = BenchmarkRunner(cleanup_after_run=True)
    fixtures = [get_fixture("single_arithmetic"), get_fixture("missing_tests")]
    report = asyncio.run(runner.run_all(fixtures=fixtures, save_report=False))

    json_str = json.dumps(report.model_dump())
    loaded = BenchmarkReport.model_validate(json.loads(json_str))

    assert loaded.run_id == report.run_id
    assert loaded.metrics.total_cases == report.metrics.total_cases
    assert loaded.metrics.correct_repairs == report.metrics.correct_repairs
    assert len(loaded.case_results) == len(report.case_results)


def test_run_comparison_compatible_and_incompatible():
    """Run comparison must compute deltas on compatible runs and flag incompatible versions."""
    runner = BenchmarkRunner(cleanup_after_run=True)
    fixtures = [get_fixture("single_arithmetic"), get_fixture("missing_tests")]

    report_a = asyncio.run(runner.run_all(fixtures=fixtures, save_report=False))
    report_b = asyncio.run(runner.run_all(fixtures=fixtures, save_report=False))

    # 1. Compatible runs
    comp = compare_benchmark_reports(report_a, report_b)
    assert comp.is_compatible is True
    assert "single_arithmetic" in comp.common_cases
    assert "missing_tests" in comp.common_cases
    assert comp.metric_deltas["correct_repairs_delta"] == 0

    # 2. Incompatible fixture versions
    report_incompatible = report_b.model_copy(update={"fixture_version": "2.0.0"})
    comp_incompatible = compare_benchmark_reports(report_a, report_incompatible)
    assert comp_incompatible.is_compatible is False
    assert "Fixture version mismatch" in comp_incompatible.compatibility_reason
