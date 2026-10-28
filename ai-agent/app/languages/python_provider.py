"""
Python Language Provider for FixForge Milestone 8.
Preserves all verified M1-M7 Python discovery, framework detection, and execution logic.
"""

from pathlib import Path
import re
import sys
from typing import Any

from app.discovery import discover_files
from app.languages.base import CommonAnalysisResult, LanguageProvider


class PythonProvider(LanguageProvider):
    """
    Language provider for Python repositories supporting pytest and unittest.
    """

    def get_language(self) -> str:
        return "python"

    def detect(self, repository_path: Path) -> bool:
        if not repository_path.is_dir():
            return False

        # 1. Manifest / config files
        python_manifests = {
            "pyproject.toml",
            "requirements.txt",
            "requirements-dev.txt",
            "setup.py",
            "setup.cfg",
            "Pipfile",
            "poetry.lock",
            "tox.ini",
            "pytest.ini",
            ".pytest.ini",
        }
        for manifest in python_manifests:
            if (repository_path / manifest).is_file():
                return True

        # 2. Python source files in top-level or subdirectories
        try:
            for item in repository_path.rglob("*.py"):
                # Ignore virtual environments, git, cache
                rel = str(item.relative_to(repository_path)).replace("\\", "/")
                parts = rel.split("/")
                if any(p in parts for p in (".venv", "venv", "env", ".git", "__pycache__", ".pytest_cache")):
                    continue
                return True
        except Exception:
            pass

        return False

    def get_project_files(self, repository_path: Path) -> list[str]:
        candidates = {
            "requirements.txt",
            "requirements-dev.txt",
            "dev-requirements.txt",
            "pyproject.toml",
            "setup.py",
            "setup.cfg",
            "Pipfile",
            "Pipfile.lock",
            "poetry.lock",
            "uv.lock",
            "pytest.ini",
            ".pytest.ini",
            "tox.ini",
            "runtime.txt",
            ".python-version",
        }
        found: list[str] = []
        for c in candidates:
            if (repository_path / c).is_file():
                found.append(c)
        return sorted(found)

    def detect_framework(self, repository_path: Path, files: list[str]) -> tuple[str, list[str]]:
        """
        Detect whether the project uses pytest or unittest.
        Priority:
        1. pytest
        2. unittest
        Returns (framework_name, safe_command_args).
        """
        has_pytest_config = False
        has_pytest_dep = False
        has_unittest_code = False
        has_pytest_code = False

        # Config check
        for f in files:
            name = Path(f).name
            if name in ("pytest.ini", ".pytest.ini", "conftest.py"):
                has_pytest_config = True
            elif name == "pyproject.toml":
                try:
                    content = (repository_path / f).read_text(encoding="utf-8", errors="ignore")
                    if "[tool.pytest" in content or "pytest" in content:
                        has_pytest_config = True
                except OSError:
                    pass

        # Dependency check
        for f in files:
            name = Path(f).name
            if name in ("requirements.txt", "requirements-dev.txt", "dev-requirements.txt"):
                try:
                    content = (repository_path / f).read_text(encoding="utf-8", errors="ignore")
                    if re.search(r"^pytest(\b|[<>=!~])", content, re.MULTILINE | re.IGNORECASE):
                        has_pytest_dep = True
                except OSError:
                    pass

        # Code inspection
        test_files = [
            f for f in files
            if (f.startswith("tests/") or f.startswith("test/") or Path(f).name.startswith("test_"))
            and f.endswith(".py")
        ]
        for tf in test_files[:10]:
            try:
                content = (repository_path / tf).read_text(encoding="utf-8", errors="ignore")
                if "import pytest" in content or "from pytest" in content or "@pytest." in content:
                    has_pytest_code = True
                if "import unittest" in content or "from unittest" in content or "TestCase" in content:
                    has_unittest_code = True
            except OSError:
                pass

        if has_pytest_config or has_pytest_dep or has_pytest_code:
            return "pytest", [sys.executable, "-m", "pytest"]

        if has_unittest_code:
            return "unittest", [sys.executable, "-m", "unittest"]

        # Default to pytest if tests exist
        return "pytest", [sys.executable, "-m", "pytest"]

    def get_test_command(self, repository_path: Path, framework: str) -> list[str]:
        if framework == "unittest":
            return [sys.executable, "-m", "unittest"]
        return [sys.executable, "-m", "pytest"]

    def get_source_files(self, repository_path: Path) -> list[str]:
        discovered = discover_files(repository_path)
        sources: list[str] = []
        for f in discovered:
            rel = f.relative_path.replace("\\", "/")
            parts = rel.split("/")
            if any(p in parts for p in (".venv", "venv", "env", ".git", "__pycache__", "tests", "test")):
                continue
            if rel.endswith(".py") and not Path(rel).name.startswith("test_") and not Path(rel).name.endswith("_test.py"):
                sources.append(rel)
        return sorted(sources)

    def get_test_files(self, repository_path: Path) -> list[str]:
        discovered = discover_files(repository_path)
        tests: list[str] = []
        for f in discovered:
            rel = f.relative_path.replace("\\", "/")
            parts = rel.split("/")
            if any(p in parts for p in (".venv", "venv", "env", ".git", "__pycache__")):
                continue
            if (
                rel.endswith(".py")
                and (
                    "tests" in parts
                    or "test" in parts
                    or Path(rel).name.startswith("test_")
                    or Path(rel).name.endswith("_test.py")
                )
            ):
                tests.append(rel)
        return sorted(tests)

    def analyze(self, repository_path: Path) -> CommonAnalysisResult:
        discovered = discover_files(repository_path)
        rel_files = [f.relative_path.replace("\\", "/") for f in discovered]

        project_files = self.get_project_files(repository_path)
        framework, cmd_args = self.detect_framework(repository_path, rel_files)
        source_files = self.get_source_files(repository_path)
        test_files = self.get_test_files(repository_path)

        # Detect package manager
        package_manager = "pip"
        if "poetry.lock" in project_files:
            package_manager = "poetry"
        elif "Pipfile" in project_files or "Pipfile.lock" in project_files:
            package_manager = "pipenv"
        elif "uv.lock" in project_files:
            package_manager = "uv"

        # Python version
        version = None
        pv_file = repository_path / ".python-version"
        if pv_file.is_file():
            try:
                version = pv_file.read_text(encoding="utf-8").strip()
            except OSError:
                pass
        elif "pyproject.toml" in project_files:
            try:
                text = (repository_path / "pyproject.toml").read_text(encoding="utf-8")
                match = re.search(r'requires-python\s*=\s*["\']([^"\']+)["\']', text)
                if match:
                    version = match.group(1).strip()
            except OSError:
                pass

        return CommonAnalysisResult(
            language="python",
            framework=None,
            test_framework=framework,
            test_command=framework,
            test_command_args=cmd_args,
            package_manager=package_manager,
            source_files=source_files,
            test_files=test_files,
            project_files=project_files,
            dependency_files=[f for f in project_files if f in ("requirements.txt", "requirements-dev.txt", "pyproject.toml", "setup.py", "Pipfile")],
            config_files=[f for f in project_files if f in ("pytest.ini", ".pytest.ini", "tox.ini", "setup.cfg")],
            version=version,
        )

    def validate_environment(self, repository_path: Path) -> dict[str, Any]:
        return {
            "language": "python",
            "executable": sys.executable,
            "version": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
            "available": True,
        }

    def get_execution_config(self, repository_path: Path) -> dict[str, Any]:
        return {
            "timeout": 120.0,
            "env": {"PYTHONUNBUFFERED": "1", "PYTHONDONTWRITEBYTECODE": "1"},
        }
