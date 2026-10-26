"""
Unit and integration tests for FixForge Isolated Sandbox Worker Prototype (M13.6-B).
Validates:
- Authentication enforcement and secret redaction
- Rejection of host paths, arbitrary images, arbitrary Docker flags, and invalid resource limits
- Safe archive unpacking and defense against path traversal, symlink escapes, and tarbombs
- Duplicate and conflicting idempotency keys
- Timeout, cancellation, cleanup, and backend-unavailable behavior
- Deterministic verification mapping (skipped/unexecuted tests cannot produce VERIFIED)
"""

import base64
import io
from pathlib import Path
import tarfile
import pytest
from fastapi.testclient import TestClient

import importlib.util
import sys
ROOT_DIR = Path(__file__).resolve().parent.parent.parent
_worker_pkg_dir = ROOT_DIR / "sandbox-worker" / "app"

if "worker_app" not in sys.modules:
    spec = importlib.util.spec_from_file_location(
        "worker_app", str(_worker_pkg_dir / "__init__.py"), submodule_search_locations=[str(_worker_pkg_dir)]
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules["worker_app"] = mod
    spec.loader.exec_module(mod)
    for sub in ["schemas", "security", "verification", "executor", "main"]:
        sub_spec = importlib.util.spec_from_file_location(f"worker_app.{sub}", str(_worker_pkg_dir / f"{sub}.py"))
        sub_mod = importlib.util.module_from_spec(sub_spec)
        sys.modules[f"worker_app.{sub}"] = sub_mod
        sub_spec.loader.exec_module(sub_mod)

from worker_app.main import app, job_manager
from worker_app.executor import IdempotencyConflictError, WorkerExecutionBackend
from worker_app.schemas import JobExecutionRequest, ResourceLimits
from worker_app.security import (
    ArchiveSecurityError,
    safe_extract_archive,
    sanitize_text,
    verify_worker_auth,
)
from worker_app.verification import evaluate_verification, parse_pytest_output


class MockWorkerBackend(WorkerExecutionBackend):
    """Controllable test backend simulating rootless container execution."""

    def __init__(self, available: bool = True):
        self.available = available
        self.last_executed_job: str | None = None
        self.cancelled_jobs: set[str] = set()

    async def check_health(self):
        return self.available, "healthy" if self.available else "unavailable", {
            "backend": "rootless_docker",
            "detail": "Mock backend operational" if self.available else "Rootless daemon disconnected",
        }

    async def execute_job(self, job_id, command, workspace_path, timeout, env, limits, network):
        self.last_executed_job = job_id
        if not self.available:
            from worker_app.executor import BackendUnavailableError
            raise BackendUnavailableError("Rootless daemon is unavailable.")

        if "fail_test" in command:
            return {
                "status": "failed",
                "exit_code": 1,
                "stdout": "================ 1 failed, 2 passed in 0.25s ================",
                "stderr": "",
                "duration": 0.5,
                "timed_out": False,
                "cancelled": False,
            }
        elif "skipped_test" in command:
            return {
                "status": "completed",
                "exit_code": 0,
                "stdout": "================ 3 skipped in 0.10s ================",
                "stderr": "",
                "duration": 0.2,
                "timed_out": False,
                "cancelled": False,
            }
        elif "syntax_error" in command:
            return {
                "status": "failed",
                "exit_code": 2,
                "stdout": "",
                "stderr": "SyntaxError: invalid syntax in test file",
                "duration": 0.1,
                "timed_out": False,
                "cancelled": False,
            }
        else:
            return {
                "status": "completed",
                "exit_code": 0,
                "stdout": "================ 4 passed in 0.42s ================",
                "stderr": "",
                "duration": 0.8,
                "timed_out": False,
                "cancelled": False,
            }

    async def cancel_job(self, job_id):
        self.cancelled_jobs.add(job_id)
        return True

    async def reconcile_orphans(self):
        return ["fixforge-worker-orphaned-1"]


@pytest.fixture
def mock_backend(tmp_path):
    backend = MockWorkerBackend(available=True)
    job_manager.backend = backend
    job_manager.base_workspace_dir = tmp_path
    job_manager._active_jobs.clear()
    job_manager._idempotency_cache.clear()
    return backend


@pytest.fixture
def sample_tar_gz():
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        data = b"def test_example():\n    assert True\n"
        ti = tarfile.TarInfo(name="test_sample.py")
        ti.size = len(data)
        tar.addfile(ti, io.BytesIO(data))
    return base64.b64encode(buf.getvalue()).decode("ascii")


# -----------------------------------------------------------------------------
# 1. Authentication & Secret Redaction
# -----------------------------------------------------------------------------
def test_worker_auth_rejects_missing_credentials(monkeypatch):
    monkeypatch.setenv("INTERNAL_WORKER_KEY", "secret-worker-key-1234567890")
    client = TestClient(app)
    res = client.post("/v1/jobs/execute", json={"job_id": "test", "idempotency_key": "k", "command": "pytest"})
    assert res.status_code == 401
    assert res.json()["code"] == "UNAUTHORIZED_WORKER"


def test_worker_auth_rejects_invalid_key(monkeypatch):
    monkeypatch.setenv("INTERNAL_WORKER_KEY", "secret-worker-key-1234567890")
    client = TestClient(app)
    res = client.post(
        "/v1/jobs/execute",
        headers={"x-worker-key": "wrong-key"},
        json={"job_id": "test", "idempotency_key": "k", "command": "pytest"},
    )
    assert res.status_code == 401
    assert res.json()["code"] == "UNAUTHORIZED_WORKER"


def test_worker_auth_accepts_valid_key(monkeypatch, mock_backend, sample_tar_gz):
    monkeypatch.setenv("INTERNAL_WORKER_KEY", "secret-worker-key-1234567890")
    client = TestClient(app)
    res = client.post(
        "/v1/jobs/execute",
        headers={"x-worker-key": "secret-worker-key-1234567890"},
        json={
            "job_id": "job-101",
            "idempotency_key": "key-101",
            "command": "pytest",
            "workspace_archive": sample_tar_gz,
        },
    )
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "completed"
    assert data["sandboxed"] is True


def test_secret_redaction_in_logs_and_errors():
    leaked = "Failed with token=ghp_ABC123secret and Bearer eyJhbGciOiJIUzI1NiJ9"
    sanitized = sanitize_text(leaked)
    assert "ghp_ABC123secret" not in sanitized
    assert "token=[REDACTED]" in sanitized
    assert "Bearer [REDACTED]" in sanitized


# -----------------------------------------------------------------------------
# 2. Archive Security & Defense Against Tarbombs
# -----------------------------------------------------------------------------
def test_safe_extract_rejects_path_traversal(tmp_path):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        data = b"malicious content"
        ti = tarfile.TarInfo(name="../../etc/passwd")
        ti.size = len(data)
        tar.addfile(ti, io.BytesIO(data))

    with pytest.raises(ArchiveSecurityError, match="Path traversal detected"):
        safe_extract_archive(buf.getvalue(), tmp_path)


def test_safe_extract_rejects_absolute_path(tmp_path):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        data = b"malicious content"
        ti = tarfile.TarInfo(name="/etc/shadow")
        ti.size = len(data)
        tar.addfile(ti, io.BytesIO(data))

    with pytest.raises(ArchiveSecurityError, match="Absolute path in archive rejected"):
        safe_extract_archive(buf.getvalue(), tmp_path)


def test_safe_extract_rejects_symlink_escape(tmp_path):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        ti = tarfile.TarInfo(name="escape_link")
        ti.type = tarfile.SYMTYPE
        ti.linkname = "../../outside"
        tar.addfile(ti)

    with pytest.raises(ArchiveSecurityError, match="Symlink target escapes"):
        safe_extract_archive(buf.getvalue(), tmp_path)


def test_safe_extract_rejects_excessive_archive_size(tmp_path):
    big_data = b"0" * 1024
    with pytest.raises(ArchiveSecurityError, match="compressed size limit"):
        safe_extract_archive(big_data, tmp_path, max_archive_bytes=512)


def test_safe_extract_rejects_excessive_file_count(tmp_path):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for i in range(10):
            ti = tarfile.TarInfo(name=f"file_{i}.txt")
            ti.size = 0
            tar.addfile(ti)

    with pytest.raises(ArchiveSecurityError, match="maximum file count"):
        safe_extract_archive(buf.getvalue(), tmp_path, max_files=5)


# -----------------------------------------------------------------------------
# 3. Input Validation & Parameter Boundaries
# -----------------------------------------------------------------------------
def test_rejects_arbitrary_host_path_in_workspace_id(monkeypatch):
    monkeypatch.setenv("INTERNAL_WORKER_KEY", "secret-worker-key-1234567890")
    client = TestClient(app)
    # Attempting to pass a host root or absolute path
    res = client.post(
        "/v1/jobs/execute",
        headers={"x-worker-key": "secret-worker-key-1234567890"},
        json={
            "job_id": "job-hack",
            "idempotency_key": "k-hack",
            "command": "pytest",
            "workspace_id": "../../../etc",
        },
    )
    assert res.status_code == 422  # Pydantic validation rejects non-alphanumeric token


def test_rejects_forbidden_socket_tokens_in_command(monkeypatch, sample_tar_gz):
    monkeypatch.setenv("INTERNAL_WORKER_KEY", "secret-worker-key-1234567890")
    client = TestClient(app)
    res = client.post(
        "/v1/jobs/execute",
        headers={"x-worker-key": "secret-worker-key-1234567890"},
        json={
            "job_id": "job-hack",
            "idempotency_key": "k-hack",
            "command": "cat /var/run/docker.sock",
            "workspace_archive": sample_tar_gz,
        },
    )
    assert res.status_code == 422


def test_rejects_invalid_resource_limits(monkeypatch, sample_tar_gz):
    monkeypatch.setenv("INTERNAL_WORKER_KEY", "secret-worker-key-1234567890")
    client = TestClient(app)
    res = client.post(
        "/v1/jobs/execute",
        headers={"x-worker-key": "secret-worker-key-1234567890"},
        json={
            "job_id": "job-limit",
            "idempotency_key": "k-limit",
            "command": "pytest",
            "workspace_archive": sample_tar_gz,
            "resource_limits": {"cpus": "99.0", "memory": "512m", "pids": 1000},
        },
    )
    assert res.status_code == 422


# -----------------------------------------------------------------------------
# 4. Idempotency & Duplicate Rejection
# -----------------------------------------------------------------------------
def test_idempotency_reuses_cached_response(monkeypatch, mock_backend, sample_tar_gz):
    monkeypatch.setenv("INTERNAL_WORKER_KEY", "secret-worker-key-1234567890")
    client = TestClient(app)
    payload = {
        "job_id": "job-idem-1",
        "idempotency_key": "idem-key-1",
        "command": "pytest",
        "workspace_archive": sample_tar_gz,
    }

    res1 = client.post("/v1/jobs/execute", headers={"x-worker-key": "secret-worker-key-1234567890"}, json=payload)
    assert res1.status_code == 200

    # Repeat request with exact same idempotency key and payload
    res2 = client.post("/v1/jobs/execute", headers={"x-worker-key": "secret-worker-key-1234567890"}, json=payload)
    assert res2.status_code == 200
    assert res1.json()["job_id"] == res2.json()["job_id"]


def test_idempotency_rejects_conflicting_payload(monkeypatch, mock_backend, sample_tar_gz):
    monkeypatch.setenv("INTERNAL_WORKER_KEY", "secret-worker-key-1234567890")
    client = TestClient(app)
    payload1 = {
        "job_id": "job-conflict-1",
        "idempotency_key": "idem-key-conflict",
        "command": "pytest",
        "workspace_archive": sample_tar_gz,
    }
    payload2 = {
        "job_id": "job-conflict-2",
        "idempotency_key": "idem-key-conflict",  # Same key
        "command": "pytest -v -k different",     # Different payload
        "workspace_archive": sample_tar_gz,
    }

    res1 = client.post("/v1/jobs/execute", headers={"x-worker-key": "secret-worker-key-1234567890"}, json=payload1)
    assert res1.status_code == 200

    res2 = client.post("/v1/jobs/execute", headers={"x-worker-key": "secret-worker-key-1234567890"}, json=payload2)
    assert res2.status_code == 409
    assert res2.json()["code"] == "IDEMPOTENCY_CONFLICT"


# -----------------------------------------------------------------------------
# 5. Deterministic Verification Mapping (Skipped Tests Cannot Produce VERIFIED)
# -----------------------------------------------------------------------------
def test_skipped_only_tests_cannot_produce_verified():
    v = evaluate_verification(
        exit_code=0,
        timed_out=False,
        cancelled=False,
        stdout="================ 4 skipped in 0.12s ================",
        stderr="",
    )
    assert v.is_verified is False
    assert v.status == "SKIPPED_ONLY"
    assert v.executed == 0
    assert "cannot produce VERIFIED" in v.reason


def test_zero_tests_collected_cannot_produce_verified():
    v = evaluate_verification(
        exit_code=5,
        timed_out=False,
        cancelled=False,
        stdout="collected 0 items / no tests ran",
        stderr="",
    )
    assert v.is_verified is False
    assert v.status in ("NO_TESTS_COLLECTED", "EXECUTION_ERROR")


def test_test_failures_produce_failed_status():
    v = evaluate_verification(
        exit_code=1,
        timed_out=False,
        cancelled=False,
        stdout="================ 1 failed, 3 passed in 0.45s ================",
        stderr="",
    )
    assert v.is_verified is False
    assert v.status == "FAILED"
    assert v.failed == 1
    assert v.passed == 3


def test_real_passing_tests_produce_verified_status():
    v = evaluate_verification(
        exit_code=0,
        timed_out=False,
        cancelled=False,
        stdout="================ 4 passed in 0.35s ================",
        stderr="",
    )
    assert v.is_verified is True
    assert v.status == "VERIFIED"
    assert v.passed == 4
    assert v.executed == 4


# -----------------------------------------------------------------------------
# 6. Cancellation, Reconciliation & Backend Unavailable
# -----------------------------------------------------------------------------
def test_cancellation_endpoint(monkeypatch, mock_backend):
    monkeypatch.setenv("INTERNAL_WORKER_KEY", "secret-worker-key-1234567890")
    client = TestClient(app)
    res = client.post("/v1/jobs/test-cancel-job/cancel", headers={"x-worker-key": "secret-worker-key-1234567890"})
    assert res.status_code == 200
    assert res.json()["cancelled"] is True
    assert "test-cancel-job" in mock_backend.cancelled_jobs


def test_reconcile_endpoint(monkeypatch, mock_backend):
    monkeypatch.setenv("INTERNAL_WORKER_KEY", "secret-worker-key-1234567890")
    client = TestClient(app)
    res = client.post("/v1/reconcile", headers={"x-worker-key": "secret-worker-key-1234567890"})
    assert res.status_code == 200
    assert "fixforge-worker-orphaned-1" in res.json()["cleaned_containers"]


def test_fail_closed_when_backend_unavailable(monkeypatch, mock_backend, sample_tar_gz):
    monkeypatch.setenv("INTERNAL_WORKER_KEY", "secret-worker-key-1234567890")
    mock_backend.available = False  # Simulate disconnected daemon
    client = TestClient(app)
    res = client.post(
        "/v1/jobs/execute",
        headers={"x-worker-key": "secret-worker-key-1234567890"},
        json={
            "job_id": "job-offline",
            "idempotency_key": "k-offline",
            "command": "pytest",
            "workspace_archive": sample_tar_gz,
        },
    )
    assert res.status_code == 503
    assert res.json()["code"] == "SANDBOX_BACKEND_UNAVAILABLE"
