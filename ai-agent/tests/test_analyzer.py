from pathlib import Path
from app.analyzer import analyze_repository, detect_python_version, detect_test_framework
from app.discovery import discover_files


def test_python_language_and_version_detection(tmp_path: Path):
    (tmp_path / "pyproject.toml").write_text(
        '[project]\nname = "demo"\nrequires-python = ">=3.11"\n',
        encoding="utf-8",
    )
    (tmp_path / "main.py").write_text("print('hello')", encoding="utf-8")

    structure, _ = analyze_repository(tmp_path)
    assert structure.language == "python"
    assert structure.python_version == ">=3.11"
    assert "pyproject.toml" in structure.dependency_files


def test_pytest_detection_via_dependencies(tmp_path: Path):
    (tmp_path / "requirements.txt").write_text("pytest>=7.0.0\nrequests\n", encoding="utf-8")
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_app.py").write_text("def test_ok(): pass\n", encoding="utf-8")

    files = discover_files(tmp_path)
    framework, command = detect_test_framework(tmp_path, files)
    assert framework == "pytest"
    assert command == "pytest"


def test_unittest_detection(tmp_path: Path):
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_sample.py").write_text(
        "import unittest\nclass TestSample(unittest.TestCase):\n    def test_one(self): self.assertTrue(True)\n",
        encoding="utf-8",
    )

    files = discover_files(tmp_path)
    framework, command = detect_test_framework(tmp_path, files)
    assert framework == "unittest"
    assert command == "python -m unittest"


def test_project_structure_paths(tmp_path: Path):
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "app.py").write_text("def run(): pass\n", encoding="utf-8")
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_app.py").write_text("def test_run(): pass\n", encoding="utf-8")

    structure, _ = analyze_repository(tmp_path)
    assert "src/" in structure.source_paths
    assert "tests/" in structure.test_paths
