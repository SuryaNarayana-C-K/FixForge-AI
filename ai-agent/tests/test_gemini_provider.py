import os
from unittest.mock import AsyncMock, MagicMock, patch
import pytest

from app.patch_schemas import GeneratedPatch, PatchPlan, RootCauseAnalysis
from app.providers.factory import get_llm_provider
from app.providers.gemini import (
    GeminiProvider,
    LLMAuthenticationError,
    LLMConfigurationError,
    LLMRequestFailedError,
    PatchGenerationError,
    sanitize_text,
)
from app.providers.mock import MockLLMProvider


def test_sanitize_text_removes_api_keys():
    raw_key = "AIzaSyFakeKey1234567890abcdefghijklmn"
    text = f"Error connecting with key {raw_key}: rate limit exceeded"
    sanitized = sanitize_text(text, raw_key)
    assert raw_key not in sanitized
    assert "[REDACTED_API_KEY]" in sanitized


def test_gemini_provider_init_from_env(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "gemini")
    monkeypatch.setenv("LLM_MODEL", "gemini-2.0-flash")
    monkeypatch.setenv("GEMINI_API_KEY", "AIzaSyTestKeyForInitialization12345678")

    provider = get_llm_provider()
    assert isinstance(provider, GeminiProvider)
    assert provider.model == "gemini-2.0-flash"
    assert provider.is_configured is True


def test_gemini_provider_missing_key_raises_configuration_error(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "gemini")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)

    provider = GeminiProvider(api_key=None)
    assert provider.is_configured is False

    with pytest.raises(LLMConfigurationError) as exc_info:
        provider._ensure_client()
    assert "LLM_CONFIGURATION_ERROR" in str(exc_info.value)


def test_mock_provider_preserved_for_tests(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "mock")
    provider = get_llm_provider()
    assert isinstance(provider, MockLLMProvider)


@pytest.mark.anyio
async def test_gemini_provider_complete_with_mocked_client(monkeypatch):
    fake_key = "AIzaSyFakeKeyForMockedTesting999999999"
    provider = GeminiProvider(api_key=fake_key, model="gemini-2.0-flash")

    mock_response = MagicMock()
    mock_response.text = "Analysis completed: bug detected in discount calculation."

    mock_client = MagicMock()
    mock_client.aio.models.generate_content = AsyncMock(return_value=mock_response)
    provider._client = mock_client

    messages = [
        {"role": "system", "content": "You are a code debugger."},
        {"role": "user", "content": "Analyze calculator issue."},
    ]

    result = await provider.complete(messages)
    assert result == "Analysis completed: bug detected in discount calculation."
    mock_client.aio.models.generate_content.assert_called_once()


@pytest.mark.anyio
async def test_gemini_provider_structured_output_with_mocked_client():
    fake_key = "AIzaSyFakeKeyForMockedTesting999999999"
    provider = GeminiProvider(api_key=fake_key, model="gemini-2.0-flash")

    mock_response = MagicMock()
    mock_response.text = '''{
        "summary": "Incorrect discount addition",
        "failure_type": "logic_error",
        "root_cause": "Discount added instead of subtracted in calculate_total",
        "observed": "Total 275 expected 225",
        "hypothesis": "Minus operator replaced by plus",
        "evidence": [{"file": "cart.py", "line": 13, "reason": "total = subtotal + discount"}],
        "confidence": 0.95
    }'''

    mock_client = MagicMock()
    mock_client.aio.models.generate_content = AsyncMock(return_value=mock_response)
    provider._client = mock_client

    messages = [{"role": "user", "content": "Analyze discount failure"}]
    rc = await provider.generate_structured(messages, RootCauseAnalysis)

    assert isinstance(rc, RootCauseAnalysis)
    assert rc.confidence == 0.95
    assert "cart.py" in rc.evidence[0].file
    assert rc.evidence[0].line == 13


@pytest.mark.anyio
async def test_gemini_provider_auth_error_sanitization():
    fake_key = "AIzaSySecretApiKey1234567890123456789"
    provider = GeminiProvider(api_key=fake_key, model="gemini-2.0-flash")

    mock_client = MagicMock()
    mock_client.aio.models.generate_content = AsyncMock(
        side_effect=Exception(f"403 Forbidden: API_KEY_INVALID with key {fake_key}")
    )
    provider._client = mock_client

    with pytest.raises(LLMAuthenticationError) as exc_info:
        await provider.complete([{"role": "user", "content": "test"}])

    error_msg = str(exc_info.value)
    assert "LLM_AUTHENTICATION_ERROR" in error_msg
    assert fake_key not in error_msg
    assert "[REDACTED_API_KEY]" in error_msg
