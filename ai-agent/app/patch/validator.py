"""
Patch validation service ensuring structural integrity, containment, and security constraints.
Rejects test file tampering, protected infrastructure modifications, and path traversal attempts.
"""

from pathlib import Path
import re
from typing import Any

from app.context.code_context import is_test_path
from app.patch_schemas import PatchValidationResult
from app.workspace import WorkspaceManager, WorkspaceSecurityError

PROTECTED_FILE_PATTERNS = [
    r"dockerfile.*",
    r"\.dockerignore",
    r"docker-compose.*\.ya?ml",
    r"\.env.*",
    r"\.github/.*",
    r"\.gitlab-ci\.yml",
    r"sandbox/.*",
    r"package-lock\.json",
    r"pnpm-lock\.yaml",
    r".*schema\.prisma",
]


def is_protected_file(path_str: str) -> bool:
    """Check if file is protected infrastructure or configuration."""
    normalized = path_str.lower().replace("\\", "/").lstrip("/")
    for pat in PROTECTED_FILE_PATTERNS:
        if re.fullmatch(pat, normalized, re.IGNORECASE) or re.search(pat, normalized, re.IGNORECASE):
            return True
    return False


def parse_unified_diff_files(diff_text: str) -> list[tuple[str, str]]:
    """
    Parse unified diff headers to extract (old_path, new_path) tuples.
    Matches lines like:
    --- a/src/calculator.py
    +++ b/src/calculator.py
    """
    file_pairs: list[tuple[str, str]] = []
    lines = diff_text.splitlines()
    old_file: str | None = None

    for line in lines:
        if line.startswith("--- "):
            raw = line[4:].strip()
            # strip a/ prefix if present
            if raw.startswith("a/"):
                raw = raw[2:]
            old_file = raw
        elif line.startswith("+++ ") and old_file is not None:
            raw = line[4:].strip()
            if raw.startswith("b/"):
                raw = raw[2:]
            file_pairs.append((old_file, raw))
            old_file = None

    return file_pairs


def split_diff_by_file(diff_text: str) -> dict[str, str]:
    """
    Split a unified diff string that may contain changes for multiple files
    into a dictionary mapping relative file path to its file-specific diff string.
    Correctly resolves target paths for added (/dev/null -> b/file) and deleted (a/file -> /dev/null) files.
    """
    if not diff_text or not diff_text.strip():
        return {}

    lines = diff_text.splitlines()
    file_diffs: dict[str, list[str]] = {}
    sections: list[tuple[int, str]] = []

    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("diff --git"):
            start_idx = i
            target_path = None
            old_raw = None
            j = i + 1
            while j < len(lines) and not lines[j].startswith("diff --git"):
                if lines[j].startswith("--- "):
                    old_raw = lines[j][4:].strip()
                    if old_raw.startswith("a/"):
                        old_raw = old_raw[2:]
                elif lines[j].startswith("+++ "):
                    raw = lines[j][4:].strip()
                    if raw.startswith("b/"):
                        raw = raw[2:]
                    chosen = raw if raw not in ("/dev/null", "dev/null") else (old_raw or raw)
                    target_path = chosen.replace("\\", "/").lstrip("/")
                    break
                j += 1
            if target_path:
                sections.append((start_idx, target_path))
            i = j if target_path else i + 1
            continue
        elif line.startswith("--- "):
            start_idx = i
            if i + 1 < len(lines) and lines[i + 1].startswith("+++ "):
                old_raw = line[4:].strip()
                if old_raw.startswith("a/"):
                    old_raw = old_raw[2:]
                raw = lines[i + 1][4:].strip()
                if raw.startswith("b/"):
                    raw = raw[2:]
                chosen = raw if raw not in ("/dev/null", "dev/null") else old_raw
                target_path = chosen.replace("\\", "/").lstrip("/")
                sections.append((start_idx, target_path))
                i += 2
                continue
        i += 1

    if not sections:
        return {}

    for idx, (start_idx, target_path) in enumerate(sections):
        end_idx = sections[idx + 1][0] if idx + 1 < len(sections) else len(lines)
        diff_chunk = "\n".join(lines[start_idx:end_idx]).strip()
        if target_path not in file_diffs:
            file_diffs[target_path] = [diff_chunk]
        else:
            file_diffs[target_path].append(diff_chunk)

    return {fpath: "\n\n".join(chunks) for fpath, chunks in file_diffs.items()}


