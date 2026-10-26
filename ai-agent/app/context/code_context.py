"""
Code context representations and safe workspace file extraction.
"""

from dataclasses import dataclass, field
from pathlib import Path

from app.workspace import WorkspaceManager, WorkspaceSecurityError


@dataclass
class FileContext:
    rel_path: str
    total_lines: int
    content: str
    is_test_file: bool = False
    focal_lines: list[int] = field(default_factory=list)

    def format_with_line_numbers(self, start_line: int = 1, end_line: int | None = None) -> str:
        lines = self.content.splitlines()
        start_idx = max(0, start_line - 1)
        end_idx = min(len(lines), end_line) if end_line is not None else len(lines)

        formatted: list[str] = []
        for idx in range(start_idx, end_idx):
            line_no = idx + 1
            marker = " *" if line_no in self.focal_lines else "  "
            formatted.append(f"{line_no:4d}{marker} | {lines[idx]}")
        return "\n".join(formatted)


def is_test_path(path: str | Path) -> bool:
    """Determine whether a path points to test code across supported languages."""
    p_str = str(path).lower().replace("\\", "/")
    parts = p_str.split("/")
    if "tests" in parts or "test" in parts or "__tests__" in parts:
        return True
    filename = Path(p_str).name
    if (
        filename.startswith("test_")
        or filename.endswith("_test.py")
        or filename.endswith((
            ".test.js", ".spec.js", ".test.jsx", ".spec.jsx",
            ".test.mjs", ".spec.mjs", ".test.cjs", ".spec.cjs",
            ".test.ts", ".spec.ts", ".test.tsx", ".spec.tsx"
        ))
        or filename.endswith(("test.java", "tests.java", "testcase.java"))
    ):
        return True
    return False


def load_file_context(
    workspace_root: Path,
    rel_path: str,
    max_file_size: int = 51200,
    focal_lines: list[int] | None = None,
) -> FileContext | None:
    """
    Safely load file context from workspace root.
    Rejects paths escaping workspace root.
    """
    manager = WorkspaceManager()
    target_path = (workspace_root / rel_path).resolve()

    # Re-validate workspace containment
    try:
        resolved_ws = manager.resolve_repository_path(str(workspace_root))
        if not target_path.is_relative_to(resolved_ws):
            raise WorkspaceSecurityError(f"Path escape attempted: {rel_path}")
    except Exception:
        return None

    if not target_path.is_file():
        return None

    if target_path.stat().st_size > max_file_size:
        # File exceeds budget limit
        return None

    try:
        content = target_path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return None

    rel_str = str(target_path.relative_to(resolved_ws)).replace("\\", "/")
    return FileContext(
        rel_path=rel_str,
        total_lines=len(content.splitlines()),
        content=content,
        is_test_file=is_test_path(rel_str),
        focal_lines=focal_lines or [],
    )
