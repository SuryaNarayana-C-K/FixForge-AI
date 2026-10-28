"""
Language Provider Registry for FixForge Milestone 8.
Orchestrates deterministic language detection, provider lookup,
and mixed-language repository resolution.
"""

from pathlib import Path
from typing import Any

from app.languages.base import CommonAnalysisResult, LanguageProvider
from app.languages.java_provider import JavaProvider
from app.languages.javascript_provider import JavaScriptProvider
from app.languages.python_provider import PythonProvider


class LanguageProviderRegistry:
    """
    Central registry for language providers.
    Provides deterministic priority-based language and framework detection.
    """

    def __init__(self):
        self._providers: dict[str, LanguageProvider] = {
            "python": PythonProvider(),
            "javascript": JavaScriptProvider(),
            "java": JavaProvider(),
        }

    def register_provider(self, provider: LanguageProvider) -> None:
        self._providers[provider.get_language().lower()] = provider

    def get_provider(self, language: str) -> LanguageProvider:
        lang = language.lower().strip()
        if lang in self._providers:
            return self._providers[lang]
        if lang in ("js", "node", "typescript", "ts"):
            return self._providers["javascript"]
        if lang in ("py",):
            return self._providers["python"]
        # Default fallback is PythonProvider to preserve existing M1-M7 behavior
        return self._providers["python"]

    def detect(
        self,
        repository_path: Path,
        explicit_language: str | None = None,
    ) -> tuple[LanguageProvider, CommonAnalysisResult]:
        """
        Detect the appropriate language provider for the repository.
        Priority:
        1. Explicit configuration if supplied
        2. package.json -> JavaScript
        3. pyproject.toml / requirements.txt / setup.py -> Python
        4. pom.xml / build.gradle -> Java
        5. File-extension fallback
        6. Mixed-repository inspection
        """
        # 1. Explicit override
        if explicit_language and explicit_language.lower() != "auto":
            provider = self.get_provider(explicit_language)
            return provider, provider.analyze(repository_path)

        # Check for mixed repository components
        components: list[dict[str, Any]] = []
        if (repository_path / "package.json").is_file():
            components.append({"language": "javascript", "path": "./", "manifest": "package.json"})
        if (repository_path / "frontend" / "package.json").is_file():
            components.append({"language": "javascript", "path": "frontend/", "manifest": "package.json"})

        if (repository_path / "pyproject.toml").is_file() or (repository_path / "requirements.txt").is_file():
            components.append({"language": "python", "path": "./", "manifest": "requirements.txt/pyproject.toml"})
        if (repository_path / "backend" / "pyproject.toml").is_file() or (repository_path / "backend" / "requirements.txt").is_file():
            components.append({"language": "python", "path": "backend/", "manifest": "requirements.txt/pyproject.toml"})

        if (repository_path / "pom.xml").is_file() or (repository_path / "build.gradle").is_file():
            components.append({"language": "java", "path": "./", "manifest": "pom.xml/build.gradle"})

        # If distinct top-level languages exist (e.g. frontend/ and backend/)
        unique_langs = {c["language"] for c in components}
        if len(unique_langs) > 1 and not (repository_path / "package.json").is_file() and not (repository_path / "requirements.txt").is_file():
            # True mixed-language multi-component repo
            py_provider = self._providers["python"]
            mixed_result = CommonAnalysisResult(
                language="mixed",
                framework=None,
                test_framework="multi",
                test_command="",
                test_command_args=[],
                package_manager=None,
                source_files=[],
                test_files=[],
                project_files=[c["manifest"] for c in components],
                detected_components=components,
            )
            return py_provider, mixed_result

        # 2. Priority: package.json -> JavaScript
        if (repository_path / "package.json").is_file():
            js_provider = self._providers["javascript"]
            return js_provider, js_provider.analyze(repository_path)

        # 3. Priority: pyproject.toml / requirements.txt / setup.py -> Python
        python_manifests = ("pyproject.toml", "requirements.txt", "requirements-dev.txt", "setup.py", "setup.cfg", "Pipfile")
        if any((repository_path / m).is_file() for m in python_manifests):
            py_provider = self._providers["python"]
            return py_provider, py_provider.analyze(repository_path)

        # 4. Priority: pom.xml / build.gradle -> Java
        java_manifests = ("pom.xml", "build.gradle", "build.gradle.kts")
        if any((repository_path / m).is_file() for m in java_manifests):
            java_provider = self._providers["java"]
            return java_provider, java_provider.analyze(repository_path)

        # 5. File extension counts fallback
        js_count = 0
        py_count = 0
        java_count = 0

        try:
            for item in repository_path.rglob("*.*"):
                rel = str(item.relative_to(repository_path)).replace("\\", "/")
                parts = rel.split("/")
                if any(p in parts for p in ("node_modules", ".git", ".venv", "venv", "__pycache__", "target", "dist")):
                    continue
                if rel.endswith((".js", ".jsx")):
                    js_count += 1
                elif rel.endswith(".py"):
                    py_count += 1
                elif rel.endswith(".java"):
                    java_count += 1
        except Exception:
            pass

        if js_count > 0 and js_count >= py_count and js_count >= java_count:
            js_provider = self._providers["javascript"]
            return js_provider, js_provider.analyze(repository_path)

        if java_count > 0 and java_count > py_count and java_count > js_count:
            java_provider = self._providers["java"]
            return java_provider, java_provider.analyze(repository_path)

        # Default fallback to Python
        py_provider = self._providers["python"]
        return py_provider, py_provider.analyze(repository_path)


# Global singleton instance
default_registry = LanguageProviderRegistry()
