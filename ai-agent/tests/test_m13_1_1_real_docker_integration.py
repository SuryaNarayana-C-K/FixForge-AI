"""
FixForge M13.1.1 — Genuine Docker Integration Test Suite.
Executes against the running Docker engine (Docker Desktop with WSL 2, engine 29.8.2).
Validates real security isolation, resource limits, lifecycle management, and fail-closed policies.
"""

import asyncio
import os
from pathlib import Path
import subprocess
from unittest.mock import patch
import pytest

from app.runner import get_execution_runner
from app.sandbox.config import SandboxConfig
from app.sandbox.docker_runner import DockerSandboxRunner
from app.sandbox.errors import SandboxUnavailable, SandboxWorkspaceViolation
from app.sandbox.job_lifecycle import JobLifecycleManager, JobState, LateCallbackIgnoredError
from app.sandbox.lifecycle import get_active_containers
from app.sandbox.security import validate_sandbox_workspace


@pytest.fixture(scope="module")
def docker_available():
    """Ensure real Docker engine is available; skip tests if offline."""
    available, version, detail = asyncio.run(DockerSandboxRunner.is_docker_available())
    if not available:
        pytest.skip(f"Docker engine is not available: {detail}")
    return version


@pytest.fixture
def real_workspace(tmp_path):
    """Temporary test workspace located inside a safe sandbox base directory."""
    ws = tmp_path / "test_repo"
    ws.mkdir(parents=True, exist_ok=True)
    (ws / "app.py").write_text("print('hello sandbox')\n", encoding="utf-8")
    return ws


