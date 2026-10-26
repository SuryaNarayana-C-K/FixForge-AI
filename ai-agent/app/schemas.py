from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field

from app.patch_schemas import (
    AttemptHistoryItem,
    GeneratedPatch,
    PatchApplicationResult,
    PatchPlan,
    PatchValidationResult,
    RepairAttemptRecord,
    RootCauseAnalysis,
    VerificationResult,
)



class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    service: str = "fixforge-ai-agent"
    version: str = "0.4.0"


class RepairRequest(BaseModel):
    repair_id: UUID
    repository: str
    issue: str = Field(min_length=1)
    model: str = "default"
    max_iterations: int = Field(default=5, ge=1, le=10)


class AgentEvent(BaseModel):
    event: str
    state: str
    message: str
    created_at: datetime


class RepairAccepted(BaseModel):
    repair_id: UUID
    status: Literal["accepted"] = "accepted"
    message: str


class FailureDetail(BaseModel):
    test_name: str
    file: str
    error_type: str
    message: str
    traceback: str | None = ""
    source_reference: str | None = None


class BaselineMetrics(BaseModel):
    total: int = 0
    passed: int = 0
    failed: int = 0
    skipped: int = 0
    errors: int = 0
    duration: float = 0.0
    exit_code: int = 0
    status: str = "completed"


class RepositoryInfo(BaseModel):
    language: str = "python"
    test_framework: str = "pytest"
    test_command: str = "pytest"
    package_manager: str | None = None


class AnalyzeRequest(BaseModel):
    job_id: str
    repository_path: str
    language: str | None = None


class AnalyzeResponse(BaseModel):
    job_id: str
    status: str
    repository: RepositoryInfo
    project_structure: dict[str, Any]
    baseline: BaselineMetrics
    failures: list[FailureDetail] = Field(default_factory=list)


class SandboxHealthResponse(BaseModel):
    docker_available: bool
    runner: str
    version: str | None = None
    image: str = "fixforge-sandbox:latest"
    detail: str


class SandboxRunRequest(BaseModel):
    job_id: str
    repository_path: str
    command: str = "pytest"
    timeout: float | None = None


class SandboxRunResponse(BaseModel):
    status: str
    command: str
    exit_code: int
    stdout: str
    stderr: str
    duration: float
    timed_out: bool = False
    container_id: str | None = None
    sandboxed: bool = True


# --- Milestone 4 Request/Response Schemas ---

class RootCauseRequest(BaseModel):
    job_id: str
    repository_path: str
    failures: list[dict[str, Any]] | None = None


class RootCauseResponse(BaseModel):
    job_id: str
    root_cause: RootCauseAnalysis
    relevant_files: list[str] = Field(default_factory=list)


class PatchPlanRequest(BaseModel):
    job_id: str
    repository_path: str
    root_cause: dict[str, Any] | None = None
    failures: list[dict[str, Any]] | None = None


class PatchPlanResponse(BaseModel):
    job_id: str
    patch_plan: PatchPlan


class GeneratePatchRequest(BaseModel):
    job_id: str
    repository_path: str
    root_cause: dict[str, Any] | None = None
    patch_plan: dict[str, Any] | None = None
    failures: list[dict[str, Any]] | None = None


class GeneratePatchResponse(BaseModel):
    job_id: str
    generated_patch: GeneratedPatch
    validation: PatchValidationResult


class ApplyPatchRequest(BaseModel):
    job_id: str
    repository_path: str
    diff: str


class ApplyPatchResponse(BaseModel):
    job_id: str
    result: PatchApplicationResult


class RepairWorkflowRequest(BaseModel):
    job_id: str
    repository_path: str
    auto_apply: bool = False


class RepairWorkflowResponse(BaseModel):
    job_id: str
    status: str
    repository: RepositoryInfo
    baseline: BaselineMetrics
    failures: list[FailureDetail] = Field(default_factory=list)
    root_cause: RootCauseAnalysis | None = None
    patch_plan: PatchPlan | None = None
    generated_patch: GeneratedPatch | None = None
    validation: PatchValidationResult | None = None
    application: PatchApplicationResult | None = None
    agent_events: list[dict[str, Any]] = Field(default_factory=list)