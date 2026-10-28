from datetime import datetime, timezone
import hmac
import os
from pathlib import Path
from typing import Any

# Load environment configuration from .env if present
for _env_file in [
    Path(__file__).resolve().parent.parent.parent / ".env",
    Path(__file__).resolve().parent.parent / ".env",
]:
    if _env_file.is_file():
        try:
            for _line in _env_file.read_text(encoding="utf-8").splitlines():
                _line = _line.strip()
                if _line and not _line.startswith("#") and "=" in _line:
                    _k, _v = _line.split("=", 1)
                    _k = _k.strip()
                    _v = _v.strip().strip('"').strip("'")
                    if not os.environ.get(_k):
                        os.environ[_k] = _v
        except OSError:
            pass

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.providers.gemini import (
    LLMAuthenticationError,
    LLMConfigurationError,
    LLMRequestFailedError,
    PatchGenerationError,
    sanitize_text,
)




from .graph import build_analysis_graph
from .runner import get_execution_runner
from .sandbox import (
    CapacityExceededError,
    DockerSandboxRunner,
    InvalidStateTransitionError,
    JobConflictError,
    JobState,
    LateCallbackIgnoredError,
    SandboxError,
    SandboxUnavailable,
    SandboxWorkspaceViolation,
    global_lifecycle_manager,
)
from .schemas import (
    AgentEvent,
    AnalyzeRequest,
    AnalyzeResponse,
    ApplyPatchRequest,
    ApplyPatchResponse,
    BaselineMetrics,
    FailureDetail,
    GeneratePatchRequest,
    GeneratePatchResponse,
    HealthResponse,
    PatchPlanRequest,
    PatchPlanResponse,
    RepairAccepted,
    RepairRequest,
    RepairWorkflowRequest,
    RepairWorkflowResponse,
    RepositoryInfo,
    RootCauseRequest,
    RootCauseResponse,
    SandboxHealthResponse,
    SandboxRunRequest,
    SandboxRunResponse,
)
from .patch_schemas import (
    GeneratedPatch,
    PatchApplicationResult,
    PatchPlan,
    PatchValidationResult,
    RootCauseAnalysis,
)
from .workspace import WorkspaceManager, WorkspaceSecurityError

app = FastAPI(
    title="FixForge AI Agent",
    description="Internal model-agnostic service boundary for autonomous software repair.",
    version="0.3.0",
)


@app.middleware("http")
async def verify_service_authentication(request: Request, call_next):
    # Public unauthenticated probe endpoints
    path = request.url.path.rstrip("/")
    if path in ("/healthz", "/health", "/docs", "/openapi.json", "/redoc"):
        return await call_next(request)

    expected_key = os.environ.get("INTERNAL_SERVICE_KEY", "").strip()
    node_env = os.environ.get("NODE_ENV", "").strip().lower()
    fixforge_env = os.environ.get("FIXFORGE_ENV", "").strip().lower()
    is_strict = (
        node_env in ("staging", "production")
        or fixforge_env in ("staging", "production")
        or bool(expected_key)
    )

    if is_strict:
        if not expected_key:
            return JSONResponse(
                status_code=500,
                content={
                    "error": "INTERNAL_SERVICE_KEY is not configured on AI service",
                    "code": "SERVICE_AUTH_MISCONFIGURED",
                },
            )

        auth_header = request.headers.get("x-service-key") or ""
        if not auth_header:
            auth = request.headers.get("authorization", "")
            if auth.lower().startswith("bearer "):
                auth_header = auth[7:].strip()

        if not auth_header or not hmac.compare_digest(auth_header, expected_key):
            return JSONResponse(
                status_code=401,
                content={
                    "error": "Unauthorized service request: invalid or missing service credentials.",
                    "code": "UNAUTHORIZED_SERVICE",
                },
            )

    return await call_next(request)


@app.exception_handler(JobConflictError)
async def job_conflict_error_handler(request: Request, exc: JobConflictError):
    return JSONResponse(
        status_code=409,
        content={"error": str(exc), "code": "JOB_ALREADY_RUNNING", "detail": str(exc)},
    )


@app.exception_handler(CapacityExceededError)
async def capacity_exceeded_error_handler(request: Request, exc: CapacityExceededError):
    return JSONResponse(
        status_code=429,
        content={"error": str(exc), "code": "MAX_CONCURRENT_JOBS_EXCEEDED", "detail": str(exc)},
    )


