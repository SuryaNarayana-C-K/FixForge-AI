import asyncio
import os
import signal
import sys
import time
from typing import Any
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path


@dataclass
class ExecutionResult:
    command: str
    exit_code: int
    stdout: str
    stderr: str
    duration: float
    timed_out: bool = False
    cancelled: bool = False
    status: str = "completed"  # "completed", "failed", "timeout", "cancelled", "error"
    container_id: str | None = None
    sandboxed: bool = False
    runner: str = "docker"

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "command": self.command,
            "exit_code": self.exit_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "duration": self.duration,
            "timed_out": self.timed_out,
            "cancelled": self.cancelled,
            "container_id": self.container_id,
            "sandboxed": self.sandboxed,
            "runner": self.runner,
        }


class ExecutionRunner(ABC):
    """
    Abstract interface for executing commands in an isolated environment.
    All test and repair command executions depend on this abstraction.
    """

    @abstractmethod
    async def run(
        self,
        command: str,
        cwd: Path,
        timeout: float = 120.0,
        env: dict[str, str] | None = None,
        job_id: str = "default",
    ) -> ExecutionResult:
        """Run a command within the specified working directory."""
        pass


class LocalExecutionRunner(ExecutionRunner):
    """
    Local host execution runner with explicit development/test labeling.
    
    WARNING: This runner executes directly on the host machine and is ONLY intended
    for local development and demo testing when explicitly permitted. In production,
    enforced Docker isolation must be used.
    """

    def __init__(self, runner_label: str = "local_development"):
        self.runner_label = runner_label

    def _get_command_args(self, cmd: str) -> list[str]:
        """Convert test command safely into argument list without shell interpolation."""
        import shlex
        cmd = cmd.strip()
        try:
            parts = shlex.split(cmd, posix=(sys.platform != "win32"))
        except Exception:
            parts = cmd.split()

        parts = [p.strip('"').strip("'") for p in parts if p]
        if not parts:
            return [sys.executable, "-m", "pytest"]

        first = parts[0].lower()
        if (
            first in ("pytest", "pytest.exe")
            or first.endswith("/pytest")
            or first.endswith("\\pytest")
            or first.endswith("/pytest.exe")
            or first.endswith("\\pytest.exe")
        ):
            return [sys.executable, "-m", "pytest"] + parts[1:]
        if first in ("python", "python3", "py", "python.exe", "python3.exe", "py.exe"):
            return [sys.executable] + parts[1:]

        import shutil
        if first in ("npx", "npx.cmd") or first.endswith("/npx") or first.endswith("\\npx") or first.endswith("/npx.cmd") or first.endswith("\\npx.cmd"):
            bin_path = shutil.which("npx.cmd") or shutil.which("npx") or parts[0]
            return [bin_path] + parts[1:]
        if first in ("npm", "npm.cmd") or first.endswith("/npm") or first.endswith("\\npm") or first.endswith("/npm.cmd") or first.endswith("\\npm.cmd"):
            bin_path = shutil.which("npm.cmd") or shutil.which("npm") or parts[0]
            return [bin_path] + parts[1:]
        if first in ("mvn", "mvn.cmd"):
            bin_path = shutil.which("mvn.cmd") or shutil.which("mvn") or parts[0]
            return [bin_path] + parts[1:]
        if first in ("gradle", "gradle.bat"):
            bin_path = shutil.which("gradle.bat") or shutil.which("gradle") or parts[0]
            return [bin_path] + parts[1:]

        return parts

    async def run(
        self,
        command: str,
        cwd: Path,
        timeout: float = 120.0,
        env: dict[str, str] | None = None,
        job_id: str = "default",
    ) -> ExecutionResult:
        run_env = os.environ.copy()
        if env:
            run_env.update(env)

        # Make sure the repo path is in PYTHONPATH so local modules resolve cleanly
        existing_pythonpath = run_env.get("PYTHONPATH", "")
        cwd_str = str(cwd.resolve())
        if existing_pythonpath:
            run_env["PYTHONPATH"] = f"{cwd_str}{os.pathsep}{existing_pythonpath}"
        else:
            run_env["PYTHONPATH"] = cwd_str

        # Ensure Python unbuffered output
        run_env["PYTHONUNBUFFERED"] = "1"

        cmd_args = self._get_command_args(command)
        start_time = time.perf_counter()

        # On Windows, always use asyncio.to_thread with subprocess.run to avoid
        # proactor event loop pipe deadlocks, inherited console handle stalls, and subprocess hang issues.
        if sys.platform == "win32":
            import subprocess

            def _sync_run():
                try:
                    res = subprocess.run(
                        cmd_args,
                        shell=False,
                        cwd=str(cwd),
                        capture_output=True,
                        env=run_env,
                        timeout=timeout,
                    )
                    return res.returncode, res.stdout, res.stderr, False
                except subprocess.TimeoutExpired as te:
                    return -1, te.stdout or b"", te.stderr or b"", True
                except Exception as e:
                    return -1, b"", str(e).encode("utf-8"), False

            returncode, stdout_bytes, stderr_bytes, timed_out = await asyncio.to_thread(_sync_run)
            duration = round(time.perf_counter() - start_time, 2)
            status = "timeout" if timed_out else ("completed" if returncode == 0 else "failed")
            return ExecutionResult(
                command=command,
                exit_code=returncode,
                stdout=stdout_bytes.decode("utf-8", errors="replace"),
                stderr=stderr_bytes.decode("utf-8", errors="replace"),
                duration=duration,
                timed_out=timed_out,
                status=status,
                container_id=None,
                sandboxed=False,
                runner=self.runner_label,
            )

        # Choose appropriate execution method for non-Windows platforms
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd_args,
                cwd=str(cwd),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=run_env,
            )
        except (NotImplementedError, OSError):
            import subprocess

            def _sync_run():
                try:
                    res = subprocess.run(
                        cmd_args,
                        shell=False,
                        cwd=str(cwd),
                        capture_output=True,
                        env=run_env,
                        timeout=timeout,
                    )
                    return res.returncode, res.stdout, res.stderr, False
                except subprocess.TimeoutExpired as te:
                    return -1, te.stdout or b"", te.stderr or b"", True
                except Exception as e:
                    return -1, b"", str(e).encode("utf-8"), False

            returncode, stdout_bytes, stderr_bytes, timed_out = await asyncio.to_thread(_sync_run)
            duration = round(time.perf_counter() - start_time, 2)
            status = "timeout" if timed_out else ("completed" if returncode == 0 else "failed")
            return ExecutionResult(
                command=command,
                exit_code=returncode,
                stdout=stdout_bytes.decode("utf-8", errors="replace"),
                stderr=stderr_bytes.decode("utf-8", errors="replace"),
                duration=duration,
                timed_out=timed_out,
                status=status,
                container_id=None,
                sandboxed=False,
                runner=self.runner_label,
            )

        timed_out = False
        stdout_bytes = b""
        stderr_bytes = b""

        try:
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                proc.communicate(),
                timeout=timeout,
            )
            duration = round(time.perf_counter() - start_time, 2)
            exit_code = proc.returncode if proc.returncode is not None else 0
            status = "completed" if exit_code == 0 else "failed"

        except asyncio.TimeoutError:
            timed_out = True
            duration = round(time.perf_counter() - start_time, 2)
            exit_code = -1
            status = "timeout"

            # Forcefully kill the process tree
            try:
                if sys.platform == "win32":
                    import subprocess
                    subprocess.run(
                        ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                        capture_output=True,
                        check=False,
                    )
                else:
                    if hasattr(os, "killpg") and hasattr(os, "getpgid"):
                        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                    else:
                        proc.kill()
            except Exception:
                pass

            try:
                stdout_bytes, stderr_bytes = await proc.communicate()
            except Exception:
                pass

        stdout_str = stdout_bytes.decode("utf-8", errors="replace")
        stderr_str = stderr_bytes.decode("utf-8", errors="replace")

        return ExecutionResult(
            command=command,
            exit_code=exit_code,
            stdout=stdout_str,
            stderr=stderr_str,
            duration=duration,
            timed_out=timed_out,
            status=status,
            container_id=None,
            sandboxed=False,
            runner=self.runner_label,
        )


