"""
Factory for resolving and instantiating the active LLM provider.
"""

import os
from typing import Literal

from app.providers.base import LLMProvider
from app.providers.mock import MockLLMProvider
from app.providers.openai_compat import OpenAICompatibleProvider

_GLOBAL_MOCK_PROVIDER: MockLLMProvider | None = None


def set_global_mock_provider(mock_provider: MockLLMProvider | None) -> None:
    """Helper for testing to inject a custom mock provider across graph runs."""
    global _GLOBAL_MOCK_PROVIDER
    _GLOBAL_MOCK_PROVIDER = mock_provider


set_global_llm_provider = set_global_mock_provider



def get_llm_provider(provider_name: str | None = None) -> LLMProvider:
    """
    Resolve active LLM provider based on configuration.
    Defaults to MockLLMProvider if no API key or if provider is mock.
    """
    global _GLOBAL_MOCK_PROVIDER
    if _GLOBAL_MOCK_PROVIDER is not None:
        return _GLOBAL_MOCK_PROVIDER

    selected = (provider_name or os.getenv("LLM_PROVIDER", "mock")).strip().lower()

    if selected in ("mock", "test", "dummy"):
        return MockLLMProvider()

    if selected in ("gemini", "google", "google_genai"):
        from app.providers.gemini import GeminiProvider
        return GeminiProvider(
            api_key=os.getenv("GEMINI_API_KEY"),
            model=os.getenv("LLM_MODEL", "gemini-3.5-flash"),
        )

    api_key = os.getenv("LLM_API_KEY")
    if not api_key:
        # Default safely to mock if key is not configured
        return MockLLMProvider()

    if selected in ("openai", "openai_compatible", "ollama", "vllm", "nvidia", "deepseek"):
        return OpenAICompatibleProvider(
            api_key=api_key,
            base_url=os.getenv("LLM_BASE_URL"),
            model=os.getenv("LLM_MODEL"),
        )

    # Fallback to mock
    return MockLLMProvider()