def test_real_docker_connectivity_and_image(docker_available):
    """Verify Docker engine connectivity, version detection, and fixforge-sandbox image."""
    available, version, detail = asyncio.run(DockerSandboxRunner.is_docker_available())
    assert available is True
    assert version is not None
    assert detail is None

    # Verify image presence
    proc = subprocess.run(
        ["docker", "image", "inspect", "fixforge-sandbox:latest"],
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, "fixforge-sandbox:latest image must be built and inspectable"


def test_real_docker_network_isolation(docker_available, real_workspace):
    """Validate that --network none strictly isolates container networking."""
    runner = DockerSandboxRunner(base_dir=real_workspace.parent)

    # Attempting to open a TCP connection to public DNS/Web endpoints must fail immediately
    probe_cmd = (
        'python -c "'
        'import socket; '
        's = socket.socket(socket.AF_INET, socket.SOCK_STREAM); '
        's.settimeout(2.0); '
        's.connect((\'1.1.1.1\', 80))"'
    )

    res = asyncio.run(runner.run(command=probe_cmd, cwd=real_workspace))

    assert res.exit_code != 0
    # On Linux with --network none, connecting causes Network is unreachable (Errno 101)
    assert "Network is unreachable" in res.stderr or "OSError" in res.stderr or "Errno 101" in res.stderr


def test_real_docker_non_root_user(docker_available, real_workspace):
    """Validate that container execution runs as the unprivileged non-root user (uid=1000)."""
    runner = DockerSandboxRunner(base_dir=real_workspace.parent)

    res = asyncio.run(runner.run(command="id", cwd=real_workspace))

    assert res.exit_code == 0
    assert "uid=1000(sandboxuser)" in res.stdout
    assert "gid=1000(sandboxgroup)" in res.stdout
    assert "uid=0" not in res.stdout


def test_real_docker_read_only_rootfs_and_tmpfs(docker_available, real_workspace):
    """Validate root filesystem is read-only, while /tmp and /workspace are writable."""
    runner = DockerSandboxRunner(base_dir=real_workspace.parent)

    # 1. Attempt writing outside /tmp or /workspace (e.g. /etc)
    res_root = asyncio.run(runner.run(command="touch /etc/hacked.txt", cwd=real_workspace))
    assert res_root.exit_code != 0
    assert "Read-only file system" in res_root.stderr

    # 2. Attempt writing directly to container root /
    res_slash = asyncio.run(runner.run(command="touch /pwned.txt", cwd=real_workspace))
    assert res_slash.exit_code != 0
    assert "Read-only file system" in res_slash.stderr

    # 3. Writable /tmp (tmpfs mount)
    res_tmp = asyncio.run(runner.run(command="touch /tmp/test.tmp && ls /tmp/test.tmp", cwd=real_workspace))
    assert res_tmp.exit_code == 0
    assert "/tmp/test.tmp" in res_tmp.stdout

    # 4. Writable /workspace (bound repository volume)
    res_ws = asyncio.run(runner.run(command="touch in_workspace.txt && ls in_workspace.txt", cwd=real_workspace))
    assert res_ws.exit_code == 0
    assert "in_workspace.txt" in res_ws.stdout
    assert (real_workspace / "in_workspace.txt").exists()


def test_real_docker_capabilities_and_no_new_privileges(docker_available, real_workspace):
    """Validate Linux capabilities are dropped (CapEff=0) and no-new-privileges is active."""
    runner = DockerSandboxRunner(base_dir=real_workspace.parent)

    res = asyncio.run(runner.run(command="grep -E '(CapEff|NoNewPrivs)' /proc/self/status", cwd=real_workspace))

    assert res.exit_code == 0
    # CapEff must be all zeroes (all capabilities dropped)
    assert "CapEff:\t0000000000000000" in res.stdout
    # NoNewPrivs must be 1 (enabled)
    assert "NoNewPrivs:\t1" in res.stdout


def test_real_docker_cpu_limit(docker_available, real_workspace):
    """Validate CPU limits are configured into container cgroups."""
    config = SandboxConfig(cpus_limit="1")
    runner = DockerSandboxRunner(config=config, base_dir=real_workspace.parent)

    # In cgroup v2, cpu.max contains "$QUOTA $PERIOD" where quota equals period for 1 CPU
    res = asyncio.run(runner.run(
        command="cat /sys/fs/cgroup/cpu.max 2>/dev/null || cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us 2>/dev/null",
        cwd=real_workspace,
    ))
    assert res.exit_code == 0
    cgroup_val = res.stdout.strip()
    assert "100000" in cgroup_val


def test_real_docker_pid_limit(docker_available, real_workspace):
    """Validate PID limit restricts process/thread creation and prevents fork exhaustion."""
    config = SandboxConfig(pids_limit=16)
    runner = DockerSandboxRunner(config=config, base_dir=real_workspace.parent)

    # Attempting to fork 20 times must exhaust the 16-PID limit
    fork_bomb_cmd = 'python -c "import os; [os.fork() for _ in range(20)]"'
    res = asyncio.run(runner.run(command=fork_bomb_cmd, cwd=real_workspace))

    assert res.exit_code != 0
    assert "BlockingIOError" in res.stderr or "Resource temporarily unavailable" in res.stderr or "Errno 11" in res.stderr


def test_real_docker_memory_limit(docker_available, real_workspace):
    """Validate memory limit enforces OOM kill when allocation exceeds limit."""
    config = SandboxConfig(memory_limit="32m")
    runner = DockerSandboxRunner(config=config, base_dir=real_workspace.parent)

    # Attempting to allocate 128 MB in a 32m container
    oom_cmd = 'python -c "x = \' \' * (128 * 1024 * 1024)"'
    res = asyncio.run(runner.run(command=oom_cmd, cwd=real_workspace))

    assert res.exit_code in (137, -1) or "Killed" in res.stderr or res.status == "failed"


def test_real_docker_timeout_cleanup(docker_available, real_workspace):
    """Validate execution timeout triggers process termination and removes container."""
    config = SandboxConfig(timeout_seconds=2.0)
    runner = DockerSandboxRunner(config=config, base_dir=real_workspace.parent)
    job_id = "real-to-test"

    res = asyncio.run(runner.run(command="sleep 10", cwd=real_workspace, timeout=2.0, job_id=job_id))

    assert res.timed_out is True
    assert res.status == "timeout"
    assert "timed out after 2.0 seconds" in res.stderr

    # Verify container is not lingering in docker ps -a
    ps_proc = subprocess.run(
        ["docker", "ps", "-a", "--filter", f"name={job_id}", "--format", "{{.Names}}"],
        capture_output=True,
        text=True,
    )
    assert job_id not in ps_proc.stdout


def test_real_docker_cancellation_and_tracking(docker_available, real_workspace):
    """Validate cancellation terminates container, cleans up resources, and updates tracking."""
    runner = DockerSandboxRunner(base_dir=real_workspace.parent)
    job_id = "real-cancel-test"

    async def _test():
        task = asyncio.create_task(runner.run("sleep 30", cwd=real_workspace, timeout=60.0, job_id=job_id))
        
        # Give container time to initialize and register
        await asyncio.sleep(1.5)

        # Check tracking
        tracked = get_active_containers()
        assert any(job_id in c for c in tracked), f"Container for {job_id} should be tracked in active containers"

        # Cancel job
        cancelled = await DockerSandboxRunner.cancel_job(job_id)
        assert cancelled is True

        res = await task
        assert res.cancelled is True
        assert res.status == "cancelled"

        # Check tracking after cleanup
        await asyncio.sleep(0.5)
        tracked_after = get_active_containers()
        assert not any(job_id in c for c in tracked_after)

        # Verify container removed from Docker daemon
        ps_proc = subprocess.run(
            ["docker", "ps", "-a", "--filter", f"name={job_id}", "--format", "{{.Names}}"],
            capture_output=True,
            text=True,
        )
        assert job_id not in ps_proc.stdout

    asyncio.run(_test())


def test_real_docker_late_result_handling(docker_available):
    """Validate that late callbacks cannot overwrite cancelled or timed out jobs."""
    mgr = JobLifecycleManager()

    async def _test():
        job_id = "job-late-real"
        await mgr.register_job(job_id)
        await mgr.start_job(job_id)
        await mgr.cancel_job(job_id)

        rec = mgr.get_job(job_id)
        assert rec.state == JobState.CANCELLED

        # Late success callback must be rejected
        with pytest.raises(LateCallbackIgnoredError):
            await mgr.transition(job_id, JobState.SUCCEEDED)

        assert rec.state == JobState.CANCELLED

    asyncio.run(_test())


def test_real_docker_workspace_isolation(docker_available, real_workspace):
    """Validate that container cannot access host filesystem outside mounted workspace."""
    runner = DockerSandboxRunner(base_dir=real_workspace.parent)

    # 1. Inside container, /workspace/.. resolves to container root (/), not host parent
    res = asyncio.run(runner.run(command="ls /workspace/..", cwd=real_workspace))
    assert res.exit_code == 0
    # Must list container root entries, not host directory entries
    assert "bin" in res.stdout
    assert "etc" in res.stdout
    assert "proc" in res.stdout

    # 2. Host path outside base_dir cannot be passed as cwd
    with pytest.raises(SandboxWorkspaceViolation):
        validate_sandbox_workspace(Path("C:/Windows"), base_dir=real_workspace.parent)

    with pytest.raises(SandboxWorkspaceViolation):
        validate_sandbox_workspace(Path(".."), base_dir=real_workspace)


def test_real_docker_health_check_payload(docker_available):
    """Validate DockerSandboxRunner.check_health payload matches specifications."""
    runner = DockerSandboxRunner()
    health = asyncio.run(runner.check_health())

    assert health["docker_available"] is True
    assert health["runner"] == "docker"
    assert health["version"] is not None
    assert health["image"] == "fixforge-sandbox:latest"
    assert "operational" in health["detail"].lower() or "available" in health["detail"].lower()


def test_real_docker_fail_closed_if_unavailable(real_workspace, monkeypatch):
    """Validate fail-closed policy when Docker daemon is unavailable."""
    monkeypatch.setenv("FIXFORGE_ENV", "production")
    monkeypatch.setenv("ALLOW_LOCAL_SUBPROCESS", "false")

    runner = DockerSandboxRunner(base_dir=real_workspace.parent)

    async def _test():
        with patch.object(DockerSandboxRunner, "is_docker_available", return_value=(False, None, "Daemon disconnected")):
            with pytest.raises(SandboxUnavailable, match="Failing closed in production mode"):
                await runner.run(command="pytest", cwd=real_workspace)

    asyncio.run(_test())