def get_execution_runner(mode: str | None = None) -> ExecutionRunner:
    """
    Factory to retrieve the appropriate ExecutionRunner based on configuration.
    Enforces fail-closed Docker sandbox in production mode.
    Permits local subprocess execution only via explicit development/test configuration.
    """
    if "EXECUTION_MODE" not in os.environ:
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
                            if _k not in os.environ:
                                os.environ[_k] = _v
                except OSError:
                    pass

    selected = (mode or os.environ.get("EXECUTION_MODE", "docker")).strip().lower()

    is_production = (
        os.environ.get("FIXFORGE_ENV", "").strip().lower() == "production"
        or os.environ.get("NODE_ENV", "").strip().lower() == "production"
    )

    if is_production:
        if selected in ("local", "local_dev", "test") or os.environ.get("ALLOW_LOCAL_SUBPROCESS", "false").strip().lower() in ("true", "1", "yes"):
            from app.sandbox.errors import SandboxUnavailable
            raise SandboxUnavailable(
                "CRITICAL SECURITY: Local host subprocess execution is permanently disabled in production mode. "
                "Docker sandbox runner is mandatory."
            )
        from app.sandbox.docker_runner import DockerSandboxRunner
        return DockerSandboxRunner()

    enforce_docker = os.environ.get("SANDBOX_ENFORCE_DOCKER", "false").strip().lower() in ("true", "1", "yes")
    allow_local = (
        os.environ.get("ALLOW_LOCAL_SUBPROCESS", "false").strip().lower() in ("true", "1", "yes")
        or selected in ("local_dev", "test")
    )

    runner_opt = os.environ.get("EXECUTION_RUNNER", "").strip().lower()
    if selected in ("remote", "remote_sandbox") or runner_opt in ("remote", "remote_sandbox"):
        from app.sandbox.remote_runner import RemoteSandboxRunner
        return RemoteSandboxRunner()

    if selected == "docker":
        from app.sandbox.docker_runner import DockerSandboxRunner
        return DockerSandboxRunner()

    if selected in ("local", "local_dev", "test"):
        if enforce_docker and not allow_local:
            from app.sandbox.errors import SandboxUnavailable
            raise SandboxUnavailable(
                "Docker sandbox enforcement is active. "
                "Local host subprocess execution is prohibited unless ALLOW_LOCAL_SUBPROCESS=true is explicitly configured."
            )
        runner_label = "local_dev_fallback" if selected == "local" else "local_development"
        return LocalExecutionRunner(runner_label=runner_label)

    from app.sandbox.docker_runner import DockerSandboxRunner
    return DockerSandboxRunner()


def __getattr__(name: str) -> Any:
    if name == "DockerSandboxRunner":
        from app.sandbox.docker_runner import DockerSandboxRunner
        return DockerSandboxRunner
    if name == "RemoteSandboxRunner":
        from app.sandbox.remote_runner import RemoteSandboxRunner
        return RemoteSandboxRunner
    raise AttributeError(f"module '{__name__}' has no attribute '{name}'")


