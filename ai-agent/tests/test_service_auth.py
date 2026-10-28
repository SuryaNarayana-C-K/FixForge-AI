import pytest
from fastapi.testclient import TestClient
from app.main import app


def test_service_auth_allows_healthz_without_key(monkeypatch):
    monkeypatch.setenv("INTERNAL_SERVICE_KEY", "very-strong-service-secret-key-32chars-min")
    client = TestClient(app)
    res = client.get("/healthz")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"


def test_service_auth_allows_health_without_key(monkeypatch):
    monkeypatch.setenv("INTERNAL_SERVICE_KEY", "very-strong-service-secret-key-32chars-min")
    client = TestClient(app)
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json()["status"] in ("ok", "healthy")


def test_service_auth_rejects_missing_key_on_protected_endpoints(monkeypatch):
    monkeypatch.setenv("INTERNAL_SERVICE_KEY", "very-strong-service-secret-key-32chars-min")
    client = TestClient(app)
    res = client.get("/agent/capabilities")
    assert res.status_code == 401
    assert res.json()["code"] == "UNAUTHORIZED_SERVICE"

    res_sandbox = client.post("/sandbox/run", json={"command": "echo test"})
    assert res_sandbox.status_code == 401
    assert res_sandbox.json()["code"] == "UNAUTHORIZED_SERVICE"


def test_service_auth_rejects_invalid_key(monkeypatch):
    monkeypatch.setenv("INTERNAL_SERVICE_KEY", "very-strong-service-secret-key-32chars-min")
    client = TestClient(app)
    res = client.get("/agent/capabilities", headers={"x-service-key": "invalid-wrong-key"})
    assert res.status_code == 401
    assert res.json()["code"] == "UNAUTHORIZED_SERVICE"


def test_service_auth_accepts_valid_x_service_key(monkeypatch):
    monkeypatch.setenv("INTERNAL_SERVICE_KEY", "very-strong-service-secret-key-32chars-min")
    client = TestClient(app)
    res = client.get("/agent/capabilities", headers={"x-service-key": "very-strong-service-secret-key-32chars-min"})
    assert res.status_code == 200
    assert isinstance(res.json(), list)


def test_service_auth_accepts_valid_bearer_token(monkeypatch):
    monkeypatch.setenv("INTERNAL_SERVICE_KEY", "very-strong-service-secret-key-32chars-min")
    client = TestClient(app)
    res = client.get("/agent/capabilities", headers={"authorization": "Bearer very-strong-service-secret-key-32chars-min"})
    assert res.status_code == 200
    assert isinstance(res.json(), list)
