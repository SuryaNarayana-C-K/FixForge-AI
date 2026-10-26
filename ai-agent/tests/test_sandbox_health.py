from unittest.mock import patch
from fastapi.testclient import TestClient
from app.main import app
from app.runner import LocalExecutionRunner, get_execution_runner
from app.sandbox.docker_runner import DockerSandboxRunner


def test_get_execution_runner_selection(monkeypatch):
    monkeypatch.setenv("EXECUTION_MODE", "docker")
    r1 = get_execution_runner()
    assert isinstance(r1, DockerSandboxRunner)

    monkeypatch.setenv("EXECUTION_MODE", "local")
    r2 = get_execution_runner()
    assert isinstance(r2, LocalExecutionRunner)


def test_sandbox_health_endpoint():
    client = TestClient(app)

    with patch.object(DockerSandboxRunner, "is_docker_available", return_value=(True, "24.0.7", None)):
        response = client.get("/sandbox/health")
        assert response.status_code == 200
        data = response.json()
        assert data["docker_available"] is True
        assert data["runner"] == "docker"
        assert data["version"] == "24.0.7"

    with patch.object(DockerSandboxRunner, "is_docker_available", return_value=(False, None, "Docker not running")):
        response = client.get("/sandbox/health")
        assert response.status_code == 200
        data = response.json()
        assert data["docker_available"] is False
        assert "Docker not running" in data["detail"]


def test_sandbox_run_endpoint_local_mode(monkeypatch):
    # When execution mode is local for trusted test verification
    monkeypatch.setenv("EXECUTION_MODE", "local")
    client = TestClient(app)

    response = client.post(
        "/sandbox/run",
        json={
            "job_id": "test-job-sandbox",
            "repository_path": "examples/buggy-python-project",
            "command": "pytest",
            "timeout": 60,
        },
    )
    assert response.status_code == 200
    data = response.json()
    assert data["status"] in ["completed", "failed"]
    assert "exit_code" in data
    assert "duration" in data


def test_sandbox_run_endpoint_workspace_traversal_rejected():
    client = TestClient(app)
    response = client.post(
        "/sandbox/run",
        json={
            "job_id": "test-hack",
            "repository_path": "../../etc/passwd",
            "command": "pytest",
        },
    )
    assert response.status_code == 400
    assert "security violation" in response.json()["detail"].lower()
