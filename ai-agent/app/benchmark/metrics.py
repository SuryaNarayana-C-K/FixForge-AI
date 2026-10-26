"""
FixForge M12.1 — Benchmark Metrics Computation Engine.
Computes precise metrics with strictly defined formulas and explicit denominators.
Never reports missing measurements as zero.
"""

from typing import Any
import numpy as np

from app.benchmark.models import BenchmarkCaseResult, BenchmarkSummaryMetrics


def deduplicate_case_results(case_results: list[BenchmarkCaseResult]) -> list[BenchmarkCaseResult]:
    """
    Ensures each case has one authoritative final outcome, while preserving
    individual retry/attempt records across multiple runs/retries.
    """
    by_fixture: dict[str, BenchmarkCaseResult] = {}
    for c in case_results:
        fid = c.fixture_id
        if fid not in by_fixture:
            by_fixture[fid] = c
        else:
            prev = by_fixture[fid]
            prev_record = {
                "status": prev.status,
                "is_verified": prev.is_verified,
                "duration_ms": prev.duration_ms,
                "model_calls": prev.model_calls,
                "error_details": prev.error_details,
                "infra_error_details": prev.infra_error_details,
            }
            merged_attempts = list(prev.attempts) + [prev_record] + list(c.attempts)
            authoritative = c.model_copy(update={"attempts": merged_attempts})
            by_fixture[fid] = authoritative
    return list(by_fixture.values())