@app.exception_handler(InvalidStateTransitionError)
async def invalid_transition_error_handler(request: Request, exc: InvalidStateTransitionError):
    return JSONResponse(
        status_code=400,
        content={"error": str(exc), "code": "INVALID_STATE_TRANSITION", "detail": str(exc)},
    )


@app.exception_handler(LLMConfigurationError)
async def llm_config_error_handler(request: Request, exc: LLMConfigurationError):
    sanitized = sanitize_text(str(exc))
    return JSONResponse(
        status_code=400,
        content={"error": sanitized, "code": "LLM_CONFIGURATION_ERROR", "detail": sanitized},
    )


@app.exception_handler(LLMAuthenticationError)
async def llm_auth_error_handler(request: Request, exc: LLMAuthenticationError):
    sanitized = sanitize_text(str(exc))
    return JSONResponse(
        status_code=401,
        content={"error": sanitized, "code": "LLM_AUTHENTICATION_ERROR", "detail": sanitized},
    )


@app.exception_handler(LLMRequestFailedError)
async def llm_request_failed_handler(request: Request, exc: LLMRequestFailedError):
    sanitized = sanitize_text(str(exc))
    return JSONResponse(
        status_code=502,
        content={"error": sanitized, "code": "LLM_REQUEST_FAILED", "detail": sanitized},
    )


@app.exception_handler(PatchGenerationError)
async def patch_gen_error_handler(request: Request, exc: PatchGenerationError):
    sanitized = sanitize_text(str(exc))
    return JSONResponse(
        status_code=422,
        content={"error": sanitized, "code": "PATCH_GENERATION_FAILED", "detail": sanitized},
    )


@app.get("/healthz", response_model=HealthResponse)
@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse()


@app.get("/sandbox/health", response_model=SandboxHealthResponse)
async def sandbox_health() -> SandboxHealthResponse:
    """Check Docker daemon availability and sandbox status."""
    runner = get_execution_runner()
    if hasattr(runner, "check_health"):
        health_data = await runner.check_health()
    else:
        avail, ver, det = await DockerSandboxRunner.is_docker_available()
        health_data = {"docker_available": avail, "runner": "docker", "version": ver, "detail": det or "Operational"}
    return SandboxHealthResponse(
        docker_available=health_data.get("docker_available", False),
        runner=health_data.get("runner", "docker"),
        version=health_data.get("version"),
        image=health_data.get("image", "fixforge-sandbox:latest"),
        detail=health_data.get("detail", ""),
    )


@app.post("/sandbox/run", response_model=SandboxRunResponse)
async def sandbox_run_endpoint(request: SandboxRunRequest) -> SandboxRunResponse:
    """
    Execute a test or repair command inside an isolated Docker sandbox.
    """
    workspace_mgr = WorkspaceManager()
    try:
        resolved_workspace = workspace_mgr.resolve_repository_path(request.repository_path)
    except WorkspaceSecurityError as e:
        raise HTTPException(status_code=400, detail=f"Workspace security violation: {str(e)}")
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=f"Repository not found: {str(e)}")

    runner = get_execution_runner()
    timeout = request.timeout if request.timeout is not None else 120.0

    try:
        result = await runner.run(
            command=request.command,
            cwd=resolved_workspace,
            timeout=timeout,
            job_id=request.job_id,
        )
    except SandboxUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e))
    except SandboxWorkspaceViolation as e:
        raise HTTPException(status_code=400, detail=str(e))
    except SandboxError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Sandbox execution failed: {str(e)}")

    return SandboxRunResponse(
        status=result.status,
        command=result.command,
        exit_code=result.exit_code,
        stdout=result.stdout,
        stderr=result.stderr,
        duration=result.duration,
        timed_out=result.timed_out,
        container_id=result.container_id,
        sandboxed=result.sandboxed,
    )


@app.post("/agent/repair", response_model=RepairAccepted, status_code=202)
async def accept_repair(request: RepairRequest) -> RepairAccepted:
    return RepairAccepted(
        repair_id=request.repair_id,
        message="Repair accepted by the agent service; execution begins in a later milestone.",
    )


@app.get("/agent/capabilities", response_model=list[str])
async def capabilities() -> list[str]:
    return [
        "repository-analysis",
        "baseline-testing",
        "failure-detection",
        "repair-planning",
        "patch-generation",
        "sandbox-execution",
        "self-correction",
        "verification",
    ]


