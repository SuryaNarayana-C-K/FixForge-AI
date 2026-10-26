import asyncio
from pathlib import Path
import pytest

from app.graph.builder import build_self_correction_graph
from app.providers.factory import set_global_llm_provider
from app.providers.mock import MockLLMProvider


def test_m5_repair_workflow_progresses_through_verification(monkeypatch):
    """
    Deterministic regression integration test proving:
    Repair starts -> Analysis -> Patch -> Verification -> Verification result returned
    Fails if the verification node hangs.
    Uses MockLLMProvider (no real LLM).
    """
    monkeypatch.setenv("EXECUTION_MODE", "local")
    provider = MockLLMProvider()
    set_global_llm_provider(provider)

    workspace_root = Path(__file__).resolve().parent.parent.parent
    demo_repo = workspace_root / "examples" / "buggy-python-project"

    # Reset calculator.py to buggy state
    calc_file = demo_repo / "calculator.py"
    calc_text = calc_file.read_text(encoding="utf-8")
    if "return 0" in calc_text:
        calc_file.write_text(calc_text.replace("return 0", "return -1"), encoding="utf-8")

    graph = build_self_correction_graph()
    initial_state = {
        "job_id": "integration-regression-m5",
        "repository_path": str(demo_repo),
        "attempt_number": 1,
        "max_attempts": 3,
        "max_repair_time": 60.0,
        "max_llm_calls": 10,
        "total_llm_calls": 0,
        "attempt_history": [],
        "agent_events": [],
        "timestamps": {},
    }

    async def _run():
        # Enforce strict 30s timeout so test fails if verification hangs
        return await asyncio.wait_for(graph.ainvoke(initial_state), timeout=30.0)

    try:
        final_state = asyncio.run(_run())

        # Verify progression from testing to verified
        assert final_state["final_status"] == "VERIFIED"
        assert final_state["is_verified"] is True
        assert "verification_result" in final_state
        vr = final_state["verification_result"]
        assert vr["status"] == "PASSED"
        assert vr["passed"] == 5
        assert vr["failed"] == 0
        assert vr["exit_code"] == 0
        assert vr["timed_out"] is False

        # Verify history has attempt record with verification
        assert len(final_state["attempt_history"]) >= 1
        last_attempt = final_state["attempt_history"][-1]
        assert last_attempt["status"] == "PASSED"
        assert "verification" in last_attempt

    finally:
        set_global_llm_provider(None)
        # Restore calculator.py to buggy state
        calc_content = calc_file.read_text(encoding="utf-8")
        if "return 0" in calc_content:
            calc_file.write_text(calc_content.replace("return 0", "return -1"), encoding="utf-8")
