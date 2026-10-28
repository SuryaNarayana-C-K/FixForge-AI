from typing import Any, TypedDict


class AgentState(TypedDict, total=False):
    # Existing Milestone 1 & 2 fields
    job_id: str
    repository_path: str
    current_state: str
    language: str
    test_framework: str
    test_command: str
    dependency_files: list[str]
    project_structure: dict[str, Any]
    baseline_result: dict[str, Any]
    failures: list[dict[str, Any]]
    errors: list[str]
    timestamps: dict[str, str]

    # Milestone 4 extensions
    repository_context: dict[str, Any]
    failure_signatures: list[dict[str, Any]]
    relevant_files: list[str]
    root_cause_analysis: dict[str, Any]
    root_cause_confidence: float
    patch_plan: dict[str, Any]
    generated_patch: dict[str, Any]
    patch_validation: dict[str, Any]
    patch_application: dict[str, Any]
    repair_attempt_id: str
    model_metadata: dict[str, Any]
    token_usage: dict[str, Any]
    agent_events: list[dict[str, Any]]

    # Milestone 5 extensions: Self-Correction Loop & Verification
    attempt_number: int
    max_attempts: int
    attempt_history: list[dict[str, Any]]
    verification_result: dict[str, Any]
    final_status: str
    is_verified: bool
    regression_detected: bool
    rollback_performed: bool
    is_duplicate_patch: bool
    patch_hash: str
    total_llm_calls: int
    max_llm_calls: int
    repair_started_at: str
    max_repair_time: float

    # Milestone 12.2 extensions: Multi-Hypothesis Diagnosis & Evidence-Ranked Repair Selection
    hypotheses: list[dict[str, Any]]
    primary_hypothesis_id: str
    selected_hypothesis: dict[str, Any]
    candidates: list[dict[str, Any]]
    selected_candidate: dict[str, Any]
    abstention: bool
    abstention_reason: str

    # Milestone 12.3 extensions: Candidate Patch Evaluation & Intelligent Repair Selection
    max_candidates: int
    candidate_evaluations: list[dict[str, Any]]
    candidate_rejections: dict[str, str]
    selection_rationale: str
    candidate_evaluation_duration_ms: int


