import asyncio
from pathlib import Path
import pytest
from fastapi.testclient import TestClient

from app.graph import build_self_correction_graph
from app.main import app
from app.patch_schemas import GeneratedPatch
from app.providers.factory import set_global_llm_provider
from app.providers.mock import MockLLMProvider


@pytest.fixture(autouse=True)
def reset_demo_repo():
    """Ensure calculator.py in demo repo is always reset to initial buggy state before and after each test."""
    workspace_root = Path(__file__).resolve().parent.parent.parent
    demo_calc = workspace_root / "examples" / "buggy-python-project" / "calculator.py"
    initial_content = (
        'def divide(total: float, count: int) -> float:\n'
        '    """Return the average value for a total and count."""\n'
        '    if count == 0:\n'
        '        return -1\n'
        '    return total / count\n\n\n'
        'def clamp(value: float, lower: float = 0, upper: float = 100) -> float:\n'
        '    if lower > upper:\n'
        '        raise ValueError("lower bound must not exceed upper bound")\n'
        '    return min(max(value, lower), upper)\n'
    )
    demo_calc.write_text(initial_content, encoding="utf-8")
    yield
    demo_calc.write_text(initial_content, encoding="utf-8")
    # Clean backups
    backups_dir = workspace_root / "examples" / "buggy-python-project" / ".fixforge_backups"
    import shutil
    if backups_dir.is_dir():
        shutil.rmtree(backups_dir, ignore_errors=True)


def test_self_correction_two_attempts_success(monkeypatch):
    """Scenario A: Attempt 1 fails verification, rollback occurs, Attempt 2 succeeds -> VERIFIED."""
    monkeypatch.setenv("EXECUTION_MODE", "local")
    provider = MockLLMProvider(scenario="two_attempts_success")
    set_global_llm_provider(provider)

    async def _run():
        workspace_root = Path(__file__).resolve().parent.parent.parent
        demo_repo = workspace_root / "examples" / "buggy-python-project"

        graph = build_self_correction_graph()
        initial_state = {
            "job_id": "m5-two-attempts-job",
            "repository_path": str(demo_repo),
            "attempt_number": 1,
            "max_attempts": 3,
            "max_repair_time": 600.0,
            "max_llm_calls": 10,
            "total_llm_calls": 0,
            "attempt_history": [],
            "agent_events": [],
            "timestamps": {},
        }

        final_state = await graph.ainvoke(initial_state)

        # Baseline verification
        assert final_state["baseline_result"]["failed"] == 1

        # Attempt count must be 2
        history = final_state.get("attempt_history", [])
        assert len(history) == 2

        # Attempt 1 failed and rolled back
        assert history[0]["status"] == "FAILED"
        assert history[0]["rollback_performed"] is True

        # Attempt 2 passed
        assert history[1]["status"] == "PASSED"
        assert history[1]["verification"]["passed"] == 5
        assert history[1]["verification"]["failed"] == 0

        # Final state must be VERIFIED
        assert final_state.get("final_status") == "VERIFIED"
        assert final_state.get("is_verified") is True

        # Event flow verification
        events = [e.get("event") for e in final_state.get("agent_events", [])]
        assert "VERIFICATION_STARTED" in events
        assert "VERIFICATION_FAILED" in events
        assert "ROLLBACK_STARTED" in events
        assert "ROLLBACK_COMPLETED" in events
        assert "VERIFICATION_COMPLETED" in events
        assert "REPAIR_VERIFIED" in events

    asyncio.run(_run())
    set_global_llm_provider(None)


