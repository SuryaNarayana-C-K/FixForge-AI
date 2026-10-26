import asyncio
from pathlib import Path
from fastapi.testclient import TestClient
import pytest

from app.graph import build_repair_graph
from app.main import app


def test_full_repair_graph_workflow(monkeypatch):
    monkeypatch.setenv("EXECUTION_MODE", "local")
    monkeypatch.setenv("LLM_PROVIDER", "mock")

    async def _run():
        workspace_root = Path(__file__).resolve().parent.parent.parent
        demo_repo = workspace_root / "examples" / "buggy-python-project"

        graph = build_repair_graph(auto_apply=False)
        initial_state = {
            "job_id": "repair-test-m4",
            "repository_path": str(demo_repo),
            "timestamps": {},
            "agent_events": [],
        }

        final_state = await graph.ainvoke(initial_state)

        # Baseline inspection
        assert final_state["baseline_result"]["failed"] == 1
        assert final_state["baseline_result"]["passed"] == 4

        # Root cause analysis
        rc = final_state.get("root_cause_analysis", {})
        assert rc.get("summary") is not None
        assert final_state.get("root_cause_confidence") > 0.8
        assert "calculator.py" in final_state.get("relevant_files", [])

        # Patch plan
        plan = final_state.get("patch_plan", {})
        assert "calculator.py" in plan.get("files_to_modify", [])

        # Patch generation
        patch = final_state.get("generated_patch", {})
        assert "calculator.py" in patch.get("files", [])
        assert "--- a/calculator.py" in patch.get("diff", "")

        # Patch validation
        val = final_state.get("patch_validation", {})
        assert val.get("valid") is True
        assert val.get("status") == "VALID"

        # Agent events recorded
        events = [e.get("event") for e in final_state.get("agent_events", [])]
        assert "ROOT_CAUSE_ANALYSIS_STARTED" in events
        assert "ROOT_CAUSE_IDENTIFIED" in events
        assert "PATCH_PLAN_CREATED" in events
        assert "PATCH_GENERATION_STARTED" in events
        assert "PATCH_GENERATED" in events
        assert "PATCH_VALIDATION_STARTED" in events
        assert "PATCH_VALIDATED" in events

    asyncio.run(_run())


def test_api_root_cause_endpoint(monkeypatch):
    monkeypatch.setenv("EXECUTION_MODE", "local")
    monkeypatch.setenv("LLM_PROVIDER", "mock")
    client = TestClient(app)

    res = client.post(
        "/agent/root-cause",
        json={
            "job_id": "test-rc-1",
            "repository_path": "examples/buggy-python-project",
        },
    )
    assert res.status_code == 200
    data = res.json()
    assert data["job_id"] == "test-rc-1"
    assert data["root_cause"]["summary"] is not None
    assert "calculator.py" in data["relevant_files"]


def test_api_plan_endpoint(monkeypatch):
    monkeypatch.setenv("EXECUTION_MODE", "local")
    monkeypatch.setenv("LLM_PROVIDER", "mock")
    client = TestClient(app)

    res = client.post(
        "/agent/plan",
        json={
            "job_id": "test-plan-1",
            "repository_path": "examples/buggy-python-project",
            "root_cause": {
                "summary": "divide zero count bug",
                "failure_type": "logic_error",
                "root_cause": "returns -1 instead of 0",
                "confidence": 0.9,
            },
        },
    )
    assert res.status_code == 200
    data = res.json()
    assert "calculator.py" in data["patch_plan"]["files_to_modify"]


def test_api_patch_endpoint(monkeypatch):
    monkeypatch.setenv("EXECUTION_MODE", "local")
    monkeypatch.setenv("LLM_PROVIDER", "mock")
    client = TestClient(app)

    res = client.post(
        "/agent/patch",
        json={
            "job_id": "test-patch-1",
            "repository_path": "examples/buggy-python-project",
            "patch_plan": {
                "objective": "fix divide",
                "files_to_modify": ["calculator.py"],
                "changes": [],
                "risks": [],
            },
        },
    )
    assert res.status_code == 200
    data = res.json()
    assert data["validation"]["valid"] is True
    assert "--- a/calculator.py" in data["generated_patch"]["diff"]


def test_api_repair_workflow_endpoint(monkeypatch):
    monkeypatch.setenv("EXECUTION_MODE", "local")
    monkeypatch.setenv("LLM_PROVIDER", "mock")
    client = TestClient(app)

    res = client.post(
        "/agent/repair-workflow",
        json={
            "job_id": "workflow-job-1",
            "repository_path": "examples/buggy-python-project",
            "auto_apply": False,
        },
    )
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "patch_generated"
    assert data["baseline"]["failed"] == 1
    assert data["root_cause"] is not None
    assert data["patch_plan"] is not None
    assert data["generated_patch"] is not None
    assert data["validation"]["valid"] is True
