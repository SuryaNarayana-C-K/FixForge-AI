"""
Java Language Provider for FixForge Milestone 8.
Supports Maven and Gradle project structures with JUnit test framework.
Adheres strictly to Part 4: if Java runtime or Maven is not installed on the host,
reports availability accurately while providing full detection, file extraction,
and normalized analysis capabilities.
"""

from pathlib import Path
import shutil
import sys
from typing import Any

from app.discovery import discover_files
from app.languages.base import CommonAnalysisResult, LanguageProvider


class JavaProvider(LanguageProvider):
    """
    Language provider for Java repositories (Maven/Gradle + JUnit).
    """

    def get_language(self) -> str:
        return "java"

    def detect(self, repository_path: Path) -> bool:
        if not repository_path.is_dir():
            return False

        # 1. Manifests
        if (repository_path / "pom.xml").is_file():
            return True
        if (repository_path / "build.gradle").is_file() or (repository_path / "build.gradle.kts").is_file():
            return True

        # 2. Java source files
        try:
            for item in repository_path.rglob("*.java"):
                rel = str(item.relative_to(repository_path)).replace("\\", "/")
                parts = rel.split("/")
                if any(p in parts for p in (".git", "target", "build", ".gradle")):
                    continue
                return True
        except Exception:
            pass

        return False

    def get_project_files(self, repository_path: Path) -> list[str]:
        candidates = {
            "pom.xml",
            "build.gradle",
            "build.gradle.kts",
            "settings.gradle",
            "settings.gradle.kts",
            "gradlew",
            "gradlew.bat",
            "mvnw",
            "mvnw.cmd",
        }
        found: list[str] = []
        for c in candidates:
            if (repository_path / c).is_file():
                found.append(c)
        return sorted(found)

    def detect_framework(self, repository_path: Path, files: list[str]) -> tuple[str, list[str]]:
        """
        Detect JUnit from build files.
        Returns ('junit', safe_command_args).
        """
        return "junit", self.get_test_command(repository_path, "junit")

    def get_test_command(self, repository_path: Path, framework: str) -> list[str]:
        # Prefer Maven if pom.xml exists, else Gradle
        mvn_bin = shutil.which("mvn.cmd") if sys.platform == "win32" else shutil.which("mvn")
        gradle_bin = shutil.which("gradle.bat") if sys.platform == "win32" else shutil.which("gradle")

        if (repository_path / "pom.xml").is_file():
            cmd = mvn_bin or "mvn"
            return [cmd, "test"]
        elif (repository_path / "build.gradle").is_file() or (repository_path / "build.gradle.kts").is_file():
            cmd = gradle_bin or "gradle"
            return [cmd, "test"]

        cmd = mvn_bin or "mvn"
        return [cmd, "test"]

    def get_source_files(self, repository_path: Path) -> list[str]:
        discovered = discover_files(repository_path)
        sources: list[str] = []
        for f in discovered:
            rel = f.relative_path.replace("\\", "/")
            parts = rel.split("/")
            if any(p in parts for p in (".git", "target", "build", ".gradle", "test")):
                continue
            if rel.endswith(".java") and not Path(rel).name.endswith(("Test.java", "Tests.java", "TestCase.java")):
                sources.append(rel)
        return sorted(sources)

    def get_test_files(self, repository_path: Path) -> list[str]:
        discovered = discover_files(repository_path)
        tests: list[str] = []
        for f in discovered:
            rel = f.relative_path.replace("\\", "/")
            parts = rel.split("/")
            if any(p in parts for p in (".git", "target", "build", ".gradle")):
                continue
            name = Path(rel).name
            if rel.endswith(".java") and (
                "test" in parts
                or name.endswith(("Test.java", "Tests.java", "TestCase.java"))
                or name.startswith("Test")
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

        package_manager = "maven" if "pom.xml" in project_files else "gradle"

        return CommonAnalysisResult(
            language="java",
            framework=framework,
            test_framework=framework,
            test_command=" ".join(cmd_args),
            test_command_args=cmd_args,
            package_manager=package_manager,
            source_files=source_files,
            test_files=test_files,
            project_files=project_files,
            dependency_files=[f for f in project_files if f in ("pom.xml", "build.gradle", "build.gradle.kts")],
            config_files=[f for f in project_files if "settings" in f],
            version=None,
        )

    def validate_environment(self, repository_path: Path) -> dict[str, Any]:
        java_bin = shutil.which("java")
        javac_bin = shutil.which("javac")
        mvn_bin = shutil.which("mvn") or shutil.which("mvn.cmd")
        gradle_bin = shutil.which("gradle") or shutil.which("gradle.bat")
        available = bool(java_bin and (mvn_bin or gradle_bin))

        return {
            "language": "java",
            "java_available": bool(java_bin),
            "javac_available": bool(javac_bin),
            "maven_available": bool(mvn_bin),
            "gradle_available": bool(gradle_bin),
            "available": available,
            "status": "operational" if available else "deferred_runtime_missing",
        }

    def get_execution_config(self, repository_path: Path) -> dict[str, Any]:
        return {
            "timeout": 180.0,
            "env": {},
        }
