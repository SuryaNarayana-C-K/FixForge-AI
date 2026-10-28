"""
OpenAI-compatible LLM provider for live inference with OpenAI, Ollama, DeepSeek, vLLM, etc.
"""

import json
import os
from typing import Any, TypeVar
from pydantic import BaseModel

from app.providers.base import LLMProvider

T = TypeVar("T", bound=BaseModel)


class OpenAICompatibleProvider(LLMProvider):
    """Integrates with any OpenAI-compatible API endpoint (OpenAI, Ollama, vLLM, Nvidia NIM)."""

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str | None = None,
    ):
        self.api_key = api_key or os.getenv("LLM_API_KEY", "not-set")
        self.base_url = base_url or os.getenv("LLM_BASE_URL")
        self.model = model or os.getenv("LLM_MODEL", "gpt-4o-mini")

        from openai import AsyncOpenAI
        self.client = AsyncOpenAI(api_key=self.api_key, base_url=self.base_url)

    async def complete(self, messages: list[dict[str, str]], **kwargs: Any) -> str:
        resp = await self.client.chat.completions.create(
            model=self.model,
            messages=messages,  # type: ignore
            temperature=kwargs.get("temperature", 0.0),
        )
        return resp.choices[0].message.content or ""

    async def generate_structured(
        self,
        messages: list[dict[str, str]],
        response_model: type[T],
        **kwargs: Any,
    ) -> T:
        # If model supports client.beta.chat.completions.parse:
        try:
            resp = await self.client.beta.chat.completions.parse(
                model=self.model,
                messages=messages,  # type: ignore
                response_format=response_model,
                temperature=kwargs.get("temperature", 0.0),
            )
            parsed = resp.choices[0].message.parsed
            if parsed is not None:
                return parsed
        except Exception:
            pass

        # Fallback to json_object mode
        schema_json = json.dumps(response_model.model_json_schema())
        system_instruction = (
            f"You MUST respond ONLY with a valid JSON object strictly matching this JSON schema:\n{schema_json}"
        )
        augmented_messages = [{"role": "system", "content": system_instruction}] + messages

        resp = await self.client.chat.completions.create(
            model=self.model,
            messages=augmented_messages,  # type: ignore
            response_format={"type": "json_object"},
            temperature=kwargs.get("temperature", 0.0),
        )
        raw_text = resp.choices[0].message.content or "{}"
        return response_model.model_validate_json(raw_text)
