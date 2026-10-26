from pathlib import Path
from app.discovery import discover_files


def test_file_discovery_ignores_special_dirs(tmp_path: Path):
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "main.py").write_text("print(1)", encoding="utf-8")

    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "config").write_text("repo", encoding="utf-8")

    (tmp_path / "__pycache__").mkdir()
    (tmp_path / "__pycache__" / "main.cpython-313.pyc").write_bytes(b"123")

    (tmp_path / ".venv").mkdir()
    (tmp_path / ".venv" / "pip").write_text("binary", encoding="utf-8")

    files = discover_files(tmp_path)
    rel_paths = [f.relative_path for f in files]

    assert "src/main.py" in rel_paths
    assert not any(".git" in p for p in rel_paths)
    assert not any("__pycache__" in p for p in rel_paths)
    assert not any(".venv" in p for p in rel_paths)


def test_file_discovery_metadata(tmp_path: Path):
    test_file = tmp_path / "test.py"
    test_file.write_text("hello world", encoding="utf-8")

    files = discover_files(tmp_path)
    assert len(files) == 1
    assert files[0].relative_path == "test.py"
    assert files[0].file_type == "py"
    assert files[0].size > 0