@app.get("/agent/events/example", response_model=list[AgentEvent])
async def example_events() -> list[AgentEvent]:
    return [
        AgentEvent(
            event="agent.ready",
            state="INIT",
            message="Agent service is ready to receive repair jobs.",
            created_at=datetime.now(timezone.utc),
        )
    ]


@app.post("/agent/analyze", response_model=AnalyzeResponse)
async def analyze_repository_endpoint(request: AnalyzeRequest) -> AnalyzeResponse:
    """
    Execute Milestone 2 LangGraph workflow:
    INIT -> REPOSITORY_ANALYSIS -> BASELINE_TESTING -> FAILURE_DETECTION -> END
    """
    graph = build_analysis_graph()

    initial_state = {
        "job_id": request.job_id,
        "repository_path": request.repository_path,
        "explicit_language": request.language,
        "errors": [],
        "timestamps": {},
    }

    try:
        final_state = await graph.ainvoke(initial_state)
    except WorkspaceSecurityError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Analysis failed: {type(e).__name__}: {str(e)}")

    baseline_raw = final_state.get("baseline_result", {})
    failures_raw = final_state.get("failures", [])

    failures_list = [
        FailureDetail(
            test_name=f.get("test_name", "unknown"),
            file=f.get("file", ""),
            error_type=f.get("error_type", "Error"),
            message=f.get("message", ""),
            traceback=f.get("traceback", ""),
            source_reference=f.get("source_reference"),
        )
        for f in failures_raw
    ]

    baseline_metrics = BaselineMetrics(
        total=baseline_raw.get("total", 0),
        passed=baseline_raw.get("passed", 0),
        failed=baseline_raw.get("failed", 0),
        skipped=baseline_raw.get("skipped", 0),
        errors=baseline_raw.get("errors", 0),
        duration=baseline_raw.get("duration", 0.0),
        exit_code=baseline_raw.get("exit_code", 0),
        status=baseline_raw.get("status", "completed"),
    )

    proj_struct = final_state.get("project_structure", {})
    return AnalyzeResponse(
        job_id=request.job_id,
        status="baseline_completed",
        repository=RepositoryInfo(
            language=final_state.get("language", "python"),
            test_framework=final_state.get("test_framework", "pytest"),
            test_command=final_state.get("test_command", "pytest"),
            package_manager=proj_struct.get("package_manager"),
        ),
        project_structure=proj_struct,
        baseline=baseline_metrics,
        failures=failures_list,
    )


# --- Milestone 4 AI Endpoints ---

@app.post("/agent/root-cause", response_model=RootCauseResponse)
async def analyze_root_cause_endpoint(request: RootCauseRequest) -> RootCauseResponse:
    workspace_mgr = WorkspaceManager()
    try:
        resolved_ws = workspace_mgr.resolve_repository_path(request.repository_path)
    except WorkspaceSecurityError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))

    from .graph.nodes.root_cause import root_cause_analysis_node
    from .graph.nodes.analysis import baseline_testing_node, failure_detection_node, repository_analysis_node

    failures = request.failures
    project_structure = {}
    if failures is None:
        init_state = {
            "job_id": request.job_id,
            "repository_path": str(resolved_ws),
            "timestamps": {},
        }
        s1 = await repository_analysis_node(init_state)
        init_state.update(s1)
        s2 = await baseline_testing_node(init_state)
        init_state.update(s2)
        s3 = await failure_detection_node(init_state)
        failures = s3.get("failures", [])
        project_structure = s1.get("project_structure", {})

    state = {
        "job_id": request.job_id,
        "repository_path": str(resolved_ws),
        "failures": failures,
        "project_structure": project_structure,
        "timestamps": {},
        "agent_events": [],
    }

    result_state = await root_cause_analysis_node(state)
    rc_data = result_state.get("root_cause_analysis", {})

    return RootCauseResponse(
        job_id=request.job_id,
        root_cause=RootCauseAnalysis.model_validate(rc_data),
        relevant_files=result_state.get("relevant_files", []),
    )


