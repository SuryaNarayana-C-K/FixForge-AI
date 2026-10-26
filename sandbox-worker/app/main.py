"""
FixForge Isolated Sandbox Worker FastAPI Application.
Exposes a bounded, authenticated execution API (never raw Docker Engine endpoints).
"""

import logging
import os
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from .executor import BackendUnavailableError, IdempotencyConflictError, JobManager, RootlessDockerBackend
from .schemas import (
    CancelJobResponse,
    HealthResponse,
    JobExecutionRequest,
    JobExecutionResponse,
    ReconcileResponse,
)
from .security import ArchiveSecurityError, sanitize_text, verify_worker_auth

logger = logging.getLogger("sandbox_worker")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

app = FastAPI(
    title="FixForge Isolated Sandbox Worker",
    description="Dedicated unprivileged worker for bounded container test execution.",
    version="1.0.0",
)

# Shared JobManager instance
job_manager = JobManager(backend=RootlessDockerBackend())


@app.middleware("http")
async def worker_security_middleware(request: Request, call_next):
    """
    Enforce worker authentication on all mutation and execution endpoints.
    Allows unauthenticated access only to public health checks and OpenAPI docs.
    """
    path = request.url.path.rstrip("/")
    if path in ("/v1/health", "/healthz", "/docs", "/openapi.json", "/redoc"):
        return await call_next(request)

    expected_key = os.environ.get("INTERNAL_WORKER_KEY", "").strip()
    if not expected_key:
        logger.error("INTERNAL_WORKER_KEY is not configured on sandbox worker.")
        return JSONResponse(
            status_code=500,
            content={
                "error": "Worker authentication misconfigured: INTERNAL_WORKER_KEY not set.",
                "code": "WORKER_AUTH_MISCONFIGURED",
            },
        )

    if not verify_worker_auth(request, expected_key):
        logger.warning("Rejected unauthorized worker request.")
        return JSONResponse(
            status_code=401,
            content={
                "error": "Unauthorized worker request: invalid or missing worker credentials.",
                "code": "UNAUTHORIZED_WORKER",
            },
        )

    return await call_next(request)


@app.exception_handler(IdempotencyConflictError)
async def idempotency_conflict_handler(request: Request, exc: IdempotencyConflictError):
    return JSONResponse(
        status_code=409,
        content={"error": str(exc), "code": "IDEMPOTENCY_CONFLICT"},
    )


@app.exception_handler(ArchiveSecurityError)
async def archive_security_handler(request: Request, exc: ArchiveSecurityError):
    return JSONResponse(
        status_code=400,
        content={"error": sanitize_text(str(exc)), "code": "ARCHIVE_SECURITY_VIOLATION"},
    )


@app.exception_handler(BackendUnavailableError)
async def backend_unavailable_handler(request: Request, exc: BackendUnavailableError):
    return JSONResponse(
        status_code=503,
        content={"error": sanitize_text(str(exc)), "code": "SANDBOX_BACKEND_UNAVAILABLE"},
    )


@app.get("/v1/health", response_model=HealthResponse)
async def get_health():
    """Health check for worker service and isolated execution backend."""
    avail, status, details = await job_manager.backend.check_health()
    return HealthResponse(
        status=status,
        worker_id="sandbox-worker-01",
        backend_type=details.get("backend", "rootless_docker"),
        backend_available=avail,
        active_jobs=len(job_manager._active_jobs),
        detail=sanitize_text(details.get("detail", "")),
    )


@app.post("/v1/jobs/execute", response_model=JobExecutionResponse)
async def execute_job(req: JobExecutionRequest):
    """
    Execute a bounded test command inside the isolated sandbox container.
    """
    logger.info("Received job execution request for job '%s'", req.job_id)
    try:
        result = await job_manager.execute(req)
        return result
    except ValueError as val_err:
        raise HTTPException(
            status_code=400,
            detail={"error": sanitize_text(str(val_err)), "code": "INVALID_JOB_REQUEST"},
        )
    except Exception as exc:
        logger.error("Error executing job '%s': %s", req.job_id, sanitize_text(str(exc)))
        raise


@app.post("/v1/jobs/{job_id}/cancel", response_model=CancelJobResponse)
async def cancel_job(job_id: str):
    """
    Idempotently cancel an active or queued job.
    """
    cancelled = await job_manager.cancel(job_id)
    return CancelJobResponse(
        job_id=job_id,
        cancelled=cancelled,
        status="cancelled" if cancelled else "not_active",
        message="Job cancellation requested." if cancelled else "Job was not actively executing.",
    )


@app.post("/v1/reconcile", response_model=ReconcileResponse)
async def reconcile_orphans():
    """
    Reconcile and cleanup any orphaned containers or dangling workspaces.
    """
    res = await job_manager.reconcile()
    return ReconcileResponse(
        cleaned_containers=res["cleaned_containers"],
        reaped_workspaces=res["reaped_workspaces"],
        active_jobs=res["active_jobs"],
    )
