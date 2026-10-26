import asyncio
import os
from pathlib import Path
import pytest

from app.graph.nodes.verification import verification_testing_node


def test_verification_testing_node_completes_with_real_execution(monkeypatch):
    """
    Deterministic test for verification_testing_node:
    1. Receives a workspace (demo repository)
    2. Executes pytest via LocalExecutionRunner
    3. Receives ExecutionResult
    4. Parses the result
    5. Populates verification state
    6. Returns control
    """
    monkeypatch.setenv("EXECUTION_MODE", "local")

    workspace_root = Path(__file__).resolve().parent.parent.parent
    demo_repo = workspace_root / "examples" / "buggy-python-project"

    # Ensure calculator.py has buggy code for baseline test
    calc_file = demo_repo / "calculator.py"
    calc_text = calc_file.read_text(encoding="utf-8")
    if "return 0" in calc_text:
        calc_file.write_text(calc_text.replace("return 0", "return -1"), encoding="utf-8")

    initial_state = {
        "job_id": "test-verif-node-job",
        "repository_path": str(demo_repo),
        "test_command": "pytest",
        "test_framework": "pytest",
        "attempt_number": 1,
        "failure_signatures": [{"test_name": "test_divide_by_zero_is_safe"}],
        "baseline_result": {"failed": 1, "passed": 4, "total": 5},
        "timestamps": {},
        "agent_events": [],
    }

    async def _run():
        res = await verification_testing_node(initial_state)
        # Assert node completes and populates state
        assert res is not None
        assert res["current_state"] == "VERIFICATION_TESTING"
        assert "verification_result" in res
        v = res["verification_result"]
        assert v["total"] == 5
        assert v["passed"] == 4
        assert v["failed"] == 1
        assert v["status"] == "FAILED"
        assert v["timed_out"] is False
        assert len(res["agent_events"]) > 0
        assert "timestamps" in res
        return res

    result = asyncio.run(_run())
    assert result["verification_result"]["total"] == 5


def test_verification_node_exit_code_5_fails_and_does_not_verify(monkeypatch):
    """Exit code 5 (no tests collected) must produce status FAILED and rollback, NEVER VERIFIED."""
    from unittest.mock import AsyncMock, MagicMock
    from app.runner import ExecutionResult
    from app.graph.nodes.verification import should_verify_or_rollback

    mock_runner = MagicMock()
    mock_runner.run = AsyncMock(return_value=ExecutionResult(
        command="pytest",
        stdout="collected 0 items\n\n============================ no tests ran in 0.07s ============================\n",
        stderr="",
        exit_code=5,
        duration=0.07,
    ))
    monkeypatch.setattr("app.graph.nodes.verification.get_execution_runner", lambda: mock_runner)

    state = {
        "job_id": "test-ec5",
        "repository_path": ".",
        "test_command": "pytest",
        "test_framework": "pytest",
        "attempt_number": 1,
        "failure_signatures": [],
        "baseline_result": {"failed": 0, "passed": 0, "total": 0, "exit_code": 5},
    }

    res = asyncio.run(verification_testing_node(state))
    v = res["verification_result"]
    assert v["status"] in ("FAILED", "NO_TESTS_COLLECTED")
    assert v["exit_code"] == 5
    assert v["total"] == 0
    assert v["passed"] == 0

    edge_decision = should_verify_or_rollback(res)
    assert edge_decision == "rollback"


def test_verification_node_skipped_only_cannot_verify(monkeypatch):
    """Skipped-only test runs must produce status FAILED or SKIPPED_ONLY and rollback, NEVER VERIFIED."""
    from unittest.mock import AsyncMock, MagicMock
    from app.runner import ExecutionResult
    from app.graph.nodes.verification import should_verify_or_rollback

    mock_runner = MagicMock()
    mock_runner.run = AsyncMock(return_value=ExecutionResult(
        command="pytest",
        stdout="collected 3 items\n\n============================== 3 skipped in 0.05s ==============================\n",
        stderr="",
        exit_code=0,
        duration=0.05,
    ))
    monkeypatch.setattr("app.graph.nodes.verification.get_execution_runner", lambda: mock_runner)

    state = {
        "job_id": "test-skipped",
        "repository_path": ".",
        "test_command": "pytest",
        "test_framework": "pytest",
        "attempt_number": 1,
        "failure_signatures": [],
        "baseline_result": {"failed": 0, "passed": 0, "total": 3},
    }

    res = asyncio.run(verification_testing_node(state))
    v = res["verification_result"]
    assert v["status"] in ("FAILED", "SKIPPED_ONLY")
    assert v["passed"] == 0
    assert v["skipped"] == 3

    edge_decision = should_verify_or_rollback(res)
    assert edge_decision == "rollback"


def test_should_verify_or_rollback_requires_positive_executed_tests():
    from app.graph.nodes.verification import should_verify_or_rollback

    # 0 total
    assert should_verify_or_rollback({"verification_result": {"status": "PASSED", "exit_code": 0, "total": 0, "passed": 0, "failed": 0, "skipped": 0, "regression_detected": False}}) == "rollback"

    # All skipped
    assert should_verify_or_rollback({"verification_result": {"status": "PASSED", "exit_code": 0, "total": 2, "passed": 0, "failed": 0, "skipped": 2, "regression_detected": False}}) == "rollback"

    # Non-zero exit code
    assert should_verify_or_rollback({"verification_result": {"status": "PASSED", "exit_code": 5, "total": 0, "passed": 0, "failed": 0, "skipped": 0, "regression_detected": False}}) == "rollback"

    # Genuinely verified: exit code 0, positive total & passed, 0 failed, no regression
    assert should_verify_or_rollback({"verification_result": {"status": "PASSED", "exit_code": 0, "total": 5, "passed": 5, "failed": 0, "skipped": 0, "errors": 0, "regression_detected": False}}) == "verified"