@app.post("/agent/plan", response_model=PatchPlanResponse)
async def patch_plan_endpoint(request: PatchPlanRequest) -> PatchPlanResponse:
    workspace_mgr = WorkspaceManager()
    try:
        resolved_ws = workspace_mgr.resolve_repository_path(request.repository_path)
    except WorkspaceSecurityError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))

    from .graph.nodes.patching import patch_planning_node

    state = {
        "job_id": request.job_id,
        "repository_path": str(resolved_ws),
        "root_cause_analysis": request.root_cause or {},
        "failures": request.failures or [],
        "timestamps": {},
        "agent_events": [],
    }

    result_state = await patch_planning_node(state)
    plan_data = result_state.get("patch_plan", {})
    return PatchPlanResponse(
        job_id=request.job_id,
        patch_plan=PatchPlan.model_validate(plan_data),
    )


@app.post("/agent/patch", response_model=GeneratePatchResponse)
async def generate_patch_endpoint(request: GeneratePatchRequest) -> GeneratePatchResponse:
    workspace_mgr = WorkspaceManager()
    try:
        resolved_ws = workspace_mgr.resolve_repository_path(request.repository_path)
    except WorkspaceSecurityError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))

    from .graph.nodes.patching import patch_generation_node, patch_validation_node

    state = {
        "job_id": request.job_id,
        "repository_path": str(resolved_ws),
        "root_cause_analysis": request.root_cause or {},
        "patch_plan": request.patch_plan or {},
        "failures": request.failures or [],
        "timestamps": {},
        "agent_events": [],
    }

    gen_state = await patch_generation_node(state)
    state.update(gen_state)
    val_state = await patch_validation_node(state)

    gen_patch = GeneratedPatch.model_validate(gen_state.get("generated_patch", {}))
    val_result = PatchValidationResult.model_validate(val_state.get("patch_validation", {}))

    return GeneratePatchResponse(
        job_id=request.job_id,
        generated_patch=gen_patch,
        validation=val_result,
    )


@app.post("/agent/apply-patch", response_model=ApplyPatchResponse)
async def apply_patch_endpoint(request: ApplyPatchRequest) -> ApplyPatchResponse:
    workspace_mgr = WorkspaceManager()
    try:
        resolved_ws = workspace_mgr.resolve_repository_path(request.repository_path)
    except WorkspaceSecurityError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))

    from .patch.applier import PatchApplier

    applier = PatchApplier(resolved_ws)
    app_result = applier.apply_patch(request.diff)

    return ApplyPatchResponse(
        job_id=request.job_id,
        result=app_result,
    )


@app.post("/agent/repair-workflow", response_model=RepairWorkflowResponse)
async def repair_workflow_endpoint(request: RepairWorkflowRequest) -> RepairWorkflowResponse:
    workspace_mgr = WorkspaceManager()
    try:
        resolved_ws = workspace_mgr.resolve_repository_path(request.repository_path)
    except WorkspaceSecurityError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))

    from .graph import build_repair_graph

    graph = build_repair_graph(auto_apply=request.auto_apply)
    initial_state = {
        "job_id": request.job_id,
        "repository_path": str(resolved_ws),
        "timestamps": {},
        "agent_events": [],
    }

    try:
        final_state = await graph.ainvoke(initial_state)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Repair workflow failed: {str(e)}")

    baseline_raw = final_state.get("baseline_result", {})
    failures_raw = final_state.get("failures", [])

    failures_list = [
        FailureDetail(
            test_name=f.get("test_name", "unknown"),
            file=f.get("file", ""),
            error_type=f.get("error_type", "Error"),
            message=f.get("message", ""),
            traceback=f.get("traceback", ""),
            source_reference=f.get("source_reference"),
        )
        for f in failures_raw
    ]

    baseline_metrics = BaselineMetrics(
        total=baseline_raw.get("total", 0),
        passed=baseline_raw.get("passed", 0),
        failed=baseline_raw.get("failed", 0),
        skipped=baseline_raw.get("skipped", 0),
        errors=baseline_raw.get("errors", 0),
        duration=baseline_raw.get("duration", 0.0),
        exit_code=baseline_raw.get("exit_code", 0),
        status=baseline_raw.get("status", "completed"),
    )

    rc_data = final_state.get("root_cause_analysis")
    plan_data = final_state.get("patch_plan")
    patch_data = final_state.get("generated_patch")
    val_data = final_state.get("patch_validation")
    app_data = final_state.get("patch_application")

    return RepairWorkflowResponse(
        job_id=request.job_id,
        status="patch_generated" if not request.auto_apply else "patch_applied",
        repository=RepositoryInfo(
            language=final_state.get("language", "python"),
            test_framework=final_state.get("test_framework", "pytest"),
            test_command=final_state.get("test_command", "pytest"),
        ),
        baseline=baseline_metrics,
        failures=failures_list,
        root_cause=RootCauseAnalysis.model_validate(rc_data) if rc_data else None,
        patch_plan=PatchPlan.model_validate(plan_data) if plan_data else None,
        generated_patch=GeneratedPatch.model_validate(patch_data) if patch_data else None,
        validation=PatchValidationResult.model_validate(val_data) if val_data else None,
        application=PatchApplicationResult.model_validate(app_data) if app_data else None,
        agent_events=final_state.get("agent_events", []),
    )


