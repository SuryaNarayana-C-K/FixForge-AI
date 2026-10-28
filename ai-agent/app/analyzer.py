import re
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .discovery import DiscoveredFile, discover_files


@dataclass
class ProjectStructure:
    language: str
    framework: str | None = None
    test_framework: str = "pytest"
    test_command: str = "pytest"
    package_manager: str | None = None
    dependency_files: list[str] = field(default_factory=list)
    test_paths: list[str] = field(default_factory=list)
    source_paths: list[str] = field(default_factory=list)
    config_files: list[str] = field(default_factory=list)
    python_version: str | None = None
    test_command_args: list[str] = field(default_factory=list)
    detected_components: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def detect_python_version(repo_dir: Path) -> str | None:
    """Extract required/configured Python version if declared."""
    # Check .python-version
    pv_file = repo_dir / ".python-version"
    if pv_file.is_file():
        try:
            return pv_file.read_text(encoding="utf-8").strip()
        except OSError:
            pass

    # Check pyproject.toml requires-python
    pyproject_file = repo_dir / "pyproject.toml"
    if pyproject_file.is_file():
        try:
            text = pyproject_file.read_text(encoding="utf-8")
            match = re.search(r'requires-python\s*=\s*["\']([^"\']+)["\']', text)
            if match:
                return match.group(1).strip()
            match_poetry = re.search(r'python\s*=\s*["\']([^"\']+)["\']', text)
            if match_poetry:
                return match_poetry.group(1).strip()
        except OSError:
            pass

    # Check runtime.txt
    rt_file = repo_dir / "runtime.txt"
    if rt_file.is_file():
        try:
            val = rt_file.read_text(encoding="utf-8").strip()
            if val.startswith("python-"):
                return val.replace("python-", "").strip()
            return val
        except OSError:
            pass

    return None


def detect_test_framework(repo_dir: Path, files: list[DiscoveredFile]) -> tuple[str, str]:
    """
    Detect whether the project uses pytest or unittest.
    Priority:
    1. pytest
    2. unittest
    Returns (framework, command).
    """
    has_pytest_config = False
    has_pytest_dep = False
    has_unittest_code = False
    has_pytest_code = False

    # Check configuration files
    for f in files:
        base_name = Path(f.relative_path).name
        if base_name in ("pytest.ini", ".pytest.ini"):
            has_pytest_config = True
        elif base_name == "conftest.py":
            has_pytest_config = True

    # Check dependency files for pytest
    for f in files:
        base_name = Path(f.relative_path).name
        if base_name in ("requirements.txt", "requirements-dev.txt", "dev-requirements.txt"):
            try:
                content = (repo_dir / f.relative_path).read_text(encoding="utf-8")
                if re.search(r"^pytest(\b|[<>=!~])", content, re.MULTILINE | re.IGNORECASE):
                    has_pytest_dep = True
            except OSError:
                pass
        elif base_name == "pyproject.toml":
            try:
                content = (repo_dir / f.relative_path).read_text(encoding="utf-8")
                if "pytest" in content:
                    has_pytest_dep = True
                if "[tool.pytest" in content:
                    has_pytest_config = True
            except OSError:
                pass

    # Inspect test files for imports
    test_files = [
        f for f in files
        if (f.relative_path.startswith("tests/") or f.relative_path.startswith("test/"))
        and f.relative_path.endswith(".py")
    ]
    if not test_files:
        test_files = [f for f in files if Path(f.relative_path).name.startswith("test_") and f.relative_path.endswith(".py")]

    for tf in test_files[:10]:  # Limit scan to top 10 test files
        try:
            content = (repo_dir / tf.relative_path).read_text(encoding="utf-8", errors="ignore")
            if "import pytest" in content or "from pytest" in content or "@pytest." in content:
                has_pytest_code = True
            if "import unittest" in content or "from unittest" in content or "TestCase" in content:
                has_unittest_code = True
        except OSError:
            pass

    if has_pytest_config or has_pytest_dep or has_pytest_code:
        return "pytest", "pytest"

    if has_unittest_code:
        return "unittest", "python -m unittest"

    # Default to pytest if test files exist with standard naming
    if test_files:
        return "pytest", "pytest"

    return "pytest", "pytest"


def analyze_repository(repo_dir: Path, explicit_language: str | None = None) -> tuple[ProjectStructure, list[DiscoveredFile]]:
    """
    Analyzes a repository across supported languages (Python, JavaScript, Java)
    using the language provider abstraction.
    """
    from app.languages.registry import default_registry

    files = discover_files(repo_dir)
    provider, analysis_res = default_registry.detect(repo_dir, explicit_language)

    # For Python repositories, preserve detailed directory mappings
    if analysis_res.language == "python":
        test_dirs: set[str] = set()
        for f in files:
            parts = Path(f.relative_path).parts
            if len(parts) > 1 and parts[0] in ("tests", "test"):
                test_dirs.add(f"{parts[0]}/")
            elif len(parts) == 1 and parts[0].startswith("test_") and parts[0].endswith(".py"):
                test_dirs.add("./")

        source_dirs: set[str] = set()
        for f in files:
            parts = Path(f.relative_path).parts
            if len(parts) > 1:
                if parts[0] in ("src", "app", "lib", "pkg"):
                    source_dirs.add(f"{parts[0]}/")
            elif len(parts) == 1 and parts[0].endswith(".py") and not parts[0].startswith("test_"):
                source_dirs.add("./")

        python_version = detect_python_version(repo_dir)

        structure = ProjectStructure(
            language="python",
            framework=analysis_res.framework,
            test_framework=analysis_res.test_framework,
            test_command=analysis_res.test_command,
            test_command_args=analysis_res.test_command_args,
            package_manager=analysis_res.package_manager,
            dependency_files=analysis_res.dependency_files,
            test_paths=sorted(list(test_dirs)) if test_dirs else ["tests/"],
            source_paths=sorted(list(source_dirs)) if source_dirs else ["./"],
            config_files=analysis_res.config_files,
            python_version=python_version,
            detected_components=analysis_res.detected_components,
        )
        return structure, files

    # For JavaScript, Java, or Mixed
    test_paths = sorted(list({str(Path(f).parent).replace("\\", "/") + "/" for f in analysis_res.test_files})) if analysis_res.test_files else ["tests/"]
    source_paths = sorted(list({str(Path(f).parent).replace("\\", "/") + "/" for f in analysis_res.source_files})) if analysis_res.source_files else ["./"]

    structure = ProjectStructure(
        language=analysis_res.language,
        framework=analysis_res.framework,
        test_framework=analysis_res.test_framework,
        test_command=analysis_res.test_command,
        test_command_args=analysis_res.test_command_args,
        package_manager=analysis_res.package_manager,
        dependency_files=analysis_res.dependency_files,
        test_paths=test_paths,
        source_paths=source_paths,
        config_files=analysis_res.config_files,
        python_version=None,
        detected_components=analysis_res.detected_components,
    )
    return structure, files
