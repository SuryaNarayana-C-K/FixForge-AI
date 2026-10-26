from pathlib import Path
import pytest
from app.sandbox.errors import SandboxWorkspaceViolation
from app.sandbox.security import (
    ALLOWED_ENV_VARS,
    build_safe_container_env,
    sanitize_command,
    validate_sandbox_workspace,
)


def test_validate_sandbox_workspace_valid(tmp_path):
    repo_dir = tmp_path / "my-repo"
    repo_dir.mkdir()
    validated = validate_sandbox_workspace(repo_dir, base_dir=tmp_path)
    assert validated == repo_dir.resolve()


def test_validate_sandbox_workspace_traversal_fails(tmp_path):
    with pytest.raises(SandboxWorkspaceViolation):
        validate_sandbox_workspace("../../etc/passwd", base_dir=tmp_path)


def test_validate_sandbox_workspace_escape_fails(tmp_path):
    outside = tmp_path.parent / "unauthorized"
    with pytest.raises(SandboxWorkspaceViolation):
        validate_sandbox_workspace(outside, base_dir=tmp_path)


def test_sanitize_command_valid():
    cmd = "pytest tests/test_calc.py"
    assert sanitize_command(cmd) == cmd


def test_sanitize_command_rejects_empty():
    with pytest.raises(ValueError, match="cannot be empty"):
        sanitize_command("   ")


def test_sanitize_command_rejects_docker_socket():
    with pytest.raises(ValueError, match="forbidden token"):
        sanitize_command("cat /var/run/docker.sock")


def test_environment_isolation_strips_secrets():
    extra_env = {
        "OPENAI_API_KEY": "sk-12345secret",
        "DATABASE_URL": "postgres://user:pass@localhost:5432/db",
        "GITHUB_TOKEN": "ghp_abcxyz",
        "AWS_SECRET_ACCESS_KEY": "supersecretkey",
        "SAFE_CUSTOM_VAR": "public_value",
    }
    safe = build_safe_container_env(extra_env)

    # Allowed defaults are preserved
    assert safe["PYTHONUNBUFFERED"] == "1"
    assert safe["PYTHONDONTWRITEBYTECODE"] == "1"
    assert safe["SAFE_CUSTOM_VAR"] == "public_value"

    # Secrets are strictly stripped
    assert "OPENAI_API_KEY" not in safe
    assert "DATABASE_URL" not in safe
    assert "GITHUB_TOKEN" not in safe
    assert "AWS_SECRET_ACCESS_KEY" not in safe
