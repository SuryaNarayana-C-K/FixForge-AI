"""
FixForge M12.6 — Benchmark Reliability & Repair Accuracy Automated Test Suite.
Validates:
1. Audit of historical live run reports (one authoritative outcome, accurate model calls, explicit denominators,
   evidence-based regression classification, evidence-based false-VERIFIED detection, invalid baseline exclusion).
2. Expanded benchmark coverage across Python and JavaScript (boundary conditions, exceptions, arithmetic,
   multi-file changes, regression-inducing repairs).
3. Held-out test isolation (independent test suite kept strictly separate from agent repair workspace).
4. JavaScript test parsing & context selection (NodeTestOutputParser file extraction, relative imports, file URLs).
5. Metric formula consistency (explicit denominators, eligible case scopes).
6. Run comparison engine (execution mode separation, model compatibility, status progression tracking).
"""

import asyncio
import json
from pathlib import Path
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
from app.context.context_selector import ContextSelector
from app.parser import NodeTestOutputParser

WORKSPACE_ROOT = Path(__file__).resolve().parent.parent.parent


def test_audit_live_run_report():
    """Audit live-6c526d97.json against all M12.6 audit criteria."""
    report_path = WORKSPACE_ROOT / "benchmarks" / "reports" / "live-6c526d97.json"
    assert report_path.is_file(), "Report live-6c526d97.json must exist in benchmarks/reports"

    data = json.loads(report_path.read_text(encoding="utf-8"))
    report = BenchmarkReport.model_validate(data)

    # 1. Each fixture has one authoritative outcome
    fixture_ids = [c.fixture_id for c in report.case_results]
    assert len(fixture_ids) == len(set(fixture_ids)), "Every fixture must have a unique authoritative outcome"
    assert len(fixture_ids) == 6

    # 2. Live model calls and execution mode are recorded accurately
    assert report.execution_mode == "live_repair"
    assert report.model == "gemini-2.0-flash"
    for c in report.case_results:
        assert c.execution_mode == "live_repair"
        if c.status == "REPAIRED":
            assert c.model_calls > 0, "Repaired cases in live mode must record genuine model calls"

    # 3. Denominators: invalid cases excluded from repair-success calculations
    m = report.metrics
    assert m.total_cases == 6
    assert m.invalid_cases_count == 1
    # Eligible completed cases must strictly exclude invalid cases and infra errors
    assert m.eligible_completed_cases == 3  # live_js_stats, live_py_discount, live_py_user_service
    assert m.repair_success_rate == 2 / 3
    assert m.correct_repairs == 2

    # 4. live_py_regression_inducing is classified from actual test evidence
    reg_case = next(c for c in report.case_results if c.fixture_id == "live_py_regression_inducing")
    assert reg_case.status == "REGRESSION"
    assert reg_case.regression_detected is True
    assert reg_case.baseline_failed == 1
    assert reg_case.post_failed == 2  # 1 new failure introduced
    assert "Regression detected" in (reg_case.error_details or "")

    # 5. False-VERIFIED count is computed from evidence, not forced to zero
    assert m.false_verified_count == 0
    # Re-evaluating metrics from case results yields identical evidence-backed calculation
    computed = compute_benchmark_metrics(report.case_results)
    assert computed.false_verified_count == 0


def test_expanded_benchmark_suite_coverage():
    """Verify all 11 live benchmark cases are registered and cover required categories and languages."""
    cases = list_live_cases()
    assert len(cases) >= 11, f"Expected at least 11 live cases, got {len(cases)}"

    case_ids = {c.id for c in cases}
    expected_ids = {
        "live_js_cart_boundary",
        "live_js_regression_inducing",
        "live_js_stats",
        "live_js_token_exception",
        "live_py_abstain",
        "live_py_discount",
        "live_py_order_multi",
        "live_py_payroll_calc",
        "live_py_precondition_invalid",
        "live_py_regression_inducing",
        "live_py_user_service",
    }
    assert expected_ids.issubset(case_ids)

    # Language distribution
    py_cases = [c for c in cases if c.language == "python"]
    js_cases = [c for c in cases if c.language == "javascript"]
    assert len(py_cases) >= 7
    assert len(js_cases) >= 4

    # Category coverage
    categories = {c.category for c in cases}
    assert "boundary" in categories
    assert "exception" in categories
    assert "arithmetic" in categories
    assert "multi_file" in categories
    assert "regression_inducing" in categories
    assert "insufficient_evidence" in categories
    assert "invalid_case" in categories