class SelfCorrectionRequest(BaseModel):
    job_id: str
    repository_path: str
    language: str | None = None
    test_command: str | None = None
    issue: str | None = None
    max_attempts: int = 3
    max_repair_time: float = 600.0
    max_llm_calls: int = 10


class SelfCorrectionResponse(BaseModel):
    job_id: str
    status: str
    is_verified: bool
    attempt_count: int
    final_status: str
    verification_result: dict[str, Any] | None = None
    attempt_history: list[dict[str, Any]] = Field(default_factory=list)
    agent_events: list[dict[str, Any]] = Field(default_factory=list)



class CancelJobRequest(BaseModel):
    job_id: str
    reason: str | None = None


class CancelJobResponse(BaseModel):
    job_id: str
    status: str
    cancelled: bool
    detail: str


@app.post("/agent/cancel", response_model=CancelJobResponse)
async def cancel_job_endpoint(request: CancelJobRequest) -> CancelJobResponse:
    """
    Idempotently cancel an active repair job, terminating active subprocesses/containers.
    """
    record = await global_lifecycle_manager.cancel_job(
        request.job_id,
        reason=request.reason or "Cancelled by user request",
    )
    return CancelJobResponse(
        job_id=request.job_id,
        status=record.state.value,
        cancelled=(record.state == JobState.CANCELLED),
        detail=f"Job '{request.job_id}' is in state {record.state.value}.",
    )


@app.post("/agent/reconcile")
async def reconcile_agent_endpoint() -> dict[str, Any]:
    """
    Reconcile running jobs and clean up orphaned Docker containers on startup or recovery.
    """
    return await global_lifecycle_manager.reconcile_startup_state()


@app.get("/agent/jobs/{job_id}/lifecycle")
async def get_job_lifecycle(job_id: str) -> dict[str, Any]:
    """Retrieve the lifecycle state machine history and metadata for a repair job."""
    record = global_lifecycle_manager.get_job(job_id)
    if not record:
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found in lifecycle registry.")
    return {
        "job_id": record.job_id,
        "state": record.state.value,
        "created_at": record.created_at,
        "started_at": record.started_at,
        "completed_at": record.completed_at,
        "history": record.history,
        "metadata": record.metadata,
    }


@app.get("/agent/jobs/active")
async def get_active_jobs() -> dict[str, Any]:
    """Retrieve currently active executing repair jobs and concurrency metrics."""
    return {
        "active_count": global_lifecycle_manager.get_active_count(),
        "max_concurrent": global_lifecycle_manager.max_concurrent_jobs,
        "active_jobs": [
            {
                "job_id": j.job_id,
                "state": j.state.value,
                "started_at": j.started_at,
            }
            for j in global_lifecycle_manager._jobs.values()
            if j.state in (JobState.RUNNING, JobState.VERIFYING)
        ],
    }


