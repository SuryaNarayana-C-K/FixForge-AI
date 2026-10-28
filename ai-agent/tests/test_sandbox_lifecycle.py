from pathlib import Path
from app.sandbox.config import SandboxConfig
from app.sandbox.lifecycle import (
    TRUNCATION_MARKER,
    build_docker_run_args,
    generate_container_name,
    truncate_output,
)


def test_generate_container_name_unique_and_sanitized():
    name1 = generate_container_name("job-12345", run_id="run-001")
    name2 = generate_container_name("job-12345", run_id="run-002")
    assert name1 == "fixforge-sandbox-job-12345-run-001"
    assert name2 == "fixforge-sandbox-job-12345-run-002"
    assert name1 != name2


def test_concurrent_container_names_do_not_collide():
    names = {generate_container_name("job-abc") for _ in range(50)}
    assert len(names) == 50


def test_build_docker_run_args_enforces_limits_and_isolation(tmp_path):
    repo_dir = tmp_path / "test-repo"
    repo_dir.mkdir()

    config = SandboxConfig(
        memory_limit="256m",
        cpus_limit="1.5",
        pids_limit=64,
        user="testuser",
        network_mode="none",
        image_name="test-image:latest",
    )

    args = build_docker_run_args(
        container_name="test-container-1",
        command="pytest -v",
        workspace_path=repo_dir,
        config=config,
    )

    # Check command structure
    assert args[0] == "docker"
    assert args[1] == "run"
    assert "--name" in args and args[args.index("--name") + 1] == "test-container-1"
    assert "--user" in args and args[args.index("--user") + 1] == "testuser"
    assert "--network" in args and args[args.index("--network") + 1] == "none"
    assert "--memory" in args and args[args.index("--memory") + 1] == "256m"
    assert "--cpus" in args and args[args.index("--cpus") + 1] == "1.5"
    assert "--pids-limit" in args and args[args.index("--pids-limit") + 1] == "64"

    # Verify workspace volume mount
    volume_arg = [a for a in args if ":/workspace:rw" in a]
    assert len(volume_arg) == 1

    # Verify working dir
    assert "-w" in args and args[args.index("-w") + 1] == "/workspace"

    # Verify non-root user
    assert "--user" in args and args[args.index("--user") + 1] == "testuser"

    # Verify image and command
    assert "test-image:latest" in args
    assert args[-3:] == ["sh", "-c", "pytest -v"]


def test_truncate_output_within_limit():
    short_text = "All tests passed successfully."
    assert truncate_output(short_text, 1000) == short_text


def test_truncate_output_exceeding_limit():
    long_text = "x" * 200
    truncated = truncate_output(long_text, 50)
    assert len(truncated) <= 50 + len(TRUNCATION_MARKER)
    assert TRUNCATION_MARKER in truncated
