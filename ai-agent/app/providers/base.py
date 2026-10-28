"""
Abstract base provider interface for AI reasoning.
Enforces model-agnostic architecture.
"""

from abc import ABC, abstractmethod
from typing import Any, TypeVar
from pydantic import BaseModel

T = TypeVar("T", bound=BaseModel)


class LLMProvider(ABC):
    """Provider-neutral interface for repair reasoning and structured generation."""

    @abstractmethod
    async def complete(self, messages: list[dict[str, str]], **kwargs: Any) -> str:
        """Return free-form completion text."""
        raise NotImplementedError

    @abstractmethod
    async def generate_structured(
        self,
        messages: list[dict[str, str]],
        response_model: type[T],
        **kwargs: Any,
    ) -> T:
        """Generate structured output adhering to a Pydantic schema."""
        raise NotImplementedError