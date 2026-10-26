import os
import pytest
from app.runner import get_execution_runner, LocalExecutionRunner
from app.sandbox.docker_runner import DockerSandboxRunner
from app.sandbox.errors import SandboxUnavailable


def test_production_mode_rejects_local_runner(monkeypatch):
    """In production mode, requesting local runner immediately raises SandboxUnavailable."""
    monkeypatch.setenv("FIXFORGE_ENV", "production")
    monkeypatch.setenv("EXECUTION_MODE", "local")

    with pytest.raises(SandboxUnavailable, match="permanently disabled in production mode"):
        get_execution_runner(mode="local")


def test_production_mode_ignores_allow_local_subprocess(monkeypatch):
    """In production mode, ALLOW_LOCAL_SUBPROCESS=true cannot override Docker requirement."""
    monkeypatch.setenv("FIXFORGE_ENV", "production")
    monkeypatch.setenv("ALLOW_LOCAL_SUBPROCESS", "true")

    with pytest.raises(SandboxUnavailable, match="permanently disabled in production mode"):
        get_execution_runner()


def test_production_mode_node_env_guard(monkeypatch):
    """NODE_ENV=production also enforces production sandbox runner constraints."""
    monkeypatch.delenv("FIXFORGE_ENV", raising=False)
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.setenv("ALLOW_LOCAL_SUBPROCESS", "true")

    with pytest.raises(SandboxUnavailable, match="permanently disabled in production mode"):
        get_execution_runner(mode="local")


def test_production_mode_returns_docker_runner_when_mode_is_docker(monkeypatch):
    """In production mode, standard docker mode returns DockerSandboxRunner."""
    monkeypatch.setenv("FIXFORGE_ENV", "production")
    monkeypatch.delenv("ALLOW_LOCAL_SUBPROCESS", raising=False)

    runner = get_execution_runner(mode="docker")
    assert isinstance(runner, DockerSandboxRunner)


def test_development_mode_allows_explicit_local_subprocess(monkeypatch):
    """In development mode, ALLOW_LOCAL_SUBPROCESS=true allows LocalExecutionRunner."""
    monkeypatch.delenv("FIXFORGE_ENV", raising=False)
    monkeypatch.setenv("NODE_ENV", "development")
    monkeypatch.setenv("ALLOW_LOCAL_SUBPROCESS", "true")

    runner = get_execution_runner(mode="local")
    assert isinstance(runner, LocalExecutionRunner)
    assert runner.runner_label == "local_dev_fallback"
