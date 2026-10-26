import asyncio
from unittest.mock import AsyncMock, patch
import pytest
from app.sandbox.config import SandboxConfig
from app.sandbox.docker_runner import DockerSandboxRunner
from app.sandbox.errors import SandboxUnavailable


@pytest.fixture
def mock_repo(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    return repo


def test_docker_runner_unavailable_raises(mock_repo):
    runner = DockerSandboxRunner(base_dir=mock_repo.parent)

    async def _test():
        with patch.object(DockerSandboxRunner, "is_docker_available", return_value=(False, None, "Daemon offline")):
            with pytest.raises(SandboxUnavailable, match="Daemon offline"):
                await runner.run(command="pytest", cwd=mock_repo)

    asyncio.run(_test())


def test_docker_runner_success(mock_repo):
    runner = DockerSandboxRunner(base_dir=mock_repo.parent)

    async def _test():
        mock_proc = AsyncMock()
        mock_proc.communicate.return_value = (b"collected 5 items\n5 passed", b"")
        mock_proc.returncode = 0

        with patch.object(DockerSandboxRunner, "is_docker_available", return_value=(True, "24.0", None)), \
             patch("asyncio.create_subprocess_exec", return_value=mock_proc), \
             patch("app.sandbox.docker_runner.cleanup_container", new_callable=AsyncMock) as mock_cleanup:

            result = await runner.run(command="pytest", cwd=mock_repo, job_id="job-1")

            assert result.status == "completed"
            assert result.exit_code == 0
            assert "5 passed" in result.stdout
            assert result.sandboxed is True
            assert result.timed_out is False
            assert result.container_id is not None
            assert mock_cleanup.called

    asyncio.run(_test())


def test_docker_runner_failure(mock_repo):
    runner = DockerSandboxRunner(base_dir=mock_repo.parent)

    async def _test():
        mock_proc = AsyncMock()
        mock_proc.communicate.return_value = (b"collected 3 items\n1 failed", b"AssertionError")
        mock_proc.returncode = 1

        with patch.object(DockerSandboxRunner, "is_docker_available", return_value=(True, "24.0", None)), \
             patch("asyncio.create_subprocess_exec", return_value=mock_proc), \
             patch("app.sandbox.docker_runner.cleanup_container", new_callable=AsyncMock) as mock_cleanup:

            result = await runner.run(command="pytest", cwd=mock_repo, job_id="job-2")

            assert result.status == "failed"
            assert result.exit_code == 1
            assert "1 failed" in result.stdout
            assert "AssertionError" in result.stderr
            assert result.sandboxed is True
            assert mock_cleanup.called

    asyncio.run(_test())


def test_docker_runner_timeout(mock_repo):
    runner = DockerSandboxRunner(config=SandboxConfig(timeout_seconds=0.1), base_dir=mock_repo.parent)

    async def _test():
        mock_proc = AsyncMock()
        mock_proc.communicate.side_effect = asyncio.TimeoutError()

        with patch.object(DockerSandboxRunner, "is_docker_available", return_value=(True, "24.0", None)), \
             patch("asyncio.create_subprocess_exec", return_value=mock_proc), \
             patch("app.sandbox.docker_runner.cleanup_container", new_callable=AsyncMock) as mock_cleanup:

            result = await runner.run(command="pytest", cwd=mock_repo, timeout=0.1, job_id="job-timeout")

            assert result.status == "timeout"
            assert result.timed_out is True
            assert result.exit_code == -1
            assert "timed out" in result.stderr
            assert mock_cleanup.called

    asyncio.run(_test())


def test_docker_runner_cleanup_on_exception(mock_repo):
    runner = DockerSandboxRunner(base_dir=mock_repo.parent)

    async def _test():
        with patch.object(DockerSandboxRunner, "is_docker_available", return_value=(True, "24.0", None)), \
             patch("asyncio.create_subprocess_exec", side_effect=RuntimeError("Subprocess failed")), \
             patch("app.sandbox.docker_runner.cleanup_container", new_callable=AsyncMock) as mock_cleanup:

            result = await runner.run(command="pytest", cwd=mock_repo, job_id="job-err")
            assert result.status == "failed"
            assert "Subprocess failed" in result.stderr
            assert mock_cleanup.called

    asyncio.run(_test())