@app.post("/agent/self-correction", response_model=SelfCorrectionResponse)
async def self_correction_loop(request: SelfCorrectionRequest) -> SelfCorrectionResponse:
    """
    Executes the complete Milestone 5 autonomous self-correction repair loop:
    Detect -> Analyze -> Patch -> Apply -> Execute -> Observe -> Refine -> Retry -> Verify.
    Guarantees concurrency bounds, state machine transitions, and safe cancellation.
    """
    workspace_mgr = WorkspaceManager()
    try:
        resolved_ws = workspace_mgr.resolve_repository_path(request.repository_path)
    except WorkspaceSecurityError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))

    # Guard: Register and start job in lifecycle state machine
    await global_lifecycle_manager.start_job(
        job_id=request.job_id,
        metadata={"repository_path": str(resolved_ws), "issue": request.issue},
    )

    from .graph.builder import build_self_correction_graph

    graph = build_self_correction_graph()
    initial_state = {
        "job_id": request.job_id,
        "repository_path": str(resolved_ws),
        "explicit_language": request.language,
        "test_command": request.test_command,
        "issue": request.issue,
        "attempt_number": 1,
        "max_attempts": request.max_attempts,
        "max_repair_time": request.max_repair_time,
        "max_llm_calls": request.max_llm_calls,
        "repair_started_at": datetime.now(timezone.utc).isoformat(),
        "total_llm_calls": 0,
        "attempt_history": [],
        "agent_events": [
            {
                "event": "REPAIR_STARTED",
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "maxAttempts": request.max_attempts,
            }
        ],
        "timestamps": {},
    }

    try:
        final_state = await graph.ainvoke(initial_state)
    except (LLMConfigurationError, LLMAuthenticationError, LLMRequestFailedError, PatchGenerationError):
        try:
            await global_lifecycle_manager.transition(request.job_id, JobState.FAILED)
        except Exception:
            pass
        raise
    except asyncio.CancelledError:
        try:
            await global_lifecycle_manager.cancel_job(request.job_id)
        except Exception:
            pass
        raise
    except Exception as e:
        try:
            await global_lifecycle_manager.transition(request.job_id, JobState.FAILED)
        except Exception:
            pass
        err_msg = sanitize_text(str(e))
        if "LLM_CONFIGURATION_ERROR" in err_msg:
            raise HTTPException(status_code=400, detail=err_msg)
        if "LLM_AUTHENTICATION_ERROR" in err_msg:
            raise HTTPException(status_code=401, detail=err_msg)
        if "LLM_REQUEST_FAILED" in err_msg:
            raise HTTPException(status_code=502, detail=err_msg)
        if "PATCH_GENERATION_FAILED" in err_msg:
            raise HTTPException(status_code=422, detail=err_msg)
        raise HTTPException(status_code=500, detail=f"Self-correction loop error: {err_msg}")

    history = final_state.get("attempt_history", [])
    final_status = final_state.get("final_status", "FAILED")
    is_verified = final_state.get("is_verified", False)

    # Transition lifecycle based on verified result
    try:
        if is_verified:
            await global_lifecycle_manager.transition(request.job_id, JobState.SUCCEEDED)
        elif final_status == "TIMEOUT":
            await global_lifecycle_manager.transition(request.job_id, JobState.TIMED_OUT)
        else:
            await global_lifecycle_manager.transition(request.job_id, JobState.FAILED)
    except LateCallbackIgnoredError:
        # If job was cancelled concurrently, preserve CANCELLED state!
        pass
    except Exception:
        pass

    # Read latest state from lifecycle manager
    current_rec = global_lifecycle_manager.get_job(request.job_id)
    if current_rec and current_rec.state == JobState.CANCELLED:
        reported_status = "CANCELLED"
    elif is_verified:
        reported_status = "VERIFIED"
    else:
        reported_status = current_rec.state.value if current_rec else final_status

    return SelfCorrectionResponse(
        job_id=request.job_id,
        status=reported_status,
        is_verified=is_verified if reported_status != "CANCELLED" else False,
        attempt_count=len(history) if history else 1,
        final_status=reported_status,
        verification_result=final_state.get("verification_result"),
        attempt_history=history,
        agent_events=final_state.get("agent_events", []),
    )


class VerifyRequest(BaseModel):
    job_id: str
    repository_path: str
    test_command: str = "pytest"
    test_framework: str = "pytest"
    baseline_failed: int = 0
    baseline_failure_sigs: list[dict[str, Any]] = Field(default_factory=list)


