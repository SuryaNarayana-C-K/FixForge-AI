"""
Unit tests for RemoteSandboxRunner in ai-agent.
Verifies contract conformity, error handling, cancellation, and fail-closed security.
"""

import json
from pathlib import Path
from unittest.mock import MagicMock, patch
import urllib.error
import pytest

from app.runner import ExecutionResult, get_execution_runner
from app.sandbox.errors import SandboxUnavailable, SandboxWorkspaceViolation
from app.sandbox.remote_runner import RemoteSandboxRunner


@pytest.fixture
def test_workspace(tmp_path):
    repo = tmp_path / "test_repo"
    repo.mkdir()
    (repo / "test_math.py").write_text("def test_one(): pass\n")
    return repo


def test_remote_runner_fails_closed_if_unconfigured(monkeypatch, test_workspace):
    monkeypatch.delenv("SANDBOX_WORKER_URL", raising=False)
    monkeypatch.delenv("INTERNAL_WORKER_KEY", raising=False)

    runner = RemoteSandboxRunner(worker_url="", worker_key="", base_dir=test_workspace.parent)
    with pytest.raises(SandboxUnavailable, match="SANDBOX_WORKER_URL is not configured"):
        import asyncio
        asyncio.run(runner.run(command="pytest", cwd=test_workspace))


def test_remote_runner_fails_closed_if_missing_worker_key(monkeypatch, test_workspace):
    monkeypatch.delenv("INTERNAL_WORKER_KEY", raising=False)
    runner = RemoteSandboxRunner(
        worker_url="http://localhost:9000",
        worker_key="",
        base_dir=test_workspace.parent,
    )
    with pytest.raises(SandboxUnavailable, match="INTERNAL_WORKER_KEY is not configured"):
        import asyncio
        asyncio.run(runner.run(command="pytest", cwd=test_workspace))


def test_remote_runner_submits_job_and_maps_result(test_workspace):
    runner = RemoteSandboxRunner(
        worker_url="http://mock-worker:9000",
        worker_key="test-key-12345",
        base_dir=test_workspace.parent,
    )

    mock_response_data = {
        "job_id": "job-abc",
        "idempotency_key": "exec-abc",
        "status": "completed",
        "exit_code": 0,
        "stdout": "1 passed in 0.05s",
        "stderr": "",
        "duration": 0.5,
        "timed_out": False,
        "cancelled": False,
        "sandboxed": True,
        "worker_id": "sandbox-worker-01",
    }

    mock_resp = MagicMock()
    mock_resp.read.return_value = json.dumps(mock_response_data).encode("utf-8")
    mock_resp.__enter__.return_value = mock_resp

    with patch("urllib.request.urlopen", return_value=mock_resp) as mock_urlopen:
        import asyncio
        result = asyncio.run(runner.run(command="pytest", cwd=test_workspace, job_id="job-abc"))

        assert isinstance(result, ExecutionResult)
        assert result.status == "completed"
        assert result.exit_code == 0
        assert result.sandboxed is True
        assert result.runner == "remote_sandbox"
        assert result.container_id == "sandbox-worker-01"

        # Verify headers sent to worker
        assert mock_urlopen.call_count == 1
        req = mock_urlopen.call_args[0][0]
        assert req.get_header("X-worker-key") == "test-key-12345"
        assert "v1/jobs/execute" in req.full_url


def test_remote_runner_handles_worker_503_unavailable(test_workspace):
    runner = RemoteSandboxRunner(
        worker_url="http://mock-worker:9000",
        worker_key="test-key-12345",
        base_dir=test_workspace.parent,
    )

    http_err = urllib.error.HTTPError(
        url="http://mock-worker:9000/v1/jobs/execute",
        code=503,
        msg="Service Unavailable",
        hdrs={},
        fp=MagicMock(read=lambda: b'{"error": "Rootless daemon disconnected"}'),
    )

    with patch("urllib.request.urlopen", side_effect=http_err):
        import asyncio
        with pytest.raises(SandboxUnavailable, match="worker backend unavailable"):
            asyncio.run(runner.run(command="pytest", cwd=test_workspace))


def test_remote_runner_cancellation(monkeypatch):
    monkeypatch.setenv("INTERNAL_WORKER_KEY", "test-key-12345")
    mock_resp = MagicMock()
    mock_resp.status = 200
    mock_resp.__enter__.return_value = mock_resp

    with patch("urllib.request.urlopen", return_value=mock_resp) as mock_urlopen:
        import asyncio
        cancelled = asyncio.run(
            RemoteSandboxRunner.cancel_job("job-to-cancel", worker_url="http://mock-worker:9000", worker_key="test-key-12345")
        )
        assert cancelled is True
        assert mock_urlopen.call_count == 1
        req = mock_urlopen.call_args[0][0]
        assert "v1/jobs/job-to-cancel/cancel" in req.full_url


def test_get_execution_runner_resolves_remote_runner(monkeypatch):
    monkeypatch.setenv("EXECUTION_RUNNER", "remote")
    monkeypatch.setenv("SANDBOX_WORKER_URL", "http://worker:9000")
    monkeypatch.setenv("INTERNAL_WORKER_KEY", "test-key")

    runner = get_execution_runner()
    assert isinstance(runner, RemoteSandboxRunner)
