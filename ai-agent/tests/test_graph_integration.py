import asyncio
from pathlib import Path
from fastapi.testclient import TestClient

from app.graph import build_analysis_graph
from app.main import app


def test_langgraph_pipeline_on_demo_repo(monkeypatch):
    monkeypatch.setenv("EXECUTION_MODE", "local")
    async def _run():
        workspace_root = Path(__file__).resolve().parent.parent.parent
        demo_repo = workspace_root / "examples" / "buggy-python-project"

        graph = build_analysis_graph()
        initial_state = {
            "job_id": "test-job-123",
            "repository_path": str(demo_repo),
            "errors": [],
            "timestamps": {},
        }

        final_state = await graph.ainvoke(initial_state)

        assert final_state["current_state"] == "FAILURE_DETECTION"
        assert final_state["language"] == "python"
        assert final_state["test_framework"] == "pytest"
        assert final_state["test_command"] == "pytest"

        baseline = final_state["baseline_result"]
        assert baseline["total"] == 5
        assert baseline["passed"] == 4
        assert baseline["failed"] == 1
        assert baseline["status"] == "failed"
        assert len(final_state["failures"]) == 1
        assert "test_divide_by_zero_is_safe" in final_state["failures"][0]["test_name"]

    asyncio.run(_run())


def test_api_analyze_endpoint(monkeypatch):
    monkeypatch.setenv("EXECUTION_MODE", "local")
    client = TestClient(app)

    response = client.post(
        "/agent/analyze",
        json={
            "job_id": "api-test-job-456",
            "repository_path": "examples/buggy-python-project",
        },
    )
    assert response.status_code == 200
    data = response.json()

    assert data["job_id"] == "api-test-job-456"
    assert data["status"] == "baseline_completed"
    assert data["repository"]["language"] == "python"
    assert data["repository"]["test_framework"] == "pytest"
    assert data["baseline"]["total"] == 5
    assert data["baseline"]["passed"] == 4
    assert data["baseline"]["failed"] == 1
    assert len(data["failures"]) == 1
    assert "test_divide_by_zero_is_safe" in data["failures"][0]["test_name"]
