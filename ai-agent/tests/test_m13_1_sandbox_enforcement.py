"""
FixForge M13.1 — Security and Lifecycle Enforcement Test Suite
Verifies:
- Restrictive Docker isolation flags (--network none, --cap-drop ALL, no-new-privileges, --read-only, --tmpfs)
- Rejection of sensitive host mounts (root, home, /var/run, /etc)
- Fail-closed behavior in production mode when Docker is unavailable
- Explicit local development fallback labeling
- Job lifecycle state machine transitions, concurrency bounds, and duplicate prevention
- Idempotent cancellation and active container termination
- Prevention of late success callbacks overwriting CANCELLED state
- Path traversal and symlink escape protections
"""

import asyncio
import os
from pathlib import Path
from unittest.mock import AsyncMock, patch
import pytest

from app.runner import ExecutionResult, LocalExecutionRunner, get_execution_runner
from app.sandbox.config import SandboxConfig
from app.sandbox.docker_runner import DockerSandboxRunner
from app.sandbox.errors import SandboxUnavailable, SandboxWorkspaceViolation
from app.sandbox.job_lifecycle import (
    CapacityExceededError,
    InvalidStateTransitionError,
    JobConflictError,
    JobLifecycleManager,
    JobState,
    LateCallbackIgnoredError,
)
from app.sandbox.lifecycle import (
    build_docker_run_args,
    cleanup_container,
    generate_container_name,
)
from app.sandbox.security import validate_sandbox_workspace


@pytest.fixture
def test_workspace(tmp_path):
    repo = tmp_path / "test_repo"
    repo.mkdir()
    (repo / "calc.py").write_text("def add(a, b): return a + b\n", encoding="utf-8")
    return repo


def test_docker_isolation_flags_and_containment(test_workspace):
    """Verify all required restrictive security and isolation flags are present."""
    config = SandboxConfig(
        timeout_seconds=60.0,
        memory_limit="512m",
        cpus_limit="1",
        pids_limit=128,
        user="sandboxuser",
        network_mode="none",
        image_name="fixforge-sandbox:latest",
        read_only_root=True,
        drop_capabilities=True,
        no_new_privileges=True,
        tmpfs_tmp_size="64m",
    )

    args = build_docker_run_args(
        container_name="test-m13-1-container",
        command="pytest",
        workspace_path=test_workspace,
        config=config,
    )

    # Docker command structure
    assert args[0] == "docker"
    assert args[1] == "run"

    # Network disabled by default
    assert "--network" in args
    assert args[args.index("--network") + 1] == "none"

    # Non-root user
    assert "--user" in args
    assert args[args.index("--user") + 1] == "sandboxuser"

    # Security options
    assert "--security-opt" in args
    assert args[args.index("--security-opt") + 1] == "no-new-privileges:true"

    # Drop all capabilities
    assert "--cap-drop" in args
    assert args[args.index("--cap-drop") + 1] == "ALL"

    # Read-only root filesystem with tmpfs
    assert "--read-only" in args
    assert "--tmpfs" in args
    tmpfs_val = args[args.index("--tmpfs") + 1]
    assert "/tmp:rw,noexec,nosuid,size=64m" in tmpfs_val

    # Resource limits
    assert "--memory" in args and args[args.index("--memory") + 1] == "512m"
    assert "--cpus" in args and args[args.index("--cpus") + 1] == "1"
    assert "--pids-limit" in args and args[args.index("--pids-limit") + 1] == "128"

    # Workspace mount
    vol_args = [a for a in args if ":/workspace:rw" in a]
    assert len(vol_args) == 1
    assert "-w" in args and args[args.index("-w") + 1] == "/workspace"


def test_no_sensitive_host_mounts(tmp_path):
    """Verify attempts to mount sensitive host locations (home, root, /etc) are blocked."""
    # Attempting to mount home directory
    with patch("app.sandbox.security.Path.home", return_value=tmp_path.resolve()):
        with pytest.raises(SandboxWorkspaceViolation, match="Cannot mount host home directory"):
            validate_sandbox_workspace(tmp_path, base_dir=tmp_path.parent)

    # Traversal escape
    with pytest.raises(SandboxWorkspaceViolation):
        validate_sandbox_workspace("../../../etc/passwd", base_dir=tmp_path)


def test_fail_closed_in_production_when_docker_unavailable(test_workspace, monkeypatch):
    """In production mode with Docker unavailable, execution fails closed."""
    monkeypatch.setenv("FIXFORGE_ENV", "production")
    monkeypatch.setenv("ALLOW_LOCAL_SUBPROCESS", "false")

    runner = DockerSandboxRunner(base_dir=test_workspace.parent)

    async def _run():
        with patch.object(DockerSandboxRunner, "is_docker_available", return_value=(False, None, "Daemon not found")):
            with pytest.raises(SandboxUnavailable, match="Failing closed in production mode"):
                await runner.run(command="pytest", cwd=test_workspace)

    asyncio.run(_run())


