"""
Official Google GenAI Python SDK Provider for FixForge.
Implements model-agnostic LLMProvider interface with robust error sanitization.
"""

import json
import os
import re
from typing import Any, TypeVar
from pydantic import BaseModel

from app.providers.base import LLMProvider

T = TypeVar("T", bound=BaseModel)


class LLMConfigurationError(Exception):
    """Raised when LLM configuration (such as GEMINI_API_KEY) is missing or invalid."""
    pass


class LLMAuthenticationError(Exception):
    """Raised when LLM provider returns an authentication or authorization failure."""
    pass


class LLMRequestFailedError(Exception):
    """Raised when LLM request fails due to network, rate limits, quota, or upstream error."""
    pass


class PatchGenerationError(Exception):
    """Raised when patch generation or structured parsing fails."""
    pass


def sanitize_text(text: str, api_key: str | None = None) -> str:
    """Ensure no API key or sensitive token appears in text or error messages."""
    if not text:
        return ""
    if api_key and len(api_key) > 4:
        text = text.replace(api_key, "[REDACTED_API_KEY]")
    # Redact standard Google API key patterns (AIzaSy...)
    text = re.sub(r"AIza[0-9A-Za-z_-]{35}", "[REDACTED_API_KEY]", text)
    # Redact standard Bearer tokens / keys
    text = re.sub(r"(Bearer\s+)[A-Za-z0-9\-._~+/]+=*", r"\1[REDACTED]", text, flags=re.IGNORECASE)
    return text


class GeminiProvider(LLMProvider):
    """
    Live inference provider using the official Google GenAI Python SDK (`google-genai`).
    Enforces strict security: never logs, leaks, or persists GEMINI_API_KEY.
    """

    def __init__(
        self,
        api_key: str | None = None,
        model: str | None = None,
    ):
        self._raw_api_key = api_key or os.getenv("GEMINI_API_KEY", "")
        self.model = model or os.getenv("LLM_MODEL", "gemini-2.0-flash")
        self._client = None

        if self._raw_api_key:
            from google import genai
            self._client = genai.Client(api_key=self._raw_api_key)

    @property
    def is_configured(self) -> bool:
        return bool(self._raw_api_key and self._raw_api_key.strip())

    def _ensure_client(self):
        if not self.is_configured or self._client is None:
            raise LLMConfigurationError(
                "LLM_CONFIGURATION_ERROR: GEMINI_API_KEY is not configured in environment variables."
            )
        return self._client

    def _prepare_contents_and_system(
        self, messages: list[dict[str, str]]
    ) -> tuple[list[Any], str | None]:
        from google.genai import types

        if isinstance(messages, str):
            messages = [{"role": "user", "content": messages}]
        elif isinstance(messages, dict):
            messages = [messages]

        system_parts: list[str] = []
        contents: list[types.Content] = []

        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            if role == "system":
                system_parts.append(content)
            elif role in ("assistant", "model"):
                contents.append(
                    types.Content(
                        role="model",
                        parts=[types.Part.from_text(text=content)],
                    )
                )
            else:
                contents.append(
                    types.Content(
                        role="user",
                        parts=[types.Part.from_text(text=content)],
                    )
                )

        system_instruction = "\n\n".join(system_parts) if system_parts else None
        if not contents:
            contents.append(
                types.Content(role="user", parts=[types.Part.from_text(text="Please proceed.")])
            )

        return contents, system_instruction

    async def complete(self, messages: list[dict[str, str]], **kwargs: Any) -> str:
        """Return free-form completion text."""
        client = self._ensure_client()
        from google.genai import types

        contents, system_instruction = self._prepare_contents_and_system(messages)
        config = types.GenerateContentConfig(
            system_instruction=system_instruction,
            temperature=kwargs.get("temperature", 0.1),
        )

        for attempt in range(4):
            try:
                response = await client.aio.models.generate_content(
                    model=self.model,
                    contents=contents,
                    config=config,
                )
                return response.text or ""
            except Exception as e:
                err_str = str(e)
                if ("429" in err_str or "resource_exhausted" in err_str.lower()) and attempt < 3:
                    wait_sec = 22.0
                    m = re.search(r"retry in ([\d\.]+)s", err_str, re.IGNORECASE)
                    if m:
                        try:
                            wait_sec = float(m.group(1)) + 1.5
                        except ValueError:
                            pass
                    await asyncio.sleep(wait_sec)
                    continue

                sanitized = sanitize_text(err_str, self._raw_api_key)
                lower_err = sanitized.lower()
                if any(term in lower_err for term in ["api_key_invalid", "unauthorized", "permission_denied", "401", "403", "invalid api key"]):
                    raise LLMAuthenticationError(
                        f"LLM_AUTHENTICATION_ERROR: Gemini API key rejected: {sanitized}"
                    ) from None
                raise LLMRequestFailedError(
                    f"LLM_REQUEST_FAILED: Gemini model call failed: {sanitized}"
                ) from None

    async def generate_structured(
        self,
        messages: list[dict[str, str]],
        response_model: type[T],
        **kwargs: Any,
    ) -> T:
        """Generate structured output adhering to a Pydantic schema using Gemini structured outputs."""
        client = self._ensure_client()
        from google.genai import types

        contents, system_instruction = self._prepare_contents_and_system(messages)
        config = types.GenerateContentConfig(
            system_instruction=system_instruction,
            response_mime_type="application/json",
            response_schema=response_model,
            temperature=kwargs.get("temperature", 0.1),
        )

        for attempt in range(4):
            try:
                response = await client.aio.models.generate_content(
                    model=self.model,
                    contents=contents,
                    config=config,
                )
                break
            except Exception as e:
                err_str = str(e)
                if ("429" in err_str or "resource_exhausted" in err_str.lower()) and attempt < 3:
                    wait_sec = 22.0
                    m = re.search(r"retry in ([\d\.]+)s", err_str, re.IGNORECASE)
                    if m:
                        try:
                            wait_sec = float(m.group(1)) + 1.5
                        except ValueError:
                            pass
                    await asyncio.sleep(wait_sec)
                    continue

                sanitized = sanitize_text(err_str, self._raw_api_key)
                lower_err = sanitized.lower()
                if any(term in lower_err for term in ["api_key_invalid", "unauthorized", "permission_denied", "401", "403", "invalid api key"]):
                    raise LLMAuthenticationError(
                        f"LLM_AUTHENTICATION_ERROR: Gemini API authentication failed: {sanitized}"
                    ) from None
                raise LLMRequestFailedError(
                    f"LLM_REQUEST_FAILED: Gemini structured generation request failed: {sanitized}"
                ) from None

        raw_text = response.text or ""
        # Strip potential markdown formatting if wrapped in ```json ... ```
        clean_text = raw_text.strip()
        if clean_text.startswith("```"):
            clean_text = re.sub(r"^```(?:json)?\s*", "", clean_text, flags=re.MULTILINE)
            clean_text = re.sub(r"\s*```$", "", clean_text, flags=re.MULTILINE).strip()

        try:
            return response_model.model_validate_json(clean_text)
        except Exception as parse_err:
            sanitized_parse = sanitize_text(str(parse_err), self._raw_api_key)
            sanitized_body = sanitize_text(clean_text[:300], self._raw_api_key)
            raise PatchGenerationError(
                f"PATCH_GENERATION_FAILED: Failed to parse {response_model.__name__} from Gemini response: {sanitized_parse}. Raw text snippet: {sanitized_body}"
            ) from None
