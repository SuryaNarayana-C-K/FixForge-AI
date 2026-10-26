from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

DEFAULT_IGNORE_DIRS = {
    ".git",
    ".venv",
    "venv",
    "env",
    "node_modules",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".tox",
    "dist",
    "build",
    "coverage",
    ".coverage",
    "htmlcov",
    ".idea",
    ".vscode",
}

DEFAULT_IGNORE_FILES = {
    ".env",
    ".DS_Store",
    "Thumbs.db",
}


@dataclass
class DiscoveredFile:
    relative_path: str
    file_type: str
    size: int


def discover_files(
    repo_dir: Path,
    extra_ignore_dirs: Sequence[str] | None = None,
    extra_ignore_files: Sequence[str] | None = None,
    max_files: int = 5000,
) -> list[DiscoveredFile]:
    """
    Safely discover files recursively in a repository while ignoring build/env directories.
    Returns file metadata (relative path, file type, size) without loading file content into memory.
    """
    ignore_dirs = DEFAULT_IGNORE_DIRS.copy()
    if extra_ignore_dirs:
        ignore_dirs.update(extra_ignore_dirs)

    ignore_files = DEFAULT_IGNORE_FILES.copy()
    if extra_ignore_files:
        ignore_files.update(extra_ignore_files)

    results: list[DiscoveredFile] = []

    def _walk(current: Path):
        nonlocal results
        if len(results) >= max_files:
            return

        try:
            entries = sorted(current.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except (PermissionError, OSError):
            return

        for entry in entries:
            name = entry.name
            if entry.is_dir():
                if name in ignore_dirs or name.startswith("."):
                    continue
                _walk(entry)
            elif entry.is_file():
                if name in ignore_files or name.endswith(".pyc"):
                    continue

                try:
                    rel_path = entry.relative_to(repo_dir).as_posix()
                    file_type = entry.suffix.lstrip(".") or "file"
                    file_size = entry.stat().st_size
                    results.append(
                        DiscoveredFile(
                            relative_path=rel_path,
                            file_type=file_type,
                            size=file_size,
                        )
                    )
                except (OSError, ValueError):
                    continue

    _walk(repo_dir)
    return results
