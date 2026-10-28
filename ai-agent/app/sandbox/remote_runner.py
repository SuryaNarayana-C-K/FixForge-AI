"""
Remote Sandbox Execution Runner for FixForge.
Delegates command execution to an isolated, unprivileged Sandbox Worker service.
Removes direct host Docker socket access from the AI Agent service completely.
"""

import asyncio
import base64
import io
import json
import os
from pathlib import Path
import tarfile
import time
from typing import Any
import urllib.request
import urllib.error

from app.runner import ExecutionResult, ExecutionRunner
from app.sandbox.config import SandboxConfig
from app.sandbox.errors import SandboxUnavailable, SandboxWorkspaceViolation
from app.sandbox.security import sanitize_command, validate_sandbox_workspace


# Registry of actively running jobs: job_id -> {"cancelled": bool}
_RUNNING_REMOTE_JOBS: dict[str, dict[str, Any]] = {}


def _create_workspace_archive(cwd: Path) -> str:
    """
    Create a base64-encoded tar.gz archive of the workspace directory.
    Excludes version control and cache artifacts to keep payload compact.
    """
    buf = io.BytesIO()
    ignore_dirs = {".git", ".pytest_cache", "__pycache__", "node_modules", ".venv", "venv"}

    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for root, dirs, files in os.walk(str(cwd)):
            dirs[:] = [d for d in dirs if d not in ignore_dirs]
            rel_root = os.path.relpath(root, str(cwd))
            for f in files:
                full_path = os.path.join(root, f)
                rel_path = f if rel_root == "." else os.path.join(rel_root, f)
                try:
                    tar.add(full_path, arcname=rel_path, recursive=False)
                except (OSError, PermissionError):
                    pass

    return base64.b64encode(buf.getvalue()).decode("ascii")


