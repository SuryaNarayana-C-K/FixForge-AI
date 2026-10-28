"""
Language Provider Abstraction for FixForge Milestone 8.
Defines normalized schemas and interfaces for language-agnostic repository analysis,
framework detection, test command resolution, and environment validation.
"""

from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class CommonAnalysisResult:
    """Normalized common repository analysis result across all language providers."""
    language: str
    framework: str | None = None
    test_framework: str = "pytest"
    test_command: str = "pytest"
    test_command_args: list[str] = field(default_factory=list)
    package_manager: str | None = None
    source_files: list[str] = field(default_factory=list)
    test_files: list[str] = field(default_factory=list)
    project_files: list[str] = field(default_factory=list)
    dependency_files: list[str] = field(default_factory=list)
    config_files: list[str] = field(default_factory=list)
    version: str | None = None
    detected_components: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class LanguageProvider(ABC):
    """
    Abstract interface for language-specific repository analysis,
    test framework detection, and safe execution configuration.
    """

    @abstractmethod
    def get_language(self) -> str:
        """Return the canonical language identifier (e.g. 'python', 'javascript', 'java')."""
        pass

    @abstractmethod
    def detect(self, repository_path: Path) -> bool:
        """Return True if this provider recognizes the target repository."""
        pass

    @abstractmethod
    def get_project_files(self, repository_path: Path) -> list[str]:
        """Return list of project configuration and manifest files."""
        pass

    @abstractmethod
    def detect_framework(self, repository_path: Path, files: list[str]) -> tuple[str, list[str]]:
        """
        Detect the active test framework and return (framework_name, safe_command_args).
        Example: ('jest', ['npx', 'jest', '--runInBand'])
        """
        pass

    @abstractmethod
    def get_test_command(self, repository_path: Path, framework: str) -> list[str]:
        """Return safe, allowlisted argument array for running tests."""
        pass

    @abstractmethod
    def get_source_files(self, repository_path: Path) -> list[str]:
        """Return relative paths to source code files (excluding tests)."""
        pass

    @abstractmethod
    def get_test_files(self, repository_path: Path) -> list[str]:
        """Return relative paths to test files."""
        pass

    @abstractmethod
    def analyze(self, repository_path: Path) -> CommonAnalysisResult:
        """Perform comprehensive repository analysis and return normalized result."""
        pass

    @abstractmethod
    def validate_environment(self, repository_path: Path) -> dict[str, Any]:
        """Verify runtime availability, package manager, and dependencies."""
        pass

    @abstractmethod
    def get_execution_config(self, repository_path: Path) -> dict[str, Any]:
        """Return execution parameters (timeout, environment variables, runner flags)."""
        pass