def validate_diff_syntax(diff_text: str) -> list[str]:
    """Check for truncated or malformed unified diff structures."""
    syntax_errors = []
    lines = diff_text.splitlines()
    has_change = False

    for i, line in enumerate(lines):
        if line.startswith("@@"):
            # Check for properly formed hunk header: @@ -l,c +l,c @@
            if line.count("@@") < 2:
                syntax_errors.append(f"Malformed or truncated hunk header at line {i+1}: '{line}'")
            continue
        if line.startswith("-") and not line.startswith("---"):
            has_change = True
        elif line.startswith("+") and not line.startswith("+++"):
            has_change = True

    if not has_change:
        syntax_errors.append("Malformed diff: contains no removal (-) or addition (+) lines.")

    return syntax_errors


def dry_run_apply_hunk(original_lines: list[str], diff_text: str) -> tuple[bool, str]:
    """
    Simulate applying the diff to original_lines to verify clean applicability.
    Returns (success, error_message).
    """
    lines_to_remove: list[str] = []
    for line in diff_text.splitlines():
        if line.startswith("-") and not line.startswith("---"):
            lines_to_remove.append(line[1:])

    orig_text = "\n".join(original_lines)
    for rem in lines_to_remove:
        if rem.strip() and rem.strip() not in orig_text:
            return False, f"Target line to replace not found in original file: '{rem.strip()}'"

    return True, ""


