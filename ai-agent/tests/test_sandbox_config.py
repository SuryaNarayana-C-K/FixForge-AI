import os
from app.sandbox.config import SandboxConfig


def test_sandbox_config_defaults():
    config = SandboxConfig()
    assert config.timeout_seconds == 120.0
    assert config.memory_limit == "512m"
    assert config.cpus_limit == "1"
    assert config.pids_limit == 128
    assert config.output_limit_bytes == 5242880
    assert config.image_name == "fixforge-sandbox:latest"
    assert config.user == "sandboxuser"
    assert config.network_mode == "none"
    assert config.execution_mode == "docker"


def test_sandbox_config_from_env(monkeypatch):
    monkeypatch.setenv("SANDBOX_TIMEOUT", "60")
    monkeypatch.setenv("SANDBOX_MEMORY", "256m")
    monkeypatch.setenv("SANDBOX_CPUS", "2")
    monkeypatch.setenv("SANDBOX_PIDS_LIMIT", "64")
    monkeypatch.setenv("SANDBOX_OUTPUT_LIMIT", "1024")
    monkeypatch.setenv("SANDBOX_IMAGE", "custom-runner:1.0")
    monkeypatch.setenv("SANDBOX_USER", "unprivileged")
    monkeypatch.setenv("SANDBOX_NETWORK", "bridge")
    monkeypatch.setenv("EXECUTION_MODE", "local")

    config = SandboxConfig.from_env()
    assert config.timeout_seconds == 60.0
    assert config.memory_limit == "256m"
    assert config.cpus_limit == "2"
    assert config.pids_limit == 64
    assert config.output_limit_bytes == 1024
    assert config.image_name == "custom-runner:1.0"
    assert config.user == "unprivileged"
    assert config.network_mode == "bridge"
    assert config.execution_mode == "local"
