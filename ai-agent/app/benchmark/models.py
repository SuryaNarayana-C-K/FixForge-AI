"""
FixForge M12.1 — Benchmark Engine Data Models.
Structured, type-safe definitions for benchmark fixtures, execution results,
precise metrics, reports, and run comparisons.
"""

from datetime import datetime, timezone
from typing import Any, Literal
from pydantic import BaseModel, Field


class BenchmarkFixture(BaseModel):
    id: str = Field(..., description="Unique deterministic identifier for the fixture")
    name: str = Field(..., description="Human-readable title of the benchmark case")
    category: str = Field(..., description="Defect category: arithmetic, exception, boundary, multi_file, etc.")
    description: str = Field(..., description="Detailed explanation of the intended defect")
    expected_behavior: str = Field(..., description="Expected correct functionality when repaired")
    test_command: str = Field(default="pytest", description="Command used to execute tests")
    test_framework: str = Field(default="pytest", description="Test framework parser to use")
    eligible_for_repair: bool = Field(default=True, description="Whether this fixture is a legitimate candidate for repair")
    expected_baseline_exit_code: int | None = Field(default=1, description="Expected initial test run exit code")
    expected_baseline_status: str = Field(default="FAILED", description="Expected initial test run status")
    expected_post_status: str = Field(default="PASSED", description="Expected status after a correct repair")
    golden_patch: str | None = Field(default=None, description="Known working unified diff resolving the defect")
    relative_path: str = Field(..., description="Path relative to canonical fixtures root")


class BenchmarkCaseResult(BaseModel):
    fixture_id: str
    name: str
    category: str
    eligible_for_repair: bool
    status: Literal[
        # M12.5 Live Accuracy Outcomes
        "REPAIRED",
        "FAILED",
        "REGRESSION",
        "ABSTAINED",
        "TIMEOUT",
        "INFRA_ERROR",
        "INVALID_CASE",
        # Legacy M12.1-M12.4 Outcomes
        "CORRECT_REPAIR",
        "FAILED_REPAIR",
        "REJECTED_INVALID_PATCH",
        "REGRESSION_DETECTED",
        "SKIPPED_ONLY_REJECTED",
        "NO_TESTS_REJECTED",
        "TIMEOUT_DETECTED",
        "COLLECTION_FAILURE_REJECTED",
        "INFRASTRUCTURE_FAILURE",
        "FALSE_VERIFIED",
        "CORRECT_ABSTENTION",
        "UNINTENDED_ABSTENTION",
        "DIAGNOSIS_ACCURATE",
        "DIAGNOSIS_FAILED",
        "ABSTENTION_DETECTED",
    ]
    is_verified: bool
    duration_ms: int
    model_calls: int = 0
    token_usage: dict[str, Any] | None = None
    cost_usd: float | None = None
    baseline_exit_code: int | None = None
    baseline_passed: int = 0
    baseline_failed: int = 0
    baseline_total: int = 0
    post_exit_code: int | None = None
    post_passed: int = 0
    post_failed: int = 0
    post_total: int = 0
    regression_detected: bool = False
    patch_applied: bool = False
    files_modified: list[str] = Field(default_factory=list)
    diagnosed_hypothesis: str | None = None
    diagnosis_accurate: bool | None = None
    abstention_selected: bool = False
    ranking_score: float | None = None
    error_details: str | None = None
    reproducible_command: str = ""
    candidate_count: int = 0
    valid_candidate_count: int = 0
    candidate_rejections: dict[str, str] = Field(default_factory=dict)
    selected_candidate_id: str | None = None
    selection_rationale: str | None = None
    candidate_evaluation_duration_ms: int = 0
    candidates: list[dict[str, Any]] = Field(default_factory=list)
    attempts: list[dict[str, Any]] = Field(default_factory=list, description="Preserves history of individual retry and attempt records")
    # M12.5 Live Repair Accuracy Extensions
    execution_mode: str = "golden_validation"
    independent_tests_passed: bool | None = None
    test_integrity_violation: bool = False
    test_file_hashes_before: dict[str, str] = Field(default_factory=dict)
    test_file_hashes_after: dict[str, str] = Field(default_factory=dict)
    baseline_precondition_satisfied: bool = True
    infra_error_details: str | None = None
    held_out_test_output: str | None = None
    regression_details: str | None = None
    model_name: str | None = None
    git_commit: str | None = None
    bug_id: str | None = None
    language: str | None = None