class PatchValidator:
    """Validates diffs before application against security rules, file integrity, and scope."""

    def __init__(self, workspace_root: Path, workspace_mgr: WorkspaceManager | None = None):
        self.workspace_root = Path(workspace_root).resolve()
        self.workspace_mgr = workspace_mgr or WorkspaceManager()

    def validate_patch(
        self,
        diff_text: str,
        allowed_files: list[str] | set[str] | None = None,
    ) -> PatchValidationResult:
        errors: list[str] = []
        warnings: list[str] = []
        files_to_modify: list[str] = []
        lines_added = 0
        lines_removed = 0

        if not diff_text or not diff_text.strip():
            return PatchValidationResult(
                valid=False,
                status="INVALID",
                errors=["Patch diff is empty."],
                warnings=[],
                files_to_modify=[],
                lines_added=0,
                lines_removed=0,
            )

        # 0. Check syntax/truncation
        syntax_errs = validate_diff_syntax(diff_text)
        if syntax_errs:
            errors.extend(syntax_errs)

        # 1. Parse file headers
        file_pairs = parse_unified_diff_files(diff_text)
        if not file_pairs:
            return PatchValidationResult(
                valid=False,
                status="INVALID",
                errors=errors or ["Malformed unified diff: missing standard '--- a/...' and '+++ b/...' headers."],
                warnings=[],
                files_to_modify=[],
                lines_added=0,
                lines_removed=0,
            )

        # 2. Count lines added and removed
        for line in diff_text.splitlines():
            if line.startswith("+") and not line.startswith("+++"):
                lines_added += 1
            elif line.startswith("-") and not line.startswith("---"):
                lines_removed += 1

        try:
            resolved_ws = self.workspace_mgr.resolve_repository_path(str(self.workspace_root))
        except Exception as e:
            if self.workspace_root.exists() and self.workspace_root.is_dir():
                resolved_ws = self.workspace_root
            else:
                return PatchValidationResult(
                    valid=False,
                    status="INVALID",
                    errors=[f"Workspace validation error: {str(e)}"],
                    warnings=[],
                    files_to_modify=[],
                    lines_added=lines_added,
                    lines_removed=lines_removed,
                )

        has_review_required = False
        file_diffs = split_diff_by_file(diff_text)

        # Prepare normalized allowed files set if provided
        normalized_allowed = None
        if allowed_files:
            normalized_allowed = {
                f.replace("\\", "/").lstrip("./").lower() for f in allowed_files if f
            }

        for old_path, new_path in file_pairs:
            # Resolve target relative path (handling added / deleted files)
            if new_path and new_path not in ("/dev/null", "dev/null"):
                target_rel = new_path
            else:
                target_rel = old_path

            is_added_file = old_path in ("/dev/null", "dev/null") or old_path is None
            is_deleted_file = new_path in ("/dev/null", "dev/null")

            # Check for path traversal / absolute paths
            if ".." in target_rel or target_rel.startswith("/") or target_rel.startswith("\\"):
                errors.append(f"Security violation: path traversal detected in patch file '{target_rel}'")
                continue

            # Scope / Relevance check: reject patches touching unrelated files
            if normalized_allowed is not None:
                norm_rel = target_rel.replace("\\", "/").lstrip("./").lower()
                if norm_rel not in normalized_allowed:
                    errors.append(
                        f"Unjustified file modification: '{target_rel}' was not identified "
                        f"in the root cause evidence or patch plan."
                    )
                    continue

            target_file = (resolved_ws / target_rel).resolve()
            if not target_file.is_relative_to(resolved_ws):
                errors.append(f"Security violation: path escapes workspace boundaries: '{target_rel}'")
                continue

            # Symlink escape protection
            if target_file.is_symlink():
                try:
                    resolved_sym = target_file.resolve()
                    if not resolved_sym.is_relative_to(resolved_ws):
                        errors.append(f"Security violation: symlink escape detected in '{target_rel}'")
                        continue
                except Exception as e:
                    errors.append(f"Security violation: failed resolving symlink '{target_rel}': {e}")
                    continue

            # 3. Test modification protection
            if is_test_path(target_rel):
                errors.append(
                    f"Test modification rejected: '{target_rel}' is a test file. "
                    f"FixForge policy mandates tests are strictly read-only during repair."
                )
                continue

            # 4. Security file protection
            if is_protected_file(target_rel):
                warnings.append(
                    f"Protected infrastructure file targeted: '{target_rel}'. Requires manual review."
                )
                has_review_required = True

            # 5. File existence (added files are permitted not to exist yet)
            if not is_added_file and not target_file.is_file():
                errors.append(f"Target file does not exist in workspace: '{target_rel}'")
                continue

            files_to_modify.append(target_rel)

            # 6. Dry run check
            try:
                orig_lines = []
                if target_file.is_file():
                    orig_lines = target_file.read_text(encoding="utf-8", errors="replace").splitlines()
                elif not is_added_file:
                    errors.append(f"Target file does not exist in workspace: '{target_rel}'")
                    continue

                file_diff = file_diffs.get(target_rel, diff_text)
                clean_apply, dry_err = dry_run_apply_hunk(orig_lines, file_diff)
                if not clean_apply:
                    errors.append(f"Patch does not apply cleanly to '{target_rel}': {dry_err}")
            except Exception as e:
                errors.append(f"Failed reading target file '{target_rel}': {str(e)}")

        if has_review_required:
            return PatchValidationResult(
                valid=False,
                status="REQUIRES_REVIEW",
                errors=errors,
                warnings=warnings,
                files_to_modify=files_to_modify,
                lines_added=lines_added,
                lines_removed=lines_removed,
            )

        if errors:
            return PatchValidationResult(
                valid=False,
                status="INVALID",
                errors=errors,
                warnings=warnings,
                files_to_modify=files_to_modify,
                lines_added=lines_added,
                lines_removed=lines_removed,
            )

        return PatchValidationResult(
            valid=True,
            status="VALID",
            errors=[],
            warnings=warnings,
            files_to_modify=files_to_modify,
            lines_added=lines_added,
            lines_removed=lines_removed,
        )
