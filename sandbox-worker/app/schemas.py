"""
Data contracts and request/response schemas for FixForge Isolated Sandbox Worker.
Enforces strict boundaries, input validation, and rejection of arbitrary host parameters.
"""

from typing import Any
import re
from pydantic import BaseModel, Field, field_validator, model_validator


class ResourceLimits(BaseModel):
    cpus: str = Field(default="1.0", max_length=8)
    memory: str = Field(default="512m", max_length=16)
    pids: int = Field(default=128, ge=16, le=512)

    @field_validator("cpus")
    @classmethod
    def validate_cpus(cls, v: str) -> str:
        try:
            val = float(v)
            if val <= 0 or val > 8.0:
                raise ValueError("cpus must be between 0.1 and 8.0")
        except ValueError:
            raise ValueError(f"Invalid cpus specification: {v}")
        return v

    @field_validator("memory")
    @classmethod
    def validate_memory(cls, v: str) -> str:
        m = re.match(r"^(\d+)([kmgKMG]?)$", v.strip())
        if not m:
            raise ValueError(f"Invalid memory limit format: {v}")
        return v


class JobExecutionRequest(BaseModel):
    job_id: str = Field(..., min_length=1, max_length=64)
    idempotency_key: str = Field(..., min_length=1, max_length=128)
    command: str = Field(..., min_length=1, max_length=1024)
    timeout_seconds: float = Field(default=120.0, ge=1.0, le=600.0)
    workspace_archive: str | None = Field(
        default=None,
        description="Base64 encoded .tar.gz archive of the workspace directory",
    )
    workspace_id: str | None = Field(
        default=None,
        max_length=64,
        description="Identifier of pre-staged workspace. Rejects path traversal and host paths.",
    )
    environment: dict[str, str] = Field(default_factory=dict)
    resource_limits: ResourceLimits = Field(default_factory=ResourceLimits)
    network: bool = Field(
        default=False,
        description="Disabled by default. Sandboxed jobs run with --network none.",
    )

    @field_validator("job_id")
    @classmethod
    def validate_job_id(cls, v: str) -> str:
        clean = v.strip()
        if not re.match(r"^[a-zA-Z0-9_-]+$", clean):
            raise ValueError("job_id must contain only alphanumeric characters, dashes, and underscores.")
        return clean

    @field_validator("workspace_id")
    @classmethod
    def validate_workspace_id(cls, v: str | None) -> str | None:
        if v is None:
            return None
        clean = v.strip()
        if not clean:
            return None
        if not re.match(r"^[a-zA-Z0-9_-]+$", clean):
            raise ValueError("workspace_id must be a simple alphanumeric token. Host paths, slashes, and traversal are strictly rejected.")
        return clean

    @field_validator("command")
    @classmethod
    def validate_command(cls, v: str) -> str:
        cmd = v.strip()
        if not cmd:
            raise ValueError("Command cannot be empty.")
        # Reject obvious host/socket breakout attempts
        forbidden = ["/var/run/docker.sock", "docker.sock", ":/host", "/proc/sysrq-trigger"]
        for tok in forbidden:
            if tok in cmd:
                raise ValueError(f"Command contains forbidden token: {tok}")
        return cmd

    @model_validator(mode="after")
    def validate_payload(self) -> "JobExecutionRequest":
        if not self.workspace_archive and not self.workspace_id:
            raise ValueError("Either 'workspace_archive' (base64) or 'workspace_id' must be provided.")
        return self


class VerificationSummary(BaseModel):
    is_verified: bool = False
    status: str = "FAILED"  # "VERIFIED", "PASSED", "FAILED", "TIMEOUT", "SKIPPED_ONLY", "NO_TESTS_COLLECTED", "EXECUTION_ERROR"
    reason: str = ""
    total: int = 0
    passed: int = 0
    failed: int = 0
    skipped: int = 0
    executed: int = 0
    errors: int = 0


class JobExecutionResponse(BaseModel):
    job_id: str
    idempotency_key: str
    status: str  # "completed", "failed", "timeout", "cancelled", "error"
    exit_code: int
    stdout: str
    stderr: str
    duration: float
    timed_out: bool = False
    cancelled: bool = False
    sandboxed: bool = True
    worker_id: str = "sandbox-worker-01"
    verification: VerificationSummary = Field(default_factory=VerificationSummary)


class CancelJobResponse(BaseModel):
    job_id: str
    cancelled: bool
    status: str
    message: str


class HealthResponse(BaseModel):
    status: str
    worker_id: str
    backend_type: str
    backend_available: bool
    active_jobs: int
    detail: str


class ReconcileResponse(BaseModel):
    cleaned_containers: list[str] = Field(default_factory=list)
    reaped_workspaces: list[str] = Field(default_factory=list)
    active_jobs: int = 0
