"""
Model provider abstraction package for FixForge.
"""

from .base import LLMProvider
from .factory import get_llm_provider, set_global_mock_provider
from .gemini import (
    GeminiProvider,
    LLMAuthenticationError,
    LLMConfigurationError,
    LLMRequestFailedError,
    PatchGenerationError,
)
from .mock import MockLLMProvider
from .openai_compat import OpenAICompatibleProvider

__all__ = [
    "GeminiProvider",
    "LLMAuthenticationError",
    "LLMConfigurationError",
    "LLMProvider",
    "LLMRequestFailedError",
    "MockLLMProvider",
    "OpenAICompatibleProvider",
    "PatchGenerationError",
    "get_llm_provider",
    "set_global_mock_provider",
]