import pytest

from app.patch_schemas import GeneratedPatch, PatchPlan, RootCauseAnalysis
from app.providers.factory import get_llm_provider
from app.providers.mock import MockLLMProvider


@pytest.mark.anyio
async def test_mock_llm_provider_deterministic_root_cause():
    provider = MockLLMProvider()
    messages = [
        {"role": "user", "content": "Analyze failure in calculator.py divide test_divide_by_zero_is_safe"}
    ]
    rc = await provider.generate_structured(messages, RootCauseAnalysis)
    assert isinstance(rc, RootCauseAnalysis)
    assert "divide" in rc.summary.lower() or "calculator" in rc.summary.lower()
    assert rc.confidence > 0.8
    assert len(rc.evidence) >= 1


@pytest.mark.anyio
async def test_mock_llm_provider_plan_and_patch():
    provider = MockLLMProvider()
    messages = [
        {"role": "user", "content": "Plan and fix calculator.py divide"}
    ]
    plan = await provider.generate_structured(messages, PatchPlan)
    assert isinstance(plan, PatchPlan)
    assert "calculator.py" in plan.files_to_modify

    patch = await provider.generate_structured(messages, GeneratedPatch)
    assert isinstance(patch, GeneratedPatch)
    assert "calculator.py" in patch.files
    assert "--- a/calculator.py" in patch.diff
    assert "+++ b/calculator.py" in patch.diff


@pytest.mark.anyio
async def test_mock_llm_provider_custom_override():
    custom_rc = RootCauseAnalysis(
        summary="Custom overridden failure",
        root_cause="Overridden cause",
        confidence=0.99,
    )
    provider = MockLLMProvider(override_root_cause=custom_rc)
    rc = await provider.generate_structured([], RootCauseAnalysis)
    assert rc.summary == "Custom overridden failure"
    assert rc.confidence == 0.99


def test_provider_factory_selection(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "mock")
    prov = get_llm_provider()
    assert isinstance(prov, MockLLMProvider)