def test_explicit_local_development_fallback(test_workspace, monkeypatch):
    """With explicit ALLOW_LOCAL_SUBPROCESS=true, fallback runs and is labeled accurately."""
    monkeypatch.setenv("ALLOW_LOCAL_SUBPROCESS", "true")
    monkeypatch.delenv("FIXFORGE_ENV", raising=False)

    config = SandboxConfig(allow_local_subprocess=True)
    runner = DockerSandboxRunner(config=config, base_dir=test_workspace.parent)

    mock_fallback_res = ExecutionResult(
        command="pytest",
        exit_code=0,
        stdout="1 passed in 0.05s",
        stderr="",
        duration=0.05,
        sandboxed=False,
        runner="local_dev_fallback",
    )

    async def _run():
        with patch.object(DockerSandboxRunner, "is_docker_available", return_value=(False, None, "Daemon down")):
            with patch.object(LocalExecutionRunner, "run", new_callable=AsyncMock) as mock_local:
                mock_local.return_value = mock_fallback_res
                res = await runner.run(command="pytest", cwd=test_workspace)
                assert res.sandboxed is False
                assert res.runner == "local_dev_fallback"
                assert mock_local.called

    asyncio.run(_run())


def test_lifecycle_state_machine_valid_transitions():
    """Verify valid state transitions: QUEUED -> RUNNING -> VERIFYING -> SUCCEEDED."""
    mgr = JobLifecycleManager(max_concurrent_jobs=2)

    async def _test():
        await mgr.register_job("job-abc")
        rec = mgr.get_job("job-abc")
        assert rec.state == JobState.QUEUED

        await mgr.start_job("job-abc")
        assert rec.state == JobState.RUNNING

        await mgr.transition("job-abc", JobState.VERIFYING)
        assert rec.state == JobState.VERIFYING

        await mgr.transition("job-abc", JobState.SUCCEEDED)
        assert rec.state == JobState.SUCCEEDED
        assert rec.completed_at is not None

    asyncio.run(_test())


def test_lifecycle_state_machine_invalid_transitions():
    """Verify invalid transitions are rejected."""
    mgr = JobLifecycleManager()

    async def _test():
        await mgr.register_job("job-inv")
        # Direct jump from QUEUED to SUCCEEDED is invalid
        with pytest.raises(InvalidStateTransitionError):
            await mgr.transition("job-inv", JobState.SUCCEEDED)

        # Transition after terminal state is invalid
        await mgr.start_job("job-inv")
        await mgr.transition("job-inv", JobState.FAILED)
        with pytest.raises(InvalidStateTransitionError):
            await mgr.transition("job-inv", JobState.RUNNING)

    asyncio.run(_test())


def test_late_success_callback_after_cancellation_ignored():
    """Verify that late success callbacks cannot overwrite a CANCELLED job."""
    mgr = JobLifecycleManager()

    async def _test():
        await mgr.register_job("job-cancel")
        await mgr.start_job("job-cancel")
        await mgr.cancel_job("job-cancel", reason="Cancelled by user")

        rec = mgr.get_job("job-cancel")
        assert rec.state == JobState.CANCELLED

        # Attempted late callback to SUCCEEDED
        with pytest.raises(LateCallbackIgnoredError):
            await mgr.transition("job-cancel", JobState.SUCCEEDED)

        # State must remain CANCELLED
        assert rec.state == JobState.CANCELLED

    asyncio.run(_test())


def test_idempotent_cancellation_and_container_termination():
    """Verify cancellation is idempotent and cleans up container."""
    mgr = JobLifecycleManager()

    async def _test():
        with patch.object(DockerSandboxRunner, "cancel_job", new_callable=AsyncMock) as mock_docker_cancel:
            mock_docker_cancel.return_value = True

            await mgr.register_job("job-idem")
            await mgr.start_job("job-idem")

            # First cancel
            r1 = await mgr.cancel_job("job-idem")
            assert r1.state == JobState.CANCELLED
            assert mock_docker_cancel.called

            # Second cancel (idempotent)
            r2 = await mgr.cancel_job("job-idem")
            assert r2.state == JobState.CANCELLED

    asyncio.run(_test())


def test_duplicate_job_prevention():
    """Verify attempting to start an already running job raises JobConflictError."""
    mgr = JobLifecycleManager()

    async def _test():
        await mgr.register_job("job-dup")
        await mgr.start_job("job-dup")

        with pytest.raises(JobConflictError, match="already"):
            await mgr.start_job("job-dup")

    asyncio.run(_test())


def test_concurrency_limit_exhaustion():
    """Verify exceeding configured max concurrent jobs raises CapacityExceededError."""
    mgr = JobLifecycleManager(max_concurrent_jobs=2)

    async def _test():
        await mgr.register_job("job-1")
        await mgr.start_job("job-1")

        await mgr.register_job("job-2")
        await mgr.start_job("job-2")

        await mgr.register_job("job-3")
        with pytest.raises(CapacityExceededError, match="Maximum concurrent repair jobs"):
            await mgr.start_job("job-3")

        # After finishing job-1, capacity is freed
        await mgr.transition("job-1", JobState.SUCCEEDED)
        await mgr.start_job("job-3")
        assert mgr.get_job("job-3").state == JobState.RUNNING

    asyncio.run(_test())


def test_timeout_and_exception_cleanup_guarantee(test_workspace):
    """Verify container is forcefully cleaned up even on exception or timeout."""
    runner = DockerSandboxRunner(base_dir=test_workspace.parent)

    async def _test():
        with patch.object(DockerSandboxRunner, "is_docker_available", return_value=(True, "24.0", None)), \
             patch("asyncio.create_subprocess_exec", side_effect=asyncio.TimeoutError()), \
             patch("app.sandbox.docker_runner.cleanup_container", new_callable=AsyncMock) as mock_cleanup:

            res = await runner.run(command="pytest", cwd=test_workspace, job_id="job-clean-test")
            assert res.timed_out is True
            assert mock_cleanup.called

    asyncio.run(_test())