def test_self_correction_max_attempts_exhausted(monkeypatch):
    """Scenario B: All attempts fail -> FAILED at max_attempts limit, no attempt 4 occurs."""
    monkeypatch.setenv("EXECUTION_MODE", "local")
    provider = MockLLMProvider(scenario="all_fail")
    set_global_llm_provider(provider)

    async def _run():
        workspace_root = Path(__file__).resolve().parent.parent.parent
        demo_repo = workspace_root / "examples" / "buggy-python-project"

        graph = build_self_correction_graph()
        initial_state = {
            "job_id": "m5-all-fail-job",
            "repository_path": str(demo_repo),
            "attempt_number": 1,
            "max_attempts": 3,
            "max_repair_time": 600.0,
            "max_llm_calls": 10,
            "total_llm_calls": 0,
            "attempt_history": [],
            "agent_events": [],
            "timestamps": {},
        }

        final_state = await graph.ainvoke(initial_state)

        history = final_state.get("attempt_history", [])
        assert len(history) == 3
        for item in history:
            assert item["status"] == "FAILED"
            assert item["rollback_performed"] is True

        assert final_state.get("final_status") == "FAILED"
        assert final_state.get("is_verified") is False

        events = [e.get("event") for e in final_state.get("agent_events", [])]
        assert "REPAIR_FAILED" in events

    asyncio.run(_run())
    set_global_llm_provider(None)


def test_self_correction_regression_detected(monkeypatch):
    """Scenario C: Patch causes a new regression -> REGRESSION_DETECTED and rolled back."""
    monkeypatch.setenv("EXECUTION_MODE", "local")
    provider = MockLLMProvider(scenario="regression")
    set_global_llm_provider(provider)

    async def _run():
        workspace_root = Path(__file__).resolve().parent.parent.parent
        demo_repo = workspace_root / "examples" / "buggy-python-project"

        graph = build_self_correction_graph()
        initial_state = {
            "job_id": "m5-regression-job",
            "repository_path": str(demo_repo),
            "attempt_number": 1,
            "max_attempts": 1,  # Stop after 1 attempt
            "max_repair_time": 600.0,
            "max_llm_calls": 10,
            "total_llm_calls": 0,
            "attempt_history": [],
            "agent_events": [],
            "timestamps": {},
        }

        final_state = await graph.ainvoke(initial_state)

        history = final_state.get("attempt_history", [])
        assert len(history) == 1
        assert history[0]["status"] == "REGRESSION_DETECTED"
        assert history[0]["rollback_performed"] is True

        events = [e.get("event") for e in final_state.get("agent_events", [])]
        assert "REGRESSION_DETECTED" in events
        assert "ROLLBACK_COMPLETED" in events

    asyncio.run(_run())
    set_global_llm_provider(None)


def test_self_correction_duplicate_patch_detection(monkeypatch):
    """Scenario D: Duplicate patch generation is detected and tracked."""
    monkeypatch.setenv("EXECUTION_MODE", "local")
    same_patch = GeneratedPatch(
        files=["calculator.py"],
        diff="--- a/calculator.py\n+++ b/calculator.py\n@@ -3,3 +3,3 @@\n     if count == 0:\n-        return -1\n+        return 99\n     return total / count\n",
        explanation="Identical patch generated repeatedly",
    )
    provider = MockLLMProvider(override_patch=same_patch)
    set_global_llm_provider(provider)

    async def _run():
        workspace_root = Path(__file__).resolve().parent.parent.parent
        demo_repo = workspace_root / "examples" / "buggy-python-project"

        graph = build_self_correction_graph()
        initial_state = {
            "job_id": "m5-dup-job",
            "repository_path": str(demo_repo),
            "attempt_number": 1,
            "max_attempts": 2,
            "max_repair_time": 600.0,
            "max_llm_calls": 10,
            "total_llm_calls": 0,
            "attempt_history": [],
            "agent_events": [],
            "timestamps": {},
        }

        final_state = await graph.ainvoke(initial_state)
        events = [e.get("event") for e in final_state.get("agent_events", [])]
        assert "DUPLICATE_PATCH_DETECTED" in events

    asyncio.run(_run())
    set_global_llm_provider(None)