class BenchmarkSummaryMetrics(BaseModel):
    total_cases: int = 0
    completed_cases: int = 0
    eligible_repair_cases: int = 0
    eligible_completed_cases: int = 0
    correct_repairs: int = 0
    repaired_count: int = 0
    repair_success_rate: float | None = None  # correct_repairs / eligible_completed_cases
    failed_repairs: int = 0
    false_verified_count: int = 0
    false_verified_rate: float = 0.0  # false_verified_count / total_cases
    regressions_introduced: int = 0
    regression_cases_count: int = 0
    regression_rate: float = 0.0  # regressions_introduced / total_cases
    invalid_patches_accepted: int = 0
    patch_rejection_rate: float | None = None  # rejected_invalid_patches / total_invalid_patch_cases
    unnecessary_files_modified: int = 0
    diagnosis_cases: int = 0
    correct_diagnoses: int = 0
    diagnosis_accuracy: float | None = None  # correct_diagnoses / diagnosis_cases
    abstention_cases: int = 0
    correct_abstentions: int = 0
    abstention_accuracy: float | None = None  # correct_abstentions / abstention_cases
    abstained_cases_count: int = 0
    abstention_rate: float | None = None  # abstained_cases / eligible_cases
    unintended_abstentions: int = 0
    timeout_cases_count: int = 0
    timeout_rate: float | None = None  # timed_out_cases / eligible_cases
    infra_error_cases_count: int = 0
    infra_error_rate: float | None = None  # infra_errors / attempted_cases
    test_integrity_violations: int = 0  # cases where protected test files were changed
    invalid_cases_count: int = 0  # cases that failed baseline preconditions
    outcome_breakdown: dict[str, int] = Field(default_factory=dict)
    total_candidates_evaluated: int = 0
    avg_candidates_per_case: float | None = None
    selected_candidates_count: int = 0
    median_repair_duration_ms: float | None = None
    p95_repair_duration_ms: float | None = None
    avg_model_calls_per_case: float | None = None
    total_tokens: int | None = None  # None if unavailable, never fake 0
    total_cost_usd: float | None = None  # None if unavailable, never fake 0
    execution_mode: str = "golden_validation"
    definitions: dict[str, str] = Field(
        default_factory=lambda: {
            "repair_success_rate": "repaired_cases / eligible_completed_cases (genuine repairable bugs only)",
            "regression_rate": "cases_with_regressions / cases_where_regression_checks_completed",
            "abstention_rate": "abstained_cases / eligible_cases",
            "timeout_rate": "timed_out_cases / eligible_cases",
            "infra_error_rate": "infra_error_cases / total_cases",
            "test_integrity_violations": "cases where test files or protected files were modified by repair agent",
            "false_verified_rate": "false_verified_count / total_cases (must strictly be 0.0)",
            "candidate_evaluation": "Isolated candidate patch evaluation in disposable workspaces; ranking by test correctness & Occam's razor.",
            "token_usage_and_cost": "Reported as null when unavailable from runner/provider; never fabricated as zero.",
        }
    )


class BenchmarkReport(BaseModel):
    run_id: str
    timestamp: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    code_revision: str = "main"
    fixture_version: str = "1.0.0"
    execution_mode: str = "golden_validation"
    model: str | None = None
    git_commit: str | None = None
    environment: dict[str, Any] = Field(default_factory=dict)
    metrics: BenchmarkSummaryMetrics
    case_results: list[BenchmarkCaseResult] = Field(default_factory=list)


class BenchmarkComparison(BaseModel):
    base_run_id: str
    target_run_id: str
    is_compatible: bool
    compatibility_reason: str = ""
    common_cases: list[str] = Field(default_factory=list)
    metric_deltas: dict[str, Any] = Field(default_factory=dict)
    case_diffs: list[dict[str, Any]] = Field(default_factory=list)