def compute_benchmark_metrics(case_results: list[BenchmarkCaseResult]) -> BenchmarkSummaryMetrics:
    """
    Computes all benchmark metrics from a list of case results.
    Handles empty case sets and undefined denominators cleanly without division by zero.
    Implements evidence-backed M12.5 accuracy, regression, abstention, timeout, and infra error formulas.
    """
    case_results = deduplicate_case_results(case_results)
    total_cases = len(case_results)
    if total_cases == 0:
        return BenchmarkSummaryMetrics()

    # Outcome breakdown counts
    outcome_breakdown: dict[str, int] = {}
    for c in case_results:
        outcome_breakdown[c.status] = outcome_breakdown.get(c.status, 0) + 1

    # Infrastructure and invalid cases
    infra_error_cases = [
        c for c in case_results
        if c.status in ("INFRA_ERROR", "INFRASTRUCTURE_FAILURE")
    ]
    infra_error_cases_count = len(infra_error_cases)
    infra_error_rate = (infra_error_cases_count / total_cases) if total_cases > 0 else 0.0

    invalid_cases = [
        c for c in case_results
        if c.status == "INVALID_CASE" or not c.baseline_precondition_satisfied
    ]
    invalid_cases_count = len(invalid_cases)

    completed_cases = total_cases - infra_error_cases_count
    eligible_cases = [c for c in case_results if c.eligible_for_repair]
    eligible_count = len(eligible_cases)

    # Eligible completed cases (excludes infra failures and invalid preconditions from eligible repair evaluation)
    eligible_completed = [
        c for c in eligible_cases
        if c.status not in ("INFRA_ERROR", "INFRASTRUCTURE_FAILURE", "INVALID_CASE")
        and c.baseline_precondition_satisfied
    ]
    eligible_completed_count = len(eligible_completed)

    # Correct repairs (in live_repair mode, model must have actually been called; zero-call mocked fixes rejected)
    correct_repair_cases = [
        c for c in eligible_cases
        if c.status in ("REPAIRED", "CORRECT_REPAIR")
        and c.is_verified
        and not c.regression_detected
        and not c.test_integrity_violation
        and (c.execution_mode != "live_repair" or c.model_calls > 0)
    ]
    correct_repairs = len(correct_repair_cases)
    failed_repairs = sum(
        1 for c in eligible_cases
        if c.status in ("FAILED", "FAILED_REPAIR")
        or (not c.is_verified and c.status not in ("INFRA_ERROR", "INFRASTRUCTURE_FAILURE", "INVALID_CASE", "TIMEOUT", "TIMEOUT_DETECTED", "ABSTAINED", "CORRECT_ABSTENTION"))
    )

    # Repair success rate = repaired cases / eligible completed cases
    repair_success_rate = (correct_repairs / eligible_completed_count) if eligible_completed_count > 0 else None

    # Test integrity violations: cases where protected test files were modified
    test_integrity_violations = sum(1 for c in case_results if c.test_integrity_violation)

    # False VERIFIED: any case falsely marked verified despite regressions, test changes, failing tests, or invalid eligibility
    false_verified_cases = [
        c for c in case_results
        if c.is_verified and (
            not c.eligible_for_repair
            or c.status == "FALSE_VERIFIED"
            or c.regression_detected
            or c.test_integrity_violation
            or (c.post_failed > 0)
            or (c.status in ("FAILED", "FAILED_REPAIR", "REGRESSION", "INFRA_ERROR", "INVALID_CASE"))
            or (c.execution_mode == "live_repair" and c.model_calls == 0)
        )
    ]
    false_verified_count = len(false_verified_cases)
    false_verified_rate = (false_verified_count / total_cases) if total_cases > 0 else 0.0

    # Regressions: cases with regressions / cases where regression checks completed
    regressions = [
        c for c in case_results
        if c.regression_detected or c.status in ("REGRESSION", "REGRESSION_DETECTED")
    ]
    regressions_introduced = len(regressions)
    regression_checked_cases = [
        c for c in case_results
        if c.status not in ("INFRA_ERROR", "INFRASTRUCTURE_FAILURE", "INVALID_CASE")
        and (c.post_total > 0 or c.post_exit_code is not None or c.regression_detected)
    ]
    regression_checked_count = len(regression_checked_cases) if regression_checked_cases else total_cases
    regression_rate = (regressions_introduced / regression_checked_count) if regression_checked_count > 0 else 0.0

    # Abstentions
    abstained_cases = [
        c for c in case_results
        if c.status in ("ABSTAINED", "CORRECT_ABSTENTION", "ABSTENTION_DETECTED")
        or c.abstention_selected
    ]
    abstained_cases_count = len(abstained_cases)
    eligible_abstained = [
        c for c in eligible_cases
        if c.status in ("ABSTAINED", "CORRECT_ABSTENTION", "ABSTENTION_DETECTED")
        or c.abstention_selected
    ]
    abstention_rate = (len(eligible_abstained) / eligible_count) if eligible_count > 0 else None

    # Timeouts
    timeout_cases = [
        c for c in case_results
        if c.status in ("TIMEOUT", "TIMEOUT_DETECTED")
    ]
    timeout_cases_count = len(timeout_cases)
    eligible_timeouts = [
        c for c in eligible_cases
        if c.status in ("TIMEOUT", "TIMEOUT_DETECTED")
    ]
    timeout_rate = (len(eligible_timeouts) / eligible_count) if eligible_count > 0 else None

    # Invalid patch handling (for golden validation fixtures)
    invalid_patch_cases = [
        c for c in case_results
        if c.category in ("malformed_patch", "unjustified_scope", "protected_file")
    ]
    invalid_patch_total = len(invalid_patch_cases)
    invalid_patches_accepted = sum(
        1 for c in invalid_patch_cases if c.patch_applied and c.status not in ("REJECTED_INVALID_PATCH", "FAILED")
    )
    rejected_invalid = sum(
        1 for c in invalid_patch_cases if c.status in ("REJECTED_INVALID_PATCH", "FAILED")
    )
    patch_rejection_rate = (rejected_invalid / invalid_patch_total) if invalid_patch_total > 0 else None

    # Unnecessary files modified (files modified outside expected scope)
    unnecessary_files = sum(
        1 for c in case_results
        if not c.eligible_for_repair and len(c.files_modified) > 0
    )

    # Diagnosis accuracy
    diag_evaluated = [c for c in case_results if c.diagnosis_accurate is not None]
    diagnosis_cases = len(diag_evaluated)
    correct_diagnoses = sum(1 for c in diag_evaluated if c.diagnosis_accurate is True)
    diagnosis_accuracy = (correct_diagnoses / diagnosis_cases) if diagnosis_cases > 0 else None

    # Abstention accuracy on cases where abstention is expected
    abstention_target_cases = [
        c for c in case_results
        if c.category in ("insufficient_evidence", "abstain", "contradictory_evidence")
    ]
    abstention_target_count = len(abstention_target_cases)
    correct_abstentions = sum(
        1 for c in abstention_target_cases
        if c.abstention_selected or c.status in ("ABSTAINED", "CORRECT_ABSTENTION", "ABSTENTION_DETECTED")
    )
    abstention_accuracy = (correct_abstentions / abstention_target_count) if abstention_target_count > 0 else None

    # Unintended abstention on eligible repairable bugs
    unintended_abstentions = sum(
        1 for c in case_results
        if c.eligible_for_repair and (c.abstention_selected or c.status in ("UNINTENDED_ABSTENTION", "ABSTAINED"))
    )

    # Durations (percentiles)
    durations = sorted([c.duration_ms for c in case_results if c.duration_ms >= 0])
    if durations:
        median_duration = float(np.median(durations))
        p95_duration = float(np.percentile(durations, 95))
    else:
        median_duration = None
        p95_duration = None

    # Model calls
    model_calls_list = [c.model_calls for c in case_results if c.model_calls >= 0]
    avg_model_calls = (sum(model_calls_list) / len(model_calls_list)) if model_calls_list else None

    # Token usage & cost: ONLY report when genuinely provided, otherwise None
    token_counts = [
        c.token_usage.get("total_tokens") for c in case_results
        if c.token_usage and isinstance(c.token_usage.get("total_tokens"), (int, float))
    ]
    total_tokens = sum(token_counts) if token_counts else None

    costs = [c.cost_usd for c in case_results if c.cost_usd is not None]
    total_cost = sum(costs) if costs else None

    # Candidate metrics
    total_candidates = sum(c.candidate_count for c in case_results)
    avg_candidates = (total_candidates / total_cases) if total_cases > 0 else None
    selected_candidates_count = sum(1 for c in case_results if c.selected_candidate_id is not None)

    # Determine execution mode from results
    modes = {c.execution_mode for c in case_results if getattr(c, "execution_mode", None)}
    exec_mode = list(modes)[0] if len(modes) == 1 else ("mixed" if modes else "golden_validation")

    return BenchmarkSummaryMetrics(
        total_cases=total_cases,
        completed_cases=completed_cases,
        eligible_repair_cases=eligible_count,
        eligible_completed_cases=eligible_completed_count,
        correct_repairs=correct_repairs,
        repaired_count=correct_repairs,
        repair_success_rate=repair_success_rate,
        failed_repairs=failed_repairs,
        false_verified_count=false_verified_count,
        false_verified_rate=false_verified_rate,
        regressions_introduced=regressions_introduced,
        regression_cases_count=regressions_introduced,
        regression_rate=regression_rate,
        invalid_patches_accepted=invalid_patches_accepted,
        patch_rejection_rate=patch_rejection_rate,
        unnecessary_files_modified=unnecessary_files,
        diagnosis_cases=diagnosis_cases,
        correct_diagnoses=correct_diagnoses,
        diagnosis_accuracy=diagnosis_accuracy,
        abstention_cases=abstention_target_count,
        correct_abstentions=correct_abstentions,
        abstention_accuracy=abstention_accuracy,
        abstained_cases_count=abstained_cases_count,
        abstention_rate=abstention_rate,
        unintended_abstentions=unintended_abstentions,
        timeout_cases_count=timeout_cases_count,
        timeout_rate=timeout_rate,
        infra_error_cases_count=infra_error_cases_count,
        infra_error_rate=infra_error_rate,
        test_integrity_violations=test_integrity_violations,
        invalid_cases_count=invalid_cases_count,
        outcome_breakdown=outcome_breakdown,
        total_candidates_evaluated=total_candidates,
        avg_candidates_per_case=avg_candidates,
        selected_candidates_count=selected_candidates_count,
        median_repair_duration_ms=median_duration,
        p95_repair_duration_ms=p95_duration,
        avg_model_calls_per_case=avg_model_calls,
        total_tokens=total_tokens,
        total_cost_usd=total_cost,
        execution_mode=exec_mode,
    )