@app.post("/agent/verify")
async def verify_repository(request: VerifyRequest) -> dict[str, Any]:
    """
    Executes repository test suite inside Docker sandbox (or configured runner) and parses result.
    """
    workspace_mgr = WorkspaceManager()
    try:
        resolved_ws = workspace_mgr.resolve_repository_path(request.repository_path)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    from app.parser import PytestOutputParser, UnittestOutputParser

    runner = get_execution_runner()
    exec_result = await runner.run(
        command=request.test_command,
        cwd=resolved_ws,
        timeout=120.0,
        job_id=request.job_id,
    )
    duration = exec_result.duration

    if request.test_framework == "unittest":
        parse_result = UnittestOutputParser.parse(
            stdout=exec_result.stdout,
            stderr=exec_result.stderr,
            exit_code=exec_result.exit_code,
            duration=duration,
            command=request.test_command,
        )
    else:
        parse_result = PytestOutputParser.parse(
            stdout=exec_result.stdout,
            stderr=exec_result.stderr,
            exit_code=exec_result.exit_code,
            duration=duration,
            command=request.test_command,
        )

    post_failures = [f.to_dict() if hasattr(f, "to_dict") else f for f in parse_result.failures]


    from app.verification.policy import VerificationPolicy
    eval_res = VerificationPolicy.evaluate(
        exec_exit_code=exec_result.exit_code,
        exec_timed_out=exec_result.timed_out,
        parse_total=parse_result.total,
        parse_passed=parse_result.passed,
        parse_failed=parse_result.failed,
        parse_skipped=parse_result.skipped,
        parse_errors=parse_result.errors,
        post_failures=post_failures,
        baseline_failures=request.baseline_failure_sigs,
        stdout=exec_result.stdout,
        stderr=exec_result.stderr,
    )

    return {
        "status": eval_res.status,
        "is_verified": eval_res.is_verified,
        "exit_code": exec_result.exit_code,
        "passed": parse_result.passed,
        "failed": parse_result.failed,
        "skipped": parse_result.skipped,
        "total": parse_result.total,
        "stdout": exec_result.stdout,
        "stderr": exec_result.stderr,
        "duration": duration,
        "timed_out": exec_result.timed_out,
        "regression_detected": eval_res.regression_detected,
        "failure_signatures": post_failures,
        "new_failures": eval_res.new_failures,
        "resolved_failures": eval_res.resolved_failures,
    }


class BenchmarkRunRequest(BaseModel):
    fixture_ids: list[str] | None = None
    timeout: float = 60.0
    execution_mode: str = "golden_validation"


class BenchmarkCompareRequest(BaseModel):
    base_report: dict[str, Any]
    target_report: dict[str, Any]


@app.get("/benchmark/fixtures")
async def list_benchmark_fixtures() -> list[dict[str, Any]]:
    """List all registered benchmark fixtures with metadata."""
    from app.benchmark import list_fixtures
    return [f.model_dump() for f in list_fixtures()]


@app.post("/benchmark/run")
async def run_benchmark(request: BenchmarkRunRequest) -> dict[str, Any]:
    """Execute reproducible repair benchmarks across isolated workspaces."""
    from app.benchmark import BenchmarkRunner, list_fixtures, get_fixture

    if request.fixture_ids:
        fixtures_to_run = [get_fixture(fid) for fid in request.fixture_ids if get_fixture(fid)]
    else:
        fixtures_to_run = list_fixtures()

    runner = BenchmarkRunner(
        timeout_seconds=request.timeout,
        execution_mode=request.execution_mode,
    )
    report = await runner.run_all(fixtures=fixtures_to_run)
    return report.model_dump()


@app.post("/benchmark/compare")
async def compare_benchmarks(request: BenchmarkCompareRequest) -> dict[str, Any]:
    """Compare two benchmark reports and compute metric deltas and regressions."""
    from app.benchmark import BenchmarkReport, compare_benchmark_reports

    base = BenchmarkReport.model_validate(request.base_report)
    target = BenchmarkReport.model_validate(request.target_report)
    comparison = compare_benchmark_reports(base, target)
    return comparison.model_dump()


class LiveBenchmarkRunRequest(BaseModel):
    case_ids: list[str] | None = None
    timeout: float = 60.0
    execution_mode: str = "dry_run"  # "live_repair", "dry_run", or "offline_test"
    model: str | None = None


@app.get("/benchmark/live/cases")
async def list_live_benchmark_cases() -> list[dict[str, Any]]:
    """List all registered live unseen benchmark cases with test suites."""
    from app.benchmark import list_live_cases
    return [c.manifest for c in list_live_cases()]


@app.post("/benchmark/live/run")
async def run_live_benchmark(request: LiveBenchmarkRunRequest) -> dict[str, Any]:
    """Execute live repair accuracy benchmark across isolated temporary workspaces."""
    from app.benchmark import LiveBenchmarkRunner, get_live_case, list_live_cases

    if request.case_ids:
        cases_to_run = [get_live_case(cid) for cid in request.case_ids if get_live_case(cid)]
    else:
        cases_to_run = list_live_cases()

    runner = LiveBenchmarkRunner(
        timeout_seconds=request.timeout,
        execution_mode=request.execution_mode,
        model=request.model,
    )
    report = await runner.run_all(cases=cases_to_run)
    return report.model_dump()