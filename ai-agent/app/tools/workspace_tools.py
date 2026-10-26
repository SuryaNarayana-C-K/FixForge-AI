"""
Safe workspace inspection and code exploration tools for the FixForge AI Agent.
Enforces workspace boundaries and never exposes host shell or arbitrary execution.
"""

from pathlib import Path
import re
import subprocess
from typing import Any
from pydantic import BaseModel, Field

from app.context.code_context import load_file_context
from app.discovery import discover_repository_files
from app.tools.base import AgentTool, ToolResult
from app.workspace import WorkspaceManager, WorkspaceSecurityError


# --- Tool 1: read_file ---
class ReadFileInput(BaseModel):
    file_path: str = Field(..., description="Path relative to repository root")
    start_line: int = Field(default=1, ge=1, description="Start line (1-indexed)")
    end_line: int | None = Field(default=None, description="End line (inclusive)")


class ReadFileTool(AgentTool):
    name = "read_file"
    description = "Safely read line ranges from a file in the workspace."

    def run(self, workspace_root: str, file_path: str, start_line: int = 1, end_line: int | None = None, **kwargs: Any) -> ToolResult:
        try:
            ws = WorkspaceManager().resolve_repository_path(workspace_root)
            target = (ws / file_path).resolve()
            if not target.is_relative_to(ws) or not target.is_file():
                return ToolResult(success=False, error=f"File not found or outside workspace: {file_path}")

            lines = target.read_text(encoding="utf-8", errors="replace").splitlines()
            start_idx = max(0, start_line - 1)
            end_idx = min(len(lines), end_line) if end_line is not None else len(lines)
            selected = lines[start_idx:end_idx]
            return ToolResult(
                success=True,
                output={
                    "file": file_path,
                    "start_line": start_line,
                    "end_line": start_idx + len(selected),
                    "total_lines": len(lines),
                    "content": "\n".join(selected),
                },
            )
        except Exception as e:
            return ToolResult(success=False, error=str(e))


# --- Tool 2: search_code ---
class SearchCodeInput(BaseModel):
    pattern: str = Field(..., description="Regex pattern or substring to search for")
    max_results: int = Field(default=20, le=50, description="Max matching lines to return")


class SearchCodeTool(AgentTool):
    name = "search_code"
    description = "Search for a regex pattern or string across files in the workspace."

    def run(self, workspace_root: str, pattern: str, max_results: int = 20, **kwargs: Any) -> ToolResult:
        try:
            ws = WorkspaceManager().resolve_repository_path(workspace_root)
            files = discover_repository_files(ws)
            compiled = re.compile(pattern, re.IGNORECASE)
            matches: list[dict[str, Any]] = []

            for f in files:
                target = ws / f.relative_path
                if not target.is_file():
                    continue
                try:
                    for line_idx, line in enumerate(target.read_text(encoding="utf-8", errors="replace").splitlines()):
                        if compiled.search(line):
                            matches.append({
                                "file": f.relative_path,
                                "line": line_idx + 1,
                                "text": line.strip(),
                            })
                            if len(matches) >= max_results:
                                break
                except Exception:
                    continue
                if len(matches) >= max_results:
                    break

            return ToolResult(success=True, output={"matches": matches, "count": len(matches)})
        except Exception as e:
            return ToolResult(success=False, error=str(e))


# --- Tool 3: list_files ---
class ListFilesInput(BaseModel):
    subpath: str = Field(default="", description="Subdirectory path relative to workspace root")


class ListFilesTool(AgentTool):
    name = "list_files"
    description = "List files and directories in the workspace."

    def run(self, workspace_root: str, subpath: str = "", **kwargs: Any) -> ToolResult:
        try:
            ws = WorkspaceManager().resolve_repository_path(workspace_root)
            target_dir = (ws / subpath).resolve()
            if not target_dir.is_relative_to(ws) or not target_dir.is_dir():
                return ToolResult(success=False, error=f"Directory not found or outside workspace: {subpath}")

            entries = []
            for item in sorted(target_dir.iterdir()):
                rel = str(item.relative_to(ws)).replace("\\", "/")
                entries.append({
                    "path": rel,
                    "name": item.name,
                    "is_dir": item.is_dir(),
                    "size": item.stat().st_size if item.is_file() else None,
                })
            return ToolResult(success=True, output={"entries": entries})
        except Exception as e:
            return ToolResult(success=False, error=str(e))


# --- Tool 4: get_project_structure ---
class GetProjectStructureTool(AgentTool):
    name = "get_project_structure"
    description = "Inspect repository layout, detected test framework, source directories, and manifests."

    def run(self, workspace_root: str, **kwargs: Any) -> ToolResult:
        try:
            from app.analyzer import analyze_repository
            ws = WorkspaceManager().resolve_repository_path(workspace_root)
            structure, _files = analyze_repository(ws)
            return ToolResult(success=True, output=structure.to_dict())
        except Exception as e:
            return ToolResult(success=False, error=str(e))


# --- Tool 5: get_file_context ---
class GetFileContextInput(BaseModel):
    file_path: str = Field(..., description="File path relative to repository root")
    line_number: int = Field(..., ge=1, description="Line number of interest")
    radius: int = Field(default=10, ge=1, le=50, description="Lines before and after to include")


class GetFileContextTool(AgentTool):
    name = "get_file_context"
    description = "Get surrounding code context around a focal line number."

    def run(self, workspace_root: str, file_path: str, line_number: int, radius: int = 10, **kwargs: Any) -> ToolResult:
        try:
            ws = WorkspaceManager().resolve_repository_path(workspace_root)
            fc = load_file_context(ws, file_path, focal_lines=[line_number])
            if fc is None:
                return ToolResult(success=False, error=f"Could not load file context for: {file_path}")

            start = max(1, line_number - radius)
            end = min(fc.total_lines, line_number + radius)
            formatted = fc.format_with_line_numbers(start_line=start, end_line=end)
            return ToolResult(
                success=True,
                output={
                    "file": file_path,
                    "focal_line": line_number,
                    "start_line": start,
                    "end_line": end,
                    "formatted": formatted,
                },
            )
        except Exception as e:
            return ToolResult(success=False, error=str(e))


# --- Tool 6: get_git_diff ---
class GetGitDiffTool(AgentTool):
    name = "get_git_diff"
    description = "Get current uncommitted git diff of the repository."

    def run(self, workspace_root: str, **kwargs: Any) -> ToolResult:
        try:
            ws = WorkspaceManager().resolve_repository_path(workspace_root)
            res = subprocess.run(
                ["git", "diff"],
                cwd=ws,
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            return ToolResult(success=True, output={"diff": res.stdout, "stderr": res.stderr})
        except Exception as e:
            return ToolResult(success=False, error=f"Git diff error: {str(e)}")


# --- Tool 7: get_git_status ---
class GetGitStatusTool(AgentTool):
    name = "get_git_status"
    description = "Get git status (modified, untracked files) of the repository."

    def run(self, workspace_root: str, **kwargs: Any) -> ToolResult:
        try:
            ws = WorkspaceManager().resolve_repository_path(workspace_root)
            res = subprocess.run(
                ["git", "status", "--porcelain"],
                cwd=ws,
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            return ToolResult(success=True, output={"status": res.stdout.strip(), "stderr": res.stderr})
        except Exception as e:
            return ToolResult(success=False, error=f"Git status error: {str(e)}")
