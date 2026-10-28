import asyncio
import sys
from pathlib import Path

from app.runner import LocalExecutionRunner


def test_local_runner_success(tmp_path: Path):
    async def _test():
        runner = LocalExecutionRunner()
        cmd = f'"{sys.executable}" -c "print(\'runner_ok\')"'
        res = await runner.run(command=cmd, cwd=tmp_path, timeout=5.0)

        assert res.exit_code == 0
        assert "runner_ok" in res.stdout
        assert res.timed_out is False
        assert res.status == "completed"

    asyncio.run(_test())


def test_local_runner_timeout(tmp_path: Path):
    async def _test():
        runner = LocalExecutionRunner()
        # Command that sleeps longer than timeout
        cmd = f'"{sys.executable}" -c "import time; time.sleep(5)"'
        res = await runner.run(command=cmd, cwd=tmp_path, timeout=0.5)

        assert res.timed_out is True
        assert res.status == "timeout"
        assert res.exit_code == -1

    asyncio.run(_test())


def test_local_runner_against_demo_repository():
    """Verify LocalExecutionRunner executes pytest against the real demo repository."""
    from app.parser import PytestOutputParser
    async def _test():
        workspace_root = Path(__file__).resolve().parent.parent.parent
        demo_repo = workspace_root / "examples" / "buggy-python-project"

        # Ensure demo repo is in initial buggy state
        calc_file = demo_repo / "calculator.py"
        calc_content = calc_file.read_text(encoding="utf-8")
        if "return 0" in calc_content:
            calc_file.write_text(calc_content.replace("return 0", "return -1"), encoding="utf-8")

        runner = LocalExecutionRunner()
        res = await runner.run(command="pytest", cwd=demo_repo, timeout=30.0)

        # Assert runner results
        assert res.exit_code is not None
        assert res.stdout is not None
        assert res.stderr is not None
        assert res.duration > 0
        assert res.timed_out is False
        assert res.status == "failed"
        assert res.exit_code == 1

        # Parse test results
        parsed = PytestOutputParser.parse(
            stdout=res.stdout,
            stderr=res.stderr,
            exit_code=res.exit_code,
            duration=res.duration,
            command="pytest",
        )
        assert parsed.total == 5
        assert parsed.passed == 4
        assert parsed.failed == 1
        assert any(f.test_name == "test_divide_by_zero_is_safe" for f in parsed.failures)

    asyncio.run(_test())
