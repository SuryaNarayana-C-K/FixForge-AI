"""
Base class and schema models for safe agent tools.
"""

from abc import ABC, abstractmethod
from typing import Any
from pydantic import BaseModel, Field


class ToolResult(BaseModel):
    success: bool
    output: Any = None
    error: str | None = None


class AgentTool(ABC):
    """Safe agent tool bound strictly to repository workspace."""

    name: str
    description: str

    @abstractmethod
    def run(self, workspace_root: str, **kwargs: Any) -> ToolResult:
        raise NotImplementedError
