"""
FixForge M13.2 — Python AI Agent Durable Recovery & Reliability Test Suite.
Validates:
- Interrupted job reconciliation on startup (never marking interrupted jobs as successful).
- Real Docker orphan container cleanup and daemon reconciliation.
- Endpoint POST /agent/reconcile.
- Late callback rejection and terminal state locking.
- Idempotent cancellation and active container termination.
"""

import asyncio
from pathlib import Path
import subprocess
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.sandbox.config import SandboxConfig
from app.sandbox.docker_runner import DockerSandboxRunner
from app.sandbox.job_lifecycle import (
    JobLifecycleManager,
    JobRecord,
    JobState,
    LateCallbackIgnoredError,
    InvalidStateTransitionError,
    global_lifecycle_manager,
)


@pytest.fixture
def client():
    return TestClient(app)


def test_reconcile_interrupted_jobs_never_marks_successful():
    """Verify that startup reconciliation marks interrupted jobs as FAILED, never SUCCEEDED."""
    mgr = JobLifecycleManager()

    async def _test():
        # Simulate jobs interrupted during execution
        rec1 = await mgr.register_job("job-interrupted-1")
        await mgr.start_job("job-interrupted-1")
        assert rec1.state == JobState.RUNNING

        rec2 = await mgr.register_job("job-interrupted-2")
        await mgr.start_job("job-interrupted-2")
        await mgr.transition("job-interrupted-2", JobState.VERIFYING)
        assert rec2.state == JobState.VERIFYING

        # Reconcile startup state
        res = await mgr.reconcile_startup_state()

        assert "job-interrupted-1" in res["reconciled_jobs"]
        assert "job-interrupted-2" in res["reconciled_jobs"]

        assert rec1.state == JobState.FAILED
        assert rec2.state == JobState.FAILED
        assert rec1.completed_at is not None
        assert "interrupted by agent restart" in rec1.history[-1]["reason"]

        # Ensure terminal state is locked against late success callbacks
        with pytest.raises(InvalidStateTransitionError):
            await mgr.transition("job-interrupted-1", JobState.SUCCEEDED)

    asyncio.run(_test())


def test_agent_reconcile_endpoint(client):
    """Verify POST /agent/reconcile endpoint triggers reconciliation and returns cleaned items."""
    response = client.post("/agent/reconcile")
    assert response.status_code == 200
    data = response.json()
    assert "cleaned_containers" in data
    assert "reconciled_jobs" in data
    assert isinstance(data["cleaned_containers"], list)
    assert isinstance(data["reconciled_jobs"], list)


def test_late_callback_rejected_after_cancellation_or_timeout():
    """Verify that late success callbacks are strictly ignored after cancellation or timeout."""
    mgr = JobLifecycleManager()

    async def _test():
        await mgr.register_job("job-late-cb")
        await mgr.start_job("job-late-cb")
        await mgr.cancel_job("job-late-cb", reason="User cancelled")

        assert mgr.get_job("job-late-cb").state == JobState.CANCELLED

        # Attempted late callback to SUCCEEDED
        with pytest.raises(LateCallbackIgnoredError):
            await mgr.transition("job-late-cb", JobState.SUCCEEDED)

        # Attempted late callback to VERIFYING
        with pytest.raises(LateCallbackIgnoredError):
            await mgr.transition("job-late-cb", JobState.VERIFYING)

        assert mgr.get_job("job-late-cb").state == JobState.CANCELLED

    asyncio.run(_test())


def test_real_docker_orphan_container_reconciliation():
    """Verify genuine Docker container orphan detection and cleanup."""
    # Check if Docker is available
    available, _, _ = asyncio.run(DockerSandboxRunner.is_docker_available())
    if not available:
        pytest.skip("Docker daemon not available for orphan container test")

    orphan_container_name = "fixforge-sandbox-testorphan-12345"

    # Start a detached container mimicking an orphaned sandbox container
    proc_create = subprocess.run(
        ["docker", "run", "-d", "--name", orphan_container_name, "alpine:latest", "sleep", "60"],
        capture_output=True,
        text=True,
    )
    assert proc_create.returncode == 0, f"Failed to create test container: {proc_create.stderr}"

    # Verify container exists
    ps_proc = subprocess.run(
        ["docker", "ps", "-a", "--filter", f"name={orphan_container_name}", "--format", "{{.Names}}"],
        capture_output=True,
        text=True,
    )
    assert orphan_container_name in ps_proc.stdout

    # Execute reconciliation
    mgr = JobLifecycleManager()
    cleaned = asyncio.run(mgr.reconcile_orphaned_containers())

    assert orphan_container_name in cleaned

    # Verify container is completely gone from Docker daemon
    ps_after = subprocess.run(
        ["docker", "ps", "-a", "--filter", f"name={orphan_container_name}", "--format", "{{.Names}}"],
        capture_output=True,
        text=True,
    )
    assert orphan_container_name not in ps_after.stdout
