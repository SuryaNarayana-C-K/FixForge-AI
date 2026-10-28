"""
Structured Pydantic schemas for Milestone 4:
Root Cause Analysis, Context Selection, Patch Planning, Patch Generation, Validation, and Application.
"""

from typing import Any, Literal
from pydantic import BaseModel, Field, model_validator


class RootCauseEvidence(BaseModel):
    file: str = Field(..., description="File path relative to repository root")
    line: int | None = Field(None, description="Line number where evidence is found")
    reason: str = Field(..., description="Explanation of why this line/file is evidence")
    observed_behavior: str = Field(default="", description="Exact observed runtime behavior at this location")
    expected_behavior: str = Field(default="", description="Exact expected behavior at this location")
    failing_test: str = Field(default="", description="Associated failing test name or traceback reference")


class DiagnosisHypothesis(BaseModel):
    hypothesis_id: str = Field(..., description="Stable unique identifier for the hypothesis (e.g. hyp-1, hyp-2)")
    root_cause_statement: str = Field(..., description="Concise statement of the diagnosed root cause")
    relevant_files: list[str] = Field(default_factory=list, description="Relevant file paths and line ranges (e.g. 'calc.py:15-20')")
    supporting_evidence: list[str] = Field(default_factory=list, description="Supporting test failures, tracebacks, or code references")
    observed_behavior: str = Field(default="", description="Factual observed runtime behavior")
    expected_behavior: str = Field(default="", description="Expected correct behavior")
    causal_explanation: str = Field(default="", description="Causal reasoning linking the code defect to the observed failure")
    confidence_score: float = Field(
        default=0.85,
        ge=0.0,
        le=1.0,
        description="Self-assessed confidence score between 0.0 and 1.0",
    )
    missing_evidence_or_assumptions: list[str] = Field(
        default_factory=list,
        description="Identified gaps in evidence, unverified assumptions, or contradictory signals",
    )
    proposed_repair_strategy: str = Field(default="", description="Proposed minimal repair strategy")
    rank: int | None = Field(default=None, description="Deterministic rank assigned by evidence ranker (1 = highest)")
    ranking_score: float | None = Field(default=None, description="Quantitative score from evidence ranker")
    ranking_reasons: list[str] = Field(default_factory=list, description="Inspectable criteria explaining the rank assignment")


class RootCauseAnalysis(BaseModel):
    summary: str = Field(..., description="High-level summary of the failure")
    failure_type: str = Field(
        default="logic_error",
        description="Category: logic_error, assertion_error, type_error, exception, etc.",
    )
    root_cause: str = Field(..., description="Detailed explanation of the root cause")
    observed: str = Field(
        default="",
        description="Factual observation: what the test/code actually did or produced",
    )
    hypothesis: str = Field(
        default="",
        description="AI hypothesis explaining why the observed failure occurred",
    )
    evidence: list[RootCauseEvidence] = Field(
        default_factory=list,
        description="List of specific code references supporting the root cause",
    )
    confidence: float = Field(
        default=0.85,
        ge=0.0,
        le=1.0,
        description="AI confidence score between 0.0 and 1.0",
    )
    hypotheses: list[DiagnosisHypothesis] = Field(
        default_factory=list,
        description="Bounded set of candidate root cause hypotheses evaluated for this failure",
    )
    primary_hypothesis_id: str | None = Field(
        default=None,
        description="ID of the highest-ranked selected hypothesis",
    )
    abstention_recommended: bool = Field(
        default=False,
        description="Whether the diagnosis engine recommends abstaining due to insufficient or contradictory evidence",
    )
    abstention_reason: str | None = Field(
        default=None,
        description="Reason for recommending abstention when evidence is insufficient or contradictory",
    )


class PatchChange(BaseModel):
    file: str = Field(..., description="Target file path")
    location: str = Field(..., description="Approximate location or line number / function")
    description: str = Field(..., description="Description of the change to be made")


class PatchPlan(BaseModel):
    objective: str = Field(..., description="Primary goal of the proposed fix")
    files_to_modify: list[str] = Field(
        default_factory=list,
        description="List of file paths that will be touched by the patch",
    )
    changes: list[PatchChange] = Field(
        default_factory=list,
        description="List of individual changes planned",
    )
    risks: list[str] = Field(
        default_factory=list,
        description="Potential side effects or regression risks",
    )


class GeneratedPatch(BaseModel):
    files: list[str] = Field(default_factory=list, description="Files modified in the diff")
    diff: str = Field(..., description="Unified diff string (--- a/... +++ b/...)")
    explanation: str = Field(default="", description="Natural-language explanation of the patch")


class PatchValidationResult(BaseModel):
    valid: bool = Field(..., description="Whether the patch is valid and safe to apply")
    status: Literal["VALID", "INVALID", "REQUIRES_REVIEW"] = Field(
        default="VALID",
        description="Validation status category",
    )
    errors: list[str] = Field(default_factory=list, description="Fatal validation errors")
    warnings: list[str] = Field(default_factory=list, description="Non-fatal warnings")
    files_to_modify: list[str] = Field(default_factory=list, description="Validated files")
    lines_added: int = Field(default=0, description="Count of added lines (+)")
    lines_removed: int = Field(default=0, description="Count of removed lines (-)")