class RemoteSandboxRunner(ExecutionRunner):
    """
    Submits bounded execution jobs to a dedicated, unprivileged Sandbox Worker service.
    Enforces that the AI agent has zero Docker socket access and fails closed if
    the worker is unavailable.
    """

    def __init__(
        self,
        worker_url: str | None = None,
        worker_key: str | None = None,
        config: SandboxConfig | None = None,
        base_dir: Path | None = None,
    ):
        if worker_url is not None:
            self.worker_url = worker_url.strip().rstrip("/")
        else:
            self.worker_url = os.environ.get("SANDBOX_WORKER_URL", "http://fixforge-sandbox-worker:9000").strip().rstrip("/")

        if worker_key is not None:
            self.worker_key = worker_key.strip()
        else:
            self.worker_key = os.environ.get("INTERNAL_WORKER_KEY", "").strip()

        self.config = config or SandboxConfig.from_env()
        self.base_dir = base_dir

    def _ensure_configured(self) -> None:
        """Validate required remote worker configuration; fails closed if missing."""
        if not self.worker_url:
            raise SandboxUnavailable(
                "SANDBOX_WORKER_URL is not configured for RemoteSandboxRunner. "
                "Failing closed in secure production mode."
            )
        if not self.worker_key:
            raise SandboxUnavailable(
                "INTERNAL_WORKER_KEY is not configured for RemoteSandboxRunner. "
                "Failing closed in secure production mode."
            )

    @classmethod
    async def cancel_job(cls, job_id: str, worker_url: str | None = None, worker_key: str | None = None) -> bool:
        """
        Idempotently cancel an active job on the remote sandbox worker.
        """
        job_info = _RUNNING_REMOTE_JOBS.get(job_id)
        if job_info:
            job_info["cancelled"] = True

        url = (worker_url or os.environ.get("SANDBOX_WORKER_URL", "http://fixforge-sandbox-worker:9000")).rstrip("/")
        key = worker_key or os.environ.get("INTERNAL_WORKER_KEY", "").strip()
        if not key or not url:
            return False

        def _cancel_sync():
            try:
                req = urllib.request.Request(
                    f"{url}/v1/jobs/{job_id}/cancel",
                    method="POST",
                    headers={
                        "Content-Type": "application/json",
                        "x-worker-key": key,
                    },
                )
                with urllib.request.urlopen(req, timeout=5.0) as resp:
                    return resp.status == 200
            except Exception:
                return False

        return await asyncio.to_thread(_cancel_sync)

    async def check_health(self) -> dict[str, Any]:
        """Health check payload for GET /sandbox/health in remote mode."""
        try:
            self._ensure_configured()
        except SandboxUnavailable as e:
            return {
                "docker_available": False,
                "runner": "remote_sandbox",
                "version": None,
                "image": self.config.image_name,
                "detail": str(e),
            }

        def _ping_sync():
            try:
                req = urllib.request.Request(
                    f"{self.worker_url}/v1/health",
                    headers={"x-worker-key": self.worker_key},
                )
                with urllib.request.urlopen(req, timeout=4.0) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                    return data
            except Exception as ex:
                return {"status": "unhealthy", "backend_available": False, "detail": str(ex)}

        res = await asyncio.to_thread(_ping_sync)
        avail = bool(res.get("backend_available", False))
        return {
            "docker_available": avail,
            "runner": "docker",
            "version": res.get("backend_type", "rootless_docker"),
            "image": self.config.image_name,
            "detail": res.get("detail", "Remote rootless sandbox worker responding."),
        }

    async def run(
        self,
        command: str,
        cwd: Path,
        timeout: float = 120.0,
        env: dict[str, str] | None = None,
        job_id: str = "default",
    ) -> ExecutionResult:
        """
        Execute command on the remote sandbox worker.
        Fails closed if the worker is unavailable or misconfigured.
        Never falls back silently to local subprocess or host Docker socket.
        """
        self._ensure_configured()

        # Validate workspace path security
        validated_workspace = validate_sandbox_workspace(cwd, base_dir=self.base_dir)

        # Sanitize command
        clean_command = sanitize_command(command)

        effective_timeout = min(timeout, self.config.timeout_seconds)
        idempotency_key = f"exec-{job_id}-{int(time.time() * 1000)}"

        # Create workspace archive
        archive_b64 = await asyncio.to_thread(_create_workspace_archive, validated_workspace)

        payload = {
            "job_id": job_id,
            "idempotency_key": idempotency_key,
            "command": clean_command,
            "timeout_seconds": effective_timeout,
            "workspace_archive": archive_b64,
            "environment": env or {},
            "resource_limits": {
                "cpus": str(self.config.cpus_limit),
                "memory": str(self.config.memory_limit),
                "pids": int(self.config.pids_limit),
            },
            "network": False,
        }

        job_info = {"cancelled": False}
        _RUNNING_REMOTE_JOBS[job_id] = job_info

        def _send_request():
            req_data = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(
                f"{self.worker_url}/v1/jobs/execute",
                data=req_data,
                method="POST",
                headers={
                    "Content-Type": "application/json",
                    "x-worker-key": self.worker_key,
                    "x-request-id": idempotency_key,
                },
            )
            # Socket timeout must allow the execution timeout plus a grace window
            with urllib.request.urlopen(req, timeout=effective_timeout + 15.0) as resp:
                return json.loads(resp.read().decode("utf-8"))

        start_time = time.perf_counter()
        try:
            raw_res = await asyncio.to_thread(_send_request)
            duration = raw_res.get("duration", round(time.perf_counter() - start_time, 2))

            return ExecutionResult(
                command=command,
                exit_code=raw_res.get("exit_code", 0),
                stdout=raw_res.get("stdout", ""),
                stderr=raw_res.get("stderr", ""),
                duration=duration,
                timed_out=raw_res.get("timed_out", False),
                cancelled=raw_res.get("cancelled", False),
                status=raw_res.get("status", "completed"),
                container_id=raw_res.get("worker_id", "remote-sandbox-worker"),
                sandboxed=True,
                runner="remote_sandbox",
            )

        except urllib.error.HTTPError as http_err:
            duration = round(time.perf_counter() - start_time, 2)
            err_body = http_err.read().decode("utf-8", errors="replace")
            try:
                err_json = json.loads(err_body)
                err_detail = err_json.get("error") or err_json.get("detail") or err_body
            except Exception:
                err_detail = err_body

            if http_err.code == 401:
                raise SandboxUnavailable(
                    f"Remote sandbox worker authentication failed (401): {err_detail}."
                )
            elif http_err.code == 503:
                raise SandboxUnavailable(
                    f"Remote sandbox worker backend unavailable (503): {err_detail}."
                )
            else:
                return ExecutionResult(
                    command=command,
                    exit_code=-1,
                    stdout="",
                    stderr=f"Worker request failed with status {http_err.code}: {err_detail}",
                    duration=duration,
                    timed_out=False,
                    cancelled=job_info.get("cancelled", False),
                    status="error",
                    container_id=None,
                    sandboxed=True,
                    runner="remote_sandbox",
                )

        except (urllib.error.URLError, TimeoutError) as net_err:
            duration = round(time.perf_counter() - start_time, 2)
            if job_info.get("cancelled"):
                return ExecutionResult(
                    command=command,
                    exit_code=-1,
                    stdout="",
                    stderr="Execution was cancelled by request.",
                    duration=duration,
                    timed_out=False,
                    cancelled=True,
                    status="cancelled",
                    container_id=None,
                    sandboxed=True,
                    runner="remote_sandbox",
                )
            raise SandboxUnavailable(
                f"Failed to communicate with remote sandbox worker at {self.worker_url}: {net_err}. "
                "Failing closed in secure production mode."
            )

        finally:
            _RUNNING_REMOTE_JOBS.pop(job_id, None)
