"""
Execution backend and job lifecycle controller for FixForge Sandbox Worker.
Controls rootless container execution with guaranteed cleanup, idempotency, and fail-closed security.
"""

from abc import ABC, abstractmethod
import asyncio
import hashlib
import json
import os
from pathlib import Path
import shutil
import time
from typing import Any
import uuid

from .schemas import JobExecutionRequest, JobExecutionResponse, ResourceLimits, VerificationSummary
from .security import filter_safe_env, safe_extract_archive, sanitize_text
from .verification import evaluate_verification


class BackendUnavailableError(Exception):
    """Raised when the rootless container execution backend is unavailable."""
    pass


class IdempotencyConflictError(Exception):
    """Raised when an idempotency key is reused with a conflicting payload."""
    pass


class WorkerExecutionBackend(ABC):
    """Abstract contract for isolated execution backends."""

    @abstractmethod
    async def execute_job(
        self,
        job_id: str,
        command: str,
        workspace_path: Path,
        timeout: float,
        env: dict[str, str],
        limits: ResourceLimits,
        network: bool,
    ) -> dict[str, Any]:
        """Execute command inside isolated environment."""
        pass

    @abstractmethod
    async def cancel_job(self, job_id: str) -> bool:
        """Cancel an active execution."""
        pass

    @abstractmethod
    async def check_health(self) -> tuple[bool, str, dict[str, Any]]:
        """Return (is_available, status_string, details_dict)."""
        pass

    @abstractmethod
    async def reconcile_orphans(self) -> list[str]:
        """Clean up orphaned containers."""
        pass