def test_self_correction_requires_review(monkeypatch):
    """Scenario E: Modifying protected infrastructure stops autonomous loop at REQUIRES_REVIEW."""
    monkeypatch.setenv("EXECUTION_MODE", "local")
    provider = MockLLMProvider(scenario="requires_review")
    set_global_llm_provider(provider)

    async def _run():
        workspace_root = Path(__file__).resolve().parent.parent.parent
        demo_repo = workspace_root / "examples" / "buggy-python-project"

        graph = build_self_correction_graph()
        initial_state = {
            "job_id": "m5-review-job",
            "repository_path": str(demo_repo),
            "attempt_number": 1,
            "max_attempts": 3,
            "max_repair_time": 600.0,
            "max_llm_calls": 10,
            "total_llm_calls": 0,
            "attempt_history": [],
            "agent_events": [],
            "timestamps": {},
        }

        final_state = await graph.ainvoke(initial_state)
        assert final_state.get("final_status") == "REQUIRES_REVIEW"
        assert final_state.get("is_verified") is False

        events = [e.get("event") for e in final_state.get("agent_events", [])]
        assert "REPAIR_REQUIRES_REVIEW" in events

    asyncio.run(_run())
    set_global_llm_provider(None)


def test_self_correction_budget_limit(monkeypatch):
    """Scenario F: Budget exhaustion halts loop with FAILED."""
    monkeypatch.setenv("EXECUTION_MODE", "local")
    provider = MockLLMProvider(scenario="all_fail")
    set_global_llm_provider(provider)

    async def _run():
        workspace_root = Path(__file__).resolve().parent.parent.parent
        demo_repo = workspace_root / "examples" / "buggy-python-project"

        graph = build_self_correction_graph()
        initial_state = {
            "job_id": "m5-budget-job",
            "repository_path": str(demo_repo),
            "attempt_number": 1,
            "max_attempts": 5,
            "max_repair_time": 600.0,
            "max_llm_calls": 2,  # Budget of only 2 LLM calls!
            "total_llm_calls": 0,
            "attempt_history": [],
            "agent_events": [],
            "timestamps": {},
        }

        final_state = await graph.ainvoke(initial_state)
        assert final_state.get("final_status") == "FAILED"
        # It stopped after attempt 1 because 3 LLM calls exceeded max_llm_calls=2
        assert len(final_state.get("attempt_history", [])) == 1

    asyncio.run(_run())
    set_global_llm_provider(None)


def test_api_self_correction_endpoint(monkeypatch):
    """Test POST /agent/self-correction endpoint on FastAPI app."""
    monkeypatch.setenv("EXECUTION_MODE", "local")
    provider = MockLLMProvider(scenario="two_attempts_success")
    set_global_llm_provider(provider)
    client = TestClient(app)

    workspace_root = Path(__file__).resolve().parent.parent.parent
    demo_repo = workspace_root / "examples" / "buggy-python-project"

    res = client.post(
        "/agent/self-correction",
        json={
            "job_id": "test-api-self-corr",
            "repository_path": str(demo_repo),
            "max_attempts": 3,
        },
    )
    assert res.status_code == 200
    data = res.json()
    assert data["job_id"] == "test-api-self-corr"
    assert data["status"] == "VERIFIED"
    assert data["is_verified"] is True
    assert data["attempt_count"] == 2
    assert len(data["attempt_history"]) == 2
    set_global_llm_provider(None)


def test_api_verify_endpoint(monkeypatch):
    """Test POST /agent/verify endpoint on FastAPI app."""
    monkeypatch.setenv("EXECUTION_MODE", "local")
    client = TestClient(app)

    workspace_root = Path(__file__).resolve().parent.parent.parent
    demo_repo = workspace_root / "examples" / "buggy-python-project"

    res = client.post(
        "/agent/verify",
        json={
            "job_id": "test-verify-ep",
            "repository_path": str(demo_repo),
            "test_command": "pytest",
            "baseline_failed": 1,
            "baseline_failure_sigs": [{"test_name": "test_divide_by_zero_is_safe"}],
        },
    )
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "FAILED"
    assert data["failed"] == 1
    assert data["passed"] == 4
    assert data["regression_detected"] is False