def test_multi_file_benchmark_case_integrity():
    """Verify live_py_order_multi declares and exercises multiple files."""
    case = get_live_case("live_py_order_multi")
    assert case is not None
    assert case.category == "multi_file"
    assert len(case.manifest.get("files", [])) >= 2
    assert "models/order.py" in case.manifest["files"]
    assert "services/pricing_service.py" in case.manifest["files"]
    assert (case.case_dir / "models" / "order.py").is_file()
    assert (case.case_dir / "services" / "pricing_service.py").is_file()


def test_held_out_test_isolation_during_repair():
    """Verify held-out tests (independent_tests) are excluded from the agent workspace during repair."""
    case = get_live_case("live_py_discount")
    assert case is not None

    runner = LiveBenchmarkRunner(timeout_seconds=10.0, cleanup_after_run=False, execution_mode="dry_run")
    ws = runner._provision_isolated_workspace(case, run_id="test-isolation-check")

    try:
        # Agent workspace MUST NOT contain independent_tests before independent execution
        assert not (ws / "independent_tests").exists(), "Held-out tests must not be provisioned in the agent repair workspace"
        assert (ws / "pricing.py").is_file()
        assert (ws / "tests" / "test_pricing.py").is_file()
    finally:
        runner._safe_cleanup_workspace(ws)


def test_node_test_output_parser_extracts_locations():
    """Verify NodeTestOutputParser extracts accurate file names and line numbers from node --test output."""
    raw_node_output = """
✖ calculateVariance computes population variance (2.8219ms)
ℹ tests 3
ℹ pass 2
ℹ fail 1

✖ failing tests:

test at tests\\stats.test.mjs:5:1
✖ calculateVariance computes population variance (2.8219ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + 5.333333333333333
  - 4
      at TestContext.<anonymous> (file:///C:/Users/test/tests/stats.test.mjs:10:10)
"""
    parsed = NodeTestOutputParser.parse(
        stdout=raw_node_output,
        stderr="",
        exit_code=1,
        duration=0.2,
        command="node --test tests/stats.test.mjs",
    )

    assert parsed.total == 3
    assert parsed.passed == 2
    assert parsed.failed == 1
    assert len(parsed.failures) == 1
    f = parsed.failures[0]
    assert "stats.test.mjs" in f.file
    assert f.source_reference is not None
    assert "stats.test.mjs:5" in f.source_reference or "stats.test.mjs:10" in f.source_reference


def test_context_selector_resolves_js_imports():
    """Verify ContextSelector accurately resolves relative JavaScript imports like ../stats.mjs."""
    case = get_live_case("live_js_stats")
    assert case is not None

    selector = ContextSelector()
    failures = [
        {
            "test_name": "calculateVariance computes population variance",
            "file": "tests/stats.test.mjs",
            "traceback": 'at TestContext.<anonymous> (file:///C:/test/tests/stats.test.mjs:10:10)',
        }
    ]

    selected = selector.select_context(
        workspace_root=case.case_dir,
        failures=failures,
    )

    assert "tests/stats.test.mjs" in selected.file_contexts
    assert "stats.mjs" in selected.file_contexts
    assert selected.focal_source_files == ["stats.mjs"]