class RootlessDockerBackend(WorkerExecutionBackend):
    """
    Dedicated rootless Docker daemon backend.
    Connects to the worker's private rootless Docker daemon via UNIX socket or DOCKER_HOST.
    CRITICAL: Does NOT touch the host Docker daemon or /var/run/docker.sock.
    """

    def __init__(self, socket_path: str = "/run/user/1000/docker.sock", image_name: str = "fixforge-sandbox:latest"):
        self.socket_path = os.environ.get("ROOTLESS_DOCKER_SOCKET", socket_path)
        self.image_name = image_name
        self._active_containers: dict[str, dict[str, Any]] = {}
        self._lock = asyncio.Lock()

    async def is_available(self) -> tuple[bool, str | None]:
        docker_bin = shutil.which("docker")
        if not docker_bin:
            return False, "Docker CLI executable not found in worker PATH."

        # Verify rootless socket or DOCKER_HOST
        docker_host = os.environ.get("DOCKER_HOST")
        if not docker_host and os.path.exists(self.socket_path):
            docker_host = f"unix://{self.socket_path}"

        env = os.environ.copy()
        if docker_host:
            env["DOCKER_HOST"] = docker_host

        try:
            proc = await asyncio.create_subprocess_exec(
                "docker",
                "version",
                "--format",
                "{{.Server.Version}}",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=4.0)
            if proc.returncode == 0:
                ver = stdout.decode().strip() or "rootless-available"
                return True, ver
            err = stderr.decode().strip() or "Rootless daemon not responding."
            return False, err
        except Exception as e:
            return False, str(e)

    async def check_health(self) -> tuple[bool, str, dict[str, Any]]:
        avail, detail = await self.is_available()
        return avail, "healthy" if avail else "unavailable", {
            "backend": "rootless_docker",
            "socket": self.socket_path,
            "image": self.image_name,
            "detail": detail or "Daemon is responding.",
        }

    async def execute_job(
        self,
        job_id: str,
        command: str,
        workspace_path: Path,
        timeout: float,
        env: dict[str, str],
        limits: ResourceLimits,
        network: bool,
    ) -> dict[str, Any]:
        avail, detail = await self.is_available()
        if not avail:
            raise BackendUnavailableError(
                f"Isolated rootless Docker daemon is not available: {detail}. Failing closed."
            )

        container_name = f"fixforge-worker-{job_id[:16]}-{uuid.uuid4().hex[:8]}"
        docker_host = os.environ.get("DOCKER_HOST")
        if not docker_host and os.path.exists(self.socket_path):
            docker_host = f"unix://{self.socket_path}"

        proc_env = os.environ.copy()
        if docker_host:
            proc_env["DOCKER_HOST"] = docker_host

        network_mode = "bridge" if network else "none"

        args = [
            "docker",
            "run",
            "--name",
            container_name,
            "--rm",
            "--user",
            "1000:1000",
            "--network",
            network_mode,
            "--memory",
            limits.memory,
            "--cpus",
            limits.cpus,
            "--pids-limit",
            str(limits.pids),
            "--security-opt",
            "no-new-privileges:true",
            "--cap-drop",
            "ALL",
            "--read-only",
            "--tmpfs",
            "/tmp:rw,noexec,nosuid,size=64m",
            "-v",
            f"{str(workspace_path.resolve())}:/workspace:rw",
            "-w",
            "/workspace",
        ]

        safe_env = filter_safe_env(env)
        for k, v in safe_env.items():
            args.extend(["-e", f"{k}={v}"])

        args.append(self.image_name)
        args.extend(["sh", "-c", command])

        start = time.perf_counter()
        timed_out = False
        cancelled = False
        stdout_str = ""
        stderr_str = ""
        exit_code = 0
        status = "completed"

        proc = None
        container_entry = {"proc": None, "container": container_name, "cancelled": False}
        async with self._lock:
            self._active_containers[job_id] = container_entry

        try:
            proc = await asyncio.create_subprocess_exec(
                args[0],
                *args[1:],
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=proc_env,
            )
            container_entry["proc"] = proc

            out_bytes, err_bytes = await asyncio.wait_for(
                proc.communicate(),
                timeout=timeout,
            )
            duration = round(time.perf_counter() - start, 3)
            exit_code = proc.returncode if proc.returncode is not None else 0

            if container_entry.get("cancelled"):
                cancelled = True
                status = "cancelled"
                exit_code = -1
                stderr_str = "Execution cancelled by worker request."
            else:
                status = "completed" if exit_code == 0 else "failed"
                stdout_str = out_bytes.decode("utf-8", errors="replace")
                stderr_str = err_bytes.decode("utf-8", errors="replace")

        except asyncio.TimeoutError:
            timed_out = True
            duration = round(time.perf_counter() - start, 3)
            exit_code = -1
            status = "timeout"
            stderr_str = f"Execution timed out after {timeout} seconds."
            if proc:
                try:
                    proc.kill()
                except Exception:
                    pass

        except Exception as exc:
            duration = round(time.perf_counter() - start, 3)
            if container_entry.get("cancelled"):
                cancelled = True
                status = "cancelled"
                exit_code = -1
                stderr_str = "Execution cancelled by worker request."
            else:
                exit_code = -1
                status = "error"
                stderr_str = f"Sandbox execution error: {exc}"

        finally:
            async with self._lock:
                self._active_containers.pop(job_id, None)

            # Cleanup container
            try:
                rm_p = await asyncio.create_subprocess_exec(
                    "docker", "rm", "-f", container_name,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                    env=proc_env,
                )
                await asyncio.wait_for(rm_p.wait(), timeout=5.0)
            except Exception:
                pass

        return {
            "status": status,
            "exit_code": exit_code,
            "stdout": stdout_str,
            "stderr": stderr_str,
            "duration": duration,
            "timed_out": timed_out,
            "cancelled": cancelled,
        }

    async def cancel_job(self, job_id: str) -> bool:
        async with self._lock:
            entry = self._active_containers.get(job_id)
            if not entry:
                return False
            entry["cancelled"] = True

        proc = entry.get("proc")
        container = entry.get("container")
        if proc:
            try:
                proc.kill()
            except Exception:
                pass

        if container:
            try:
                rm_p = await asyncio.create_subprocess_exec(
                    "docker", "rm", "-f", container,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                await asyncio.wait_for(rm_p.wait(), timeout=5.0)
            except Exception:
                pass
        return True

    async def reconcile_orphans(self) -> list[str]:
        cleaned = []
        try:
            proc = await asyncio.create_subprocess_exec(
                "docker", "ps", "-a", "--filter", "name=fixforge-worker-", "--format", "{{.Names}}",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5.0)
            if proc.returncode == 0:
                for name in stdout.decode().splitlines():
                    name = name.strip()
                    if name:
                        rm_p = await asyncio.create_subprocess_exec(
                            "docker", "rm", "-f", name,
                            stdout=asyncio.subprocess.DEVNULL,
                            stderr=asyncio.subprocess.DEVNULL,
                        )
                        await asyncio.wait_for(rm_p.wait(), timeout=5.0)
                        cleaned.append(name)
        except Exception:
            pass
        return cleaned


class JobManager:
    """
    Centralized controller for worker job execution, concurrency, and idempotency.
    """

    def __init__(self, backend: WorkerExecutionBackend | None = None, base_workspace_dir: Path | None = None):
        self.backend = backend or RootlessDockerBackend()
        self.base_workspace_dir = (
            base_workspace_dir or Path(os.environ.get("WORKER_WORKSPACES_DIR", "/app/workspaces"))
        ).resolve()
        self.base_workspace_dir.mkdir(parents=True, exist_ok=True)
        self._active_jobs: dict[str, dict[str, Any]] = {}
        self._idempotency_cache: dict[str, dict[str, Any]] = {}
        self._lock = asyncio.Lock()

    def _compute_payload_hash(self, req: JobExecutionRequest) -> str:
        data = {
            "job_id": req.job_id,
            "command": req.command,
            "timeout_seconds": req.timeout_seconds,
            "workspace_id": req.workspace_id,
            "archive_hash": hashlib.sha256(req.workspace_archive.encode()).hexdigest() if req.workspace_archive else None,
            "env": req.environment,
            "limits": req.resource_limits.model_dump(),
            "network": req.network,
        }
        return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()

    async def execute(self, req: JobExecutionRequest) -> JobExecutionResponse:
        payload_hash = self._compute_payload_hash(req)

        # Check idempotency cache
        async with self._lock:
            cached = self._idempotency_cache.get(req.idempotency_key)
            if cached:
                if cached["payload_hash"] != payload_hash:
                    raise IdempotencyConflictError(
                        f"Idempotency key '{req.idempotency_key}' was previously used with a different request payload."
                    )
                # Return cached response if job completed
                if "response" in cached:
                    return cached["response"]

            # Prevent duplicate concurrent executions
            if req.job_id in self._active_jobs:
                raise IdempotencyConflictError(
                    f"Job '{req.job_id}' is currently executing."
                )

            # Register active job
            job_record = {
                "job_id": req.job_id,
                "idempotency_key": req.idempotency_key,
                "payload_hash": payload_hash,
                "started_at": time.time(),
            }
            self._active_jobs[req.job_id] = job_record
            self._idempotency_cache[req.idempotency_key] = {
                "job_id": req.job_id,
                "payload_hash": payload_hash,
            }

        job_dir = (self.base_workspace_dir / req.job_id).resolve()
        # Enforce that job_dir is strictly inside base_workspace_dir
        try:
            job_dir.relative_to(self.base_workspace_dir)
        except ValueError:
            async with self._lock:
                self._active_jobs.pop(req.job_id, None)
                self._idempotency_cache.pop(req.idempotency_key, None)
            raise ValueError("Invalid job_id: directory escape detected.")

        try:
            # Stage workspace
            if req.workspace_archive:
                import base64
                try:
                    archive_bytes = base64.b64decode(req.workspace_archive)
                except Exception as b64_err:
                    raise ValueError(f"Invalid base64 encoding in workspace_archive: {b64_err}")
                safe_extract_archive(archive_bytes, job_dir)
            elif req.workspace_id:
                source_dir = (self.base_workspace_dir / req.workspace_id).resolve()
                if not source_dir.exists() or not source_dir.is_dir():
                    raise ValueError(f"Workspace with id '{req.workspace_id}' does not exist.")
                shutil.copytree(source_dir, job_dir, dirs_exist_ok=True)

            # Ensure container sandboxuser (UID 1000) has write access to workspace
            try:
                job_dir.chmod(0o777)
                for root, dirs, files in os.walk(str(job_dir)):
                    for d in dirs:
                        try:
                            os.chmod(os.path.join(root, d), 0o777)
                        except OSError:
                            pass
                    for f in files:
                        try:
                            os.chmod(os.path.join(root, f), 0o666)
                        except OSError:
                            pass
            except Exception:
                pass

            # Delegate to isolated backend
            exec_res = await self.backend.execute_job(
                job_id=req.job_id,
                command=req.command,
                workspace_path=job_dir,
                timeout=req.timeout_seconds,
                env=req.environment,
                limits=req.resource_limits,
                network=req.network,
            )

            # Evaluate verification policy
            verification = evaluate_verification(
                exit_code=exec_res["exit_code"],
                timed_out=exec_res["timed_out"],
                cancelled=exec_res["cancelled"],
                stdout=exec_res["stdout"],
                stderr=exec_res["stderr"],
            )

            response = JobExecutionResponse(
                job_id=req.job_id,
                idempotency_key=req.idempotency_key,
                status=exec_res["status"],
                exit_code=exec_res["exit_code"],
                stdout=exec_res["stdout"],
                stderr=exec_res["stderr"],
                duration=exec_res["duration"],
                timed_out=exec_res["timed_out"],
                cancelled=exec_res["cancelled"],
                sandboxed=True,
                worker_id="sandbox-worker-01",
                verification=verification,
            )

            async with self._lock:
                self._idempotency_cache[req.idempotency_key]["response"] = response
            return response

        finally:
            async with self._lock:
                self._active_jobs.pop(req.job_id, None)

            # Safe cleanup of ephemeral workspace directory
            try:
                if job_dir.exists():
                    shutil.rmtree(job_dir, ignore_errors=True)
            except Exception:
                pass

    async def cancel(self, job_id: str) -> bool:
        async with self._lock:
            active = job_id in self._active_jobs
        backend_cancelled = await self.backend.cancel_job(job_id)
        return active or backend_cancelled

    async def reconcile(self) -> dict[str, Any]:
        cleaned = await self.backend.reconcile_orphans()
        reaped_workspaces = []
        try:
            for item in self.base_workspace_dir.iterdir():
                if item.is_dir() and item.name not in self._active_jobs:
                    shutil.rmtree(item, ignore_errors=True)
                    reaped_workspaces.append(item.name)
        except Exception:
            pass
        return {
            "cleaned_containers": cleaned,
            "reaped_workspaces": reaped_workspaces,
            "active_jobs": len(self._active_jobs),
        }
