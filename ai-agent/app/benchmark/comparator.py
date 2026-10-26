"""
FixForge M12.1 — Benchmark Comparison Engine.
Compares two benchmark runs, verifies fixture version compatibility,
calculates metric deltas, and identifies case status progressions/regressions.
"""

from typing import Any
from app.benchmark.models import BenchmarkComparison, BenchmarkReport


def compare_benchmark_reports(base_report: BenchmarkReport, target_report: BenchmarkReport) -> BenchmarkComparison:
    """
    Compares a baseline benchmark report against a target benchmark report.
    Guarantees incompatible fixture sets/versions are not mixed.
    """
    base_cases = {c.fixture_id: c for c in base_report.case_results}
    target_cases = {c.fixture_id: c for c in target_report.case_results}

    # Compatibility check
    is_compatible = True
    compatibility_reason = "Compatible benchmark runs."

    base_mode = getattr(base_report, "execution_mode", None) or base_report.metrics.execution_mode
    target_mode = getattr(target_report, "execution_mode", None) or target_report.metrics.execution_mode
    if base_mode != target_mode:
        is_compatible = False
        compatibility_reason = (
            f"Execution mode mismatch: base is '{base_mode}' while target is '{target_mode}'. "
            f"Comparing live repair runs against golden-validation or offline runs is non-comparable."
        )

    if base_report.fixture_version != target_report.fixture_version:
        is_compatible = False
        compatibility_reason = (
            f"Fixture version mismatch: base={base_report.fixture_version}, "
            f"target={target_report.fixture_version}"
        )

    base_model = getattr(base_report, "model", None)
    target_model = getattr(target_report, "model", None)
    if base_mode == "live_repair" and target_mode == "live_repair" and base_model and target_model and base_model != target_model:
        is_compatible = False
        compatibility_reason = (
            f"Model mismatch: base run used '{base_model}' while target run used '{target_model}'. "
            f"Live AI benchmark accuracy comparisons require compatible model configurations."
        )

    common_ids = sorted(list(set(base_cases.keys()) & set(target_cases.keys())))
    if not common_ids:
        is_compatible = False
        compatibility_reason = "No overlapping benchmark fixtures between runs."

    # Compute metric deltas
    bm = base_report.metrics
    tm = target_report.metrics

    def _delta(target_val: float | None, base_val: float | None) -> float | None:
        if target_val is not None and base_val is not None:
            return round(target_val - base_val, 4)
        return None

    metric_deltas = {
        "correct_repairs_delta": tm.correct_repairs - bm.correct_repairs,
        "failed_repairs_delta": tm.failed_repairs - bm.failed_repairs,
        "false_verified_count_delta": tm.false_verified_count - bm.false_verified_count,
        "repair_success_rate_delta": _delta(tm.repair_success_rate, bm.repair_success_rate),
        "false_verified_rate_delta": _delta(tm.false_verified_rate, bm.false_verified_rate),
        "regression_rate_delta": _delta(tm.regression_rate, bm.regression_rate),
        "abstention_rate_delta": _delta(tm.abstention_rate, bm.abstention_rate),
        "timeout_rate_delta": _delta(tm.timeout_rate, bm.timeout_rate),
        "infra_error_rate_delta": _delta(tm.infra_error_rate, bm.infra_error_rate),
        "test_integrity_violations_delta": tm.test_integrity_violations - bm.test_integrity_violations,
        "median_duration_ms_delta": _delta(tm.median_repair_duration_ms, bm.median_repair_duration_ms),
    }

    # Case level differences
    case_diffs = []
    for fid in common_ids:
        bc = base_cases[fid]
        tc = target_cases[fid]
        if bc.status != tc.status or bc.is_verified != tc.is_verified:
            case_diffs.append({
                "fixture_id": fid,
                "name": tc.name,
                "base_status": bc.status,
                "target_status": tc.status,
                "base_verified": bc.is_verified,
                "target_verified": tc.is_verified,
                "improved": (tc.status in ("CORRECT_REPAIR", "REPAIRED") and bc.status not in ("CORRECT_REPAIR", "REPAIRED")),
                "regressed": (bc.status in ("CORRECT_REPAIR", "REPAIRED") and tc.status not in ("CORRECT_REPAIR", "REPAIRED")),
            })

    return BenchmarkComparison(
        base_run_id=base_report.run_id,
        target_run_id=target_report.run_id,
        is_compatible=is_compatible,
        compatibility_reason=compatibility_reason,
        common_cases=common_ids,
        metric_deltas=metric_deltas,
        case_diffs=case_diffs,
    )