def test_metric_formulas_denominators_and_false_verified():
    """Verify metric calculations use strictly bounded denominators and evidence-based false-verified detection."""
    cases = [
        # 1. Repaired
        BenchmarkCaseResult(
            fixture_id="c1", name="C1", category="arithmetic",
            eligible_for_repair=True, status="REPAIRED", is_verified=True, duration_ms=1000
        ),
        # 2. Failed
        BenchmarkCaseResult(
            fixture_id="c2", name="C2", category="boundary",
            eligible_for_repair=True, status="FAILED", is_verified=False, duration_ms=1200
        ),
        # 3. Unintended abstention on eligible bug
        BenchmarkCaseResult(
            fixture_id="c3", name="C3", category="arithmetic",
            eligible_for_repair=True, status="ABSTAINED", is_verified=False, duration_ms=500,
            abstention_selected=True
        ),
        # 4. Correct intentional abstention on contradictory evidence
        BenchmarkCaseResult(
            fixture_id="c4", name="C4", category="insufficient_evidence",
            eligible_for_repair=False, status="ABSTAINED", is_verified=False, duration_ms=400,
            abstention_selected=True
        ),
        # 5. Invalid baseline case
        BenchmarkCaseResult(
            fixture_id="c5", name="C5", category="invalid_case",
            eligible_for_repair=False, status="INVALID_CASE", is_verified=False, duration_ms=100,
            baseline_precondition_satisfied=False
        ),
    ]

    m = compute_benchmark_metrics(cases)
    assert m.total_cases == 5
    assert m.eligible_repair_cases == 3  # c1, c2, c3
    assert m.eligible_completed_cases == 3  # c1, c2, c3 (c5 excluded)
    assert m.correct_repairs == 1
    assert m.repair_success_rate == 1 / 3
    # Abstention rate on eligible cases: 1 unintended abstention out of 3 eligible cases
    assert m.abstention_rate == 1 / 3
    # Abstention accuracy on intentional cases: 1 correct abstention out of 1 target case
    assert m.abstention_accuracy == 1.0
    assert m.false_verified_count == 0

    # Test false verified detection when is_verified is mistakenly set on failed/regression/test tampering case
    bad_case = BenchmarkCaseResult(
        fixture_id="c_bad", name="Bad", category="arithmetic",
        eligible_for_repair=True, status="FAILED", is_verified=True, duration_ms=500, post_failed=1
    )
    m_bad = compute_benchmark_metrics([bad_case])
    assert m_bad.false_verified_count == 1
    assert m_bad.false_verified_rate == 1.0


def test_compare_benchmark_reports_compatibility_and_deltas():
    """Verify run comparison enforces execution mode and model compatibility and tracks deltas."""
    base_case = BenchmarkCaseResult(
        fixture_id="c1", name="C1", category="arithmetic",
        eligible_for_repair=True, status="FAILED", is_verified=False, duration_ms=2000
    )
    target_case = BenchmarkCaseResult(
        fixture_id="c1", name="C1", category="arithmetic",
        eligible_for_repair=True, status="REPAIRED", is_verified=True, duration_ms=1500
    )

    base_report = BenchmarkReport(
        run_id="run-base", timestamp="2026-10-19T00:00:00Z", code_revision="m12.5",
        fixture_version="1.2.5", execution_mode="live_repair", model="gemini-2.0-flash",
        git_commit="abc", environment={}, metrics=compute_benchmark_metrics([base_case]),
        case_results=[base_case]
    )
    target_report = BenchmarkReport(
        run_id="run-target", timestamp="2026-10-19T01:00:00Z", code_revision="m12.6",
        fixture_version="1.2.5", execution_mode="live_repair", model="gemini-2.0-flash",
        git_commit="def", environment={}, metrics=compute_benchmark_metrics([target_case]),
        case_results=[target_case]
    )

    comp = compare_benchmark_reports(base_report, target_report)
    assert comp.is_compatible is True
    assert comp.metric_deltas["correct_repairs_delta"] == 1
    assert comp.metric_deltas["repair_success_rate_delta"] == 1.0
    assert len(comp.case_diffs) == 1
    assert comp.case_diffs[0]["improved"] is True
    assert comp.case_diffs[0]["regressed"] is False

    # Incompatible modes check
    offline_report = target_report.model_copy(update={"execution_mode": "offline_test"})
    comp_incompat = compare_benchmark_reports(base_report, offline_report)
    assert comp_incompat.is_compatible is False
    assert "Execution mode mismatch" in comp_incompat.compatibility_reason

    # Incompatible models check
    diff_model_report = target_report.model_copy(update={"model": "gemini-1.5-pro"})
    comp_model = compare_benchmark_reports(base_report, diff_model_report)
    assert comp_model.is_compatible is False
    assert "Model mismatch" in comp_model.compatibility_reason
