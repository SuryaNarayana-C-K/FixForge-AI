"""
Docker Sandbox Execution Runner implementation for FixForge.
Executes test and analysis commands inside isolated, non-root Docker containers with strict resource and network boundaries.
"""

import asyncio
import os
from pathlib import Path
import shutil
import time
from typing import Any
from app.runner import ExecutionResult, ExecutionRunner
from app.sandbox.config import SandboxConfig
from app.sandbox.errors import SandboxUnavailable, SandboxWorkspaceViolation
from app.sandbox.lifecycle import (
    build_docker_run_args,
    cleanup_container,
    generate_container_name,
    register_active_container,
    truncate_output,
)
from app.sandbox.security import sanitize_command, validate_sandbox_workspace


# Registry of actively running jobs: job_id -> {"container": str, "proc": Process, "cancelled": bool}
_RUNNING_SANDBOX_JOBS: dict[str, dict[str, Any]] = {}


class DockerSandboxRunner(ExecutionRunner):
    """
    Executes commands inside an isolated Docker container with strict boundaries,
    guaranteed cancellation, and fail-closed security.
    """

    def __init__(self, config: SandboxConfig | None = None, base_dir: Path | None = None):
        self.config = config or SandboxConfig.from_env()
        self.base_dir = base_dir

    @classmethod
    async def cancel_job(cls, job_id: str) -> bool:
        """
        Idempotently cancel an active Docker sandbox execution.
        Terminates the host docker process and forcefully removes the container.
        """
        job_info = _RUNNING_SANDBOX_JOBS.get(job_id)
        if not job_info:
            return False

        job_info["cancelled"] = True
        proc = job_info.get("proc")
        container_name = job_info.get("container")

        if proc:
            try:
                proc.kill()
            except Exception:
                pass

        if container_name:
            await cleanup_container(container_name)

        return True

    @staticmethod
    async def is_docker_available() -> tuple[bool, str | None, str | None]:
        """
        Check if the Docker CLI is installed and the Docker daemon is responding.
        Returns: (is_available, version_string, error_detail)
        """
        docker_bin = shutil.which("docker")
        if not docker_bin:
            return False, None, "Docker CLI executable not found in PATH."

        try:
            proc = await asyncio.create_subprocess_exec(
                "docker",
                "version",
                "--format",
                "{{.Server.Version}}",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=5.0)
            if proc.returncode == 0:
                ver = stdout.decode().strip() or "available"
                return True, ver, None
            else:
                err = stderr.decode().strip() or "Docker daemon not responding."
                return False, None, err
        except asyncio.TimeoutError:
            return False, None, "Docker version check timed out."
        except Exception as e:
            return False, None, str(e)

    async def check_health(self) -> dict[str, Any]:
        """Health check payload for GET /sandbox/health."""
        available, version, detail = await self.is_docker_available()
        return {
            "docker_available": available,
            "runner": "docker",
            "version": version,
            "image": self.config.image_name,
            "detail": detail or "Docker daemon is operational.",
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
        Execute command inside an isolated Docker container with guaranteed cleanup.
        Fails closed in production if Docker is unavailable.
        """
        # Validate workspace path security
        validated_workspace = validate_sandbox_workspace(cwd, base_dir=self.base_dir)

        # Sanitize command
        clean_command = sanitize_command(command)

        # Enforce configured timeout if tighter
        effective_timeout = min(timeout, self.config.timeout_seconds)

        # Check Docker availability
        available, _, err_detail = await self.is_docker_available()
        if not available:
            allow_local = (
                self.config.allow_local_subprocess
                or os.environ.get("ALLOW_LOCAL_SUBPROCESS", "false").strip().lower() in ("true", "1", "yes")
            )
            if allow_local:
                from app.runner import LocalExecutionRunner
                fallback = LocalExecutionRunner(runner_label="local_dev_fallback")
                return await fallback.run(
                    command=command,
                    cwd=cwd,
                    timeout=timeout,
                    env=env,
                    job_id=job_id,
                )
            raise SandboxUnavailable(
                f"Docker daemon or CLI is not available: {err_detail}. "
                "Failing closed in production mode. Local subprocess execution is prohibited "
                "unless ALLOW_LOCAL_SUBPROCESS=true is explicitly configured."
            )

        container_name = generate_container_name(job_id)
        register_active_container(container_name)
        run_args = build_docker_run_args(
            container_name=container_name,
            command=clean_command,
            workspace_path=validated_workspace,
            config=self.config,
            extra_env=env,
        )

        start_time = time.perf_counter()
        timed_out = False
        cancelled = False
        stdout_str = ""
        stderr_str = ""
        exit_code = 0
        status = "completed"

        proc = None
        job_info = {"container": container_name, "proc": None, "cancelled": False}
        _RUNNING_SANDBOX_JOBS[job_id] = job_info

        try:
            proc = await asyncio.create_subprocess_exec(
                run_args[0],
                *run_args[1:],
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            job_info["proc"] = proc

            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                proc.communicate(),
                timeout=effective_timeout,
            )
            duration = round(time.perf_counter() - start_time, 2)
            exit_code = proc.returncode if proc.returncode is not None else 0

            if job_info.get("cancelled"):
                cancelled = True
                status = "cancelled"
                exit_code = -1
                stderr_str = "Execution was cancelled by request."
            else:
                status = "completed" if exit_code == 0 else "failed"
                raw_out = stdout_bytes.decode("utf-8", errors="replace")
                raw_err = stderr_bytes.decode("utf-8", errors="replace")
                stdout_str = truncate_output(raw_out, self.config.output_limit_bytes)
                stderr_str = truncate_output(raw_err, self.config.output_limit_bytes)

        except asyncio.TimeoutError:
            timed_out = True
            duration = round(time.perf_counter() - start_time, 2)
            exit_code = -1
            status = "timeout"
            stderr_str = f"Execution timed out after {effective_timeout} seconds."

            # Kill local docker CLI process if still running
            if proc:
                try:
                    res = proc.kill()
                    if asyncio.iscoroutine(res):
                        await res
                except Exception:
                    pass

        except Exception as exc:
            duration = round(time.perf_counter() - start_time, 2)
            if job_info.get("cancelled"):
                cancelled = True
                status = "cancelled"
                exit_code = -1
                stderr_str = "Execution was cancelled by request."
            else:
                exit_code = -1
                status = "failed"
                stderr_str = f"Sandbox execution error: {exc}"

        finally:
            _RUNNING_SANDBOX_JOBS.pop(job_id, None)
            # Critical guarantee: forcefully stop and remove container
            await cleanup_container(container_name)

        return ExecutionResult(
            command=command,
            exit_code=exit_code,
            stdout=stdout_str,
            stderr=stderr_str,
            duration=duration,
            timed_out=timed_out,
            cancelled=cancelled,
            status=status,
            container_id=container_name,
            sandboxed=True,
            runner="docker",
        )