class RepairCandidate(BaseModel):
    candidate_id: str = Field(..., description="Unique deterministic identifier for candidate (e.g. cand-1)")
    hypothesis_id: str = Field(..., description="Associated hypothesis ID")
    rationale: str = Field(default="", description="Rationale explaining how this patch resolves the defect")
    files: list[str] = Field(default_factory=list, description="Files modified in candidate diff")
    changed_files: list[str] = Field(default_factory=list, description="Explicit list of files modified in candidate diff")
    diff: str = Field(..., description="Unified diff string")
    diff_hash: str = Field(default="", description="SHA-256 hash of normalized unified diff")
    generation_metadata: dict[str, Any] | None = Field(default=None, description="Metadata from patch generator")
    validation: PatchValidationResult | None = Field(default=None, description="Pre-application validation outcome")
    status: Literal["PENDING", "VALID", "INVALID", "EVALUATED", "SELECTED", "REJECTED"] = Field(
        default="PENDING",
        description="Lifecycle status of this candidate",
    )
    rejection_reason: str | None = Field(default=None, description="Reason if candidate was rejected")
    ranking_score: float | None = Field(default=None, description="Score assigned by candidate ranker")
    ranking_reasons: list[str] = Field(default_factory=list, description="Criteria explaining the rank assignment")
    selection_reasons: list[str] = Field(default_factory=list, description="Reasons for selecting this candidate")
    selection_rationale: str | None = Field(default=None, description="High-level selection or rejection rationale")
    evaluation: dict[str, Any] | None = Field(default=None, description="Detailed verification evaluation outcome")
    lines_added: int = Field(default=0, description="Count of added lines (+)")
    lines_removed: int = Field(default=0, description="Count of removed lines (-)")
    duration_ms: int = Field(default=0, description="Duration in ms to evaluate this candidate in isolation")
    is_duplicate: bool = Field(default=False, description="Whether this patch is equivalent to an earlier candidate")
    duplicate_of: str | None = Field(default=None, description="Candidate ID of the equivalent patch if deduplicated")

    @model_validator(mode="after")
    def sync_file_fields(self) -> "RepairCandidate":
        if self.changed_files and not self.files:
            self.files = list(self.changed_files)
        elif self.files and not self.changed_files:
            self.changed_files = list(self.files)
        return self


class PatchApplicationResult(BaseModel):
    applied: bool = Field(..., description="Whether the patch was successfully applied")
    status: Literal["APPLIED", "FAILED", "ROLLED_BACK"] = Field(
        default="APPLIED",
        description="Application status",
    )
    error: str | None = Field(default=None, description="Error message if application failed")
    files_modified: list[str] = Field(
        default_factory=list,
        description="List of files successfully written",
    )
    git_diff_before: str | None = Field(
        default=None,
        description="Repository git diff before patch application",
    )
    git_diff_after: str | None = Field(
        default=None,
        description="Repository git diff after patch application",
    )
    backup_id: str | None = Field(
        default=None,
        description="Identifier of file backup snapshots in case of rollback",
    )
    timestamp: str = Field(..., description="ISO 8601 timestamp of patch application")


class VerificationResult(BaseModel):
    status: Literal[
        "PASSED",
        "FAILED",
        "ERROR",
        "TIMEOUT",
        "REGRESSION_DETECTED",
        "SKIPPED_ONLY",
        "NO_TESTS_COLLECTED",
        "EXECUTION_ERROR",
    ] = Field(
        default="FAILED",
        description="Verification outcome category",
    )
    exit_code: int | None = Field(default=None, description="Process exit code")
    passed: int = Field(default=0, description="Passed test count")
    failed: int = Field(default=0, description="Failed test count")
    skipped: int = Field(default=0, description="Skipped test count")
    total: int = Field(default=0, description="Total test count")
    stdout: str = Field(default="", description="Execution standard output")
    stderr: str = Field(default="", description="Execution standard error")
    duration: float = Field(default=0.0, description="Execution duration in seconds")
    timed_out: bool = Field(default=False, description="Whether execution timed out")
    regression_detected: bool = Field(default=False, description="Whether new regressions were detected")
    failure_signatures: list[dict[str, Any]] = Field(default_factory=list, description="Extracted failure signatures")
    new_failures: list[dict[str, Any]] = Field(default_factory=list, description="Failures not present in baseline")
    resolved_failures: list[dict[str, Any]] = Field(default_factory=list, description="Baseline failures now passing")


class AttemptHistoryItem(BaseModel):
    attempt: int = Field(..., description="Attempt sequence number")
    status: str = Field(..., description="Outcome of the attempt")
    root_cause: dict[str, Any] | None = None
    patch: dict[str, Any] | None = None
    patch_hash: str | None = None
    verification: dict[str, Any] | None = None
    rollback_performed: bool = False
    duration: float = 0.0


class RepairAttemptRecord(BaseModel):
    id: str = Field(default="", description="Unique identifier of attempt")
    attempt_number: int = Field(default=1, description="Attempt sequence number (1, 2, 3...)")
    status: str = Field(default="PENDING", description="Attempt status: PENDING, ANALYZING, APPLIED, VERIFYING, PASSED, FAILED, ROLLED_BACK, etc.")
    failure_summary: str | None = Field(default=None, description="Summary of failures being addressed")
    root_cause: RootCauseAnalysis | None = None
    root_cause_confidence: float | None = None
    patch_plan: PatchPlan | None = None
    generated_patch: GeneratedPatch | None = None
    patch_hash: str | None = None
    validation: PatchValidationResult | None = None
    application: PatchApplicationResult | None = None
    verification: VerificationResult | None = None
    rollback_performed: bool = Field(default=False, description="Whether patch was rolled back")
    duration: float = Field(default=0.0, description="Total attempt duration in seconds")
    started_at: str = Field(default="", description="Start timestamp ISO")
    completed_at: str | None = Field(default=None, description="Completion timestamp ISO")

