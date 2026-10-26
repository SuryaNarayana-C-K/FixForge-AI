"""
JavaScript Language Provider for FixForge Milestone 8.
Supports Jest and Vitest test frameworks with strict security allowlists
and safe argument array execution. Rejects arbitrary shell scripts from package.json.
"""

import json
from pathlib import Path
import re
import shutil
import sys
from typing import Any

from app.discovery import discover_files
from app.languages.base import CommonAnalysisResult, LanguageProvider


# Security blacklist: patterns that are strictly prohibited from package.json scripts
UNSAFE_SCRIPT_PATTERNS = [
    re.compile(r"\bcurl\b", re.IGNORECASE),
    re.compile(r"\bwget\b", re.IGNORECASE),
    re.compile(r"\bpowershell\b", re.IGNORECASE),
    re.compile(r"\brm\s+-rf\b", re.IGNORECASE),
    re.compile(r"\bbash\b", re.IGNORECASE),
    re.compile(r"\bsh\b", re.IGNORECASE),
    re.compile(r"\bcmd\b", re.IGNORECASE),
    re.compile(r"[|;&><`]"),  # Shell chaining and redirection metacharacters
]


class JavaScriptProvider(LanguageProvider):
    """
    Language provider for JavaScript projects (Node.js ecosystem).
    Supports Jest and Vitest test frameworks.
    """

    def get_language(self) -> str:
        return "javascript"

    def detect(self, repository_path: Path) -> bool:
        if not repository_path.is_dir():
            return False

        # 1. Manifest check
        if (repository_path / "package.json").is_file():
            return True

        # 2. File check (excluding node_modules and dot-directories)
        try:
            for ext in ("*.js", "*.jsx", "*.mjs", "*.cjs"):
                for item in repository_path.rglob(ext):
                    rel = str(item.relative_to(repository_path)).replace("\\", "/")
                    parts = rel.split("/")
                    if any(p in parts for p in ("node_modules", ".git", "dist", "build", "coverage", ".next")):
                        continue
                    return True
        except Exception:
            pass

        return False

    def get_project_files(self, repository_path: Path) -> list[str]:
        candidates = {
            "package.json",
            "package-lock.json",
            "pnpm-lock.yaml",
            "yarn.lock",
            "jest.config.js",
            "jest.config.json",
            "jest.config.mjs",
            "jest.config.cjs",
            "vitest.config.js",
            "vitest.config.mjs",
            "vitest.config.ts",
            ".babelrc",
            "babel.config.json",
            "babel.config.js",
        }
        found: list[str] = []
        for c in candidates:
            if (repository_path / c).is_file():
                found.append(c)
        return sorted(found)

    def _read_package_json(self, repository_path: Path) -> dict[str, Any]:
        pkg_path = repository_path / "package.json"
        if not pkg_path.is_file():
            return {}
        try:
            content = pkg_path.read_text(encoding="utf-8", errors="replace")
            data = json.loads(content)
            if isinstance(data, dict):
                return data
        except Exception:
            pass
        return {}

    def _is_safe_command(self, script_str: str) -> bool:
        """Verify that a script string does not contain malicious shell operators or binaries."""
        if not script_str or not isinstance(script_str, str):
            return True
        for pattern in UNSAFE_SCRIPT_PATTERNS:
            if pattern.search(script_str):
                return False
        return True

    def detect_framework(self, repository_path: Path, files: list[str]) -> tuple[str, list[str]]:
        """
        Detect Jest or Vitest from package.json and config files.
        Only allow commands from the provider's strict allowlist.
        Returns (framework_name, safe_command_args).
        """
        pkg_data = self._read_package_json(repository_path)
        deps = pkg_data.get("dependencies", {}) or {}
        dev_deps = pkg_data.get("devDependencies", {}) or {}
        scripts = pkg_data.get("scripts", {}) or {}

        all_deps = set(deps.keys()).union(set(dev_deps.keys()))
        test_script = str(scripts.get("test", ""))

        # Security check on package.json test script
        if test_script and not self._is_safe_command(test_script):
            # Prohibited script detected - fallback safely to sanitized allowlisted command
            # Do NOT execute the untrusted script string!
            pass

        has_vitest = (
            "vitest" in all_deps
            or "vitest.config.js" in files
            or "vitest.config.mjs" in files
            or "vitest" in test_script
        )

        has_jest = (
            "jest" in all_deps
            or "jest.config.js" in files
            or "jest.config.json" in files
            or "jest.config.mjs" in files
            or "jest" in test_script
        )

        if has_vitest and not has_jest:
            return "vitest", self.get_test_command(repository_path, "vitest")

        # Default to Jest for JavaScript testing
        return "jest", self.get_test_command(repository_path, "jest")

    def get_test_command(self, repository_path: Path, framework: str) -> list[str]:
        """
        Return safe, allowlisted argument array for running tests.
        Resolves the safest executable form available on current platform.
        """
        # Determine npx executable on host
        npx_cmd = "npx"
        if sys.platform == "win32":
            which_npx = shutil.which("npx.cmd") or shutil.which("npx")
            if which_npx:
                npx_cmd = which_npx

        if framework == "vitest":
            return [npx_cmd, "vitest", "run"]

        # Default: Jest with --runInBand for deterministic sequential test execution
        return [npx_cmd, "jest", "--runInBand"]

    def get_source_files(self, repository_path: Path) -> list[str]:
        discovered = discover_files(repository_path)
        sources: list[str] = []
        for f in discovered:
            rel = f.relative_path.replace("\\", "/")
            parts = rel.split("/")
            if any(p in parts for p in ("node_modules", ".git", "dist", "build", "coverage", "tests", "test", "__tests__")):
                continue
            if rel.endswith((".js", ".jsx", ".mjs", ".cjs")):
                name = Path(rel).name.lower()
                if (
                    not name.endswith((".test.js", ".spec.js", ".test.jsx", ".spec.jsx"))
                    and not name.startswith("test_")
                    and name != "jest.config.js"
                ):
                    sources.append(rel)
        return sorted(sources)

    def get_test_files(self, repository_path: Path) -> list[str]:
        discovered = discover_files(repository_path)
        tests: list[str] = []
        for f in discovered:
            rel = f.relative_path.replace("\\", "/")
            parts = rel.split("/")
            if any(p in parts for p in ("node_modules", ".git", "dist", "build", "coverage")):
                continue
            name = Path(rel).name.lower()
            if rel.endswith((".js", ".jsx", ".mjs", ".cjs")):
                if (
                    "tests" in parts
                    or "test" in parts
                    or "__tests__" in parts
                    or name.endswith((".test.js", ".spec.js", ".test.jsx", ".spec.jsx"))
                    or name.startswith("test_")
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
        package_manager = "npm"
        if (repository_path / "pnpm-lock.yaml").is_file():
            package_manager = "pnpm"
        elif (repository_path / "yarn.lock").is_file():
            package_manager = "yarn"
        elif (repository_path / "bun.lockb").is_file():
            package_manager = "bun"

        return CommonAnalysisResult(
            language="javascript",
            framework=framework,
            test_framework=framework,
            test_command=" ".join(cmd_args),
            test_command_args=cmd_args,
            package_manager=package_manager,
            source_files=source_files,
            test_files=test_files,
            project_files=project_files,
            dependency_files=[f for f in project_files if f in ("package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock")],
            config_files=[f for f in project_files if "config" in f or "babel" in f],
            version=None,
        )

    def validate_environment(self, repository_path: Path) -> dict[str, Any]:
        node_bin = shutil.which("node")
        npm_bin = shutil.which("npm") or shutil.which("npm.cmd")
        npx_bin = shutil.which("npx") or shutil.which("npx.cmd")
        return {
            "language": "javascript",
            "node_available": bool(node_bin),
            "npm_available": bool(npm_bin),
            "npx_available": bool(npx_bin),
            "available": bool(node_bin and npx_bin),
        }

    def get_execution_config(self, repository_path: Path) -> dict[str, Any]:
        return {
            "timeout": 120.0,
            "env": {
                "NODE_ENV": "test",
                "CI": "true",
            },
        }
