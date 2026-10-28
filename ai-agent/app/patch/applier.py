"""
Safe patch application service with pre-flight validation, automatic snapshots, and rollback capability.
"""

from datetime import datetime, timezone
from pathlib import Path
import re
import shutil
import subprocess
from uuid import uuid4

from app.patch.validator import PatchValidator, parse_unified_diff_files, split_diff_by_file
from app.patch_schemas import PatchApplicationResult, PatchValidationResult
from app.workspace import WorkspaceManager


import json

def apply_hunks_to_content(content: str, diff_text: str) -> str:
    """
    Applies unified diff hunks to string content.
    Matches lines to remove (-) and substitutes with lines to add (+),
    processing each diff hunk sequentially with context awareness.
    Supports added, deleted, modified, and empty files.
    """
    if not diff_text or not diff_text.strip():
        return content

    hunks: list[tuple[list[str], list[str]]] = []
    lines = diff_text.splitlines()
    curr_orig: list[str] = []
    curr_repl: list[str] = []
    in_hunk = False

    for line in lines:
        if line.startswith("@@"):
            if in_hunk and (curr_orig or curr_repl):
                hunks.append((curr_orig, curr_repl))
                curr_orig = []
                curr_repl = []
            in_hunk = True
            continue
        if in_hunk:
            if line.startswith("-") and not line.startswith("---"):
                curr_orig.append(line[1:])
            elif line.startswith("+") and not line.startswith("+++"):
                curr_repl.append(line[1:])
            elif not line.startswith("\\") and not line.startswith("diff") and not line.startswith("index"):
                # Context line (starts with space or empty context line)
                ctx = line[1:] if line.startswith(" ") else line
                curr_orig.append(ctx)
                curr_repl.append(ctx)

    if in_hunk and (curr_orig or curr_repl):
        hunks.append((curr_orig, curr_repl))

    # If no @@ headers were found, treat diff lines as a single block
    if not hunks:
        for line in lines:
            if line.startswith("-") and not line.startswith("---"):
                curr_orig.append(line[1:])
            elif line.startswith("+") and not line.startswith("+++"):
                curr_repl.append(line[1:])
        if curr_orig or curr_repl:
            hunks.append((curr_orig, curr_repl))

    result = content
    for orig_chunk_lines, repl_chunk_lines in hunks:
        orig_chunk = "\n".join(orig_chunk_lines)
        repl_chunk = "\n".join(repl_chunk_lines)

        # 0. Handle initially empty content (added or empty file)
        if not result and repl_chunk_lines:
            result = repl_chunk + ("\n" if not repl_chunk.endswith("\n") else "")
            continue

        # 0b. Pure addition hunk (e.g. appended to file)
        if not orig_chunk_lines and repl_chunk_lines:
            if result:
                result = result.rstrip("\n") + "\n" + repl_chunk + "\n"
            else:
                result = repl_chunk + "\n"
            continue

        # 1. Full context match
        if orig_chunk and orig_chunk in result:
            result = result.replace(orig_chunk, repl_chunk, 1)
            continue

        # 2. Match only removals/additions without surrounding context
        removals = [l for l in orig_chunk_lines if l not in repl_chunk_lines]
        additions = [l for l in repl_chunk_lines if l not in orig_chunk_lines]
        rem_block = "\n".join(removals)
        add_block = "\n".join(additions)

        if rem_block and rem_block in result:
            result = result.replace(rem_block, add_block, 1)
            continue

        # 3. Line-by-line fallback matching stripped lines
        raw_lines = result.splitlines()
        res_lines: list[str] = []
        i = 0
        matched = False
        while i < len(raw_lines):
            line = raw_lines[i]
            if not matched and removals and (line == removals[0] or line.strip() == removals[0].strip()):
                match = True
                for r_idx, rem in enumerate(removals):
                    if i + r_idx >= len(raw_lines) or raw_lines[i + r_idx].strip() != rem.strip():
                        match = False
                        break
                if match:
                    matched_indent = line[: len(line) - len(line.lstrip())]
                    for add in additions:
                        res_lines.append(f"{matched_indent}{add.lstrip()}")
                    i += len(removals)
                    matched = True
                    continue
            res_lines.append(line)
            i += 1

        if matched:
            result = "\n".join(res_lines) + ("\n" if result.endswith("\n") else "")

    return result


class PatchApplier:
    """Manages transactional patch application with backups and git tracking."""

    def __init__(self, workspace_root: Path, workspace_mgr: WorkspaceManager | None = None):
        self.workspace_root = Path(workspace_root).resolve()
        self.workspace_mgr = workspace_mgr or WorkspaceManager()

    def _resolve_ws(self) -> Path:
        try:
            return self.workspace_mgr.resolve_repository_path(str(self.workspace_root))
        except Exception:
            if self.workspace_root.exists() and self.workspace_root.is_dir():
                return self.workspace_root
            raise

    def _get_git_output(self, args: list[str]) -> str | None:
        try:
            res = subprocess.run(
                ["git"] + args,
                cwd=self.workspace_root,
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
            return res.stdout
        except Exception:
            return None

    def apply_patch(
        self,
        diff_text: str,
        pre_validated_result: PatchValidationResult | None = None,
    ) -> PatchApplicationResult:
        timestamp = datetime.now(timezone.utc).isoformat()
        resolved_ws = self._resolve_ws()

        # 1. Pre-validation
        validator = PatchValidator(resolved_ws)
        val = pre_validated_result or validator.validate_patch(diff_text)
        if not val.valid:
            err_msg = "; ".join(val.errors) if val.errors else f"Patch validation failed with status {val.status}"
            return PatchApplicationResult(
                applied=False,
                status="FAILED",
                error=err_msg,
                files_modified=[],
                git_diff_before=None,
                git_diff_after=None,
                backup_id=None,
                timestamp=timestamp,
            )

        # 2. Capture Git state before patch
        git_diff_before = self._get_git_output(["diff"])

        # 3. Create snapshot/backup
        backup_id = f"backup-{uuid4().hex[:8]}"
        backup_dir = resolved_ws / ".fixforge_backups" / backup_id
        backup_dir.mkdir(parents=True, exist_ok=True)

        snapshots: dict[Path, str] = {}
        target_files: list[tuple[Path, str, bool, bool]] = []  # (fpath, rel_path, is_added, is_deleted)
        created_files_manifest: list[str] = []

        file_pairs = parse_unified_diff_files(diff_text)
        for old_rel, new_rel in file_pairs:
            is_added = old_rel in ("/dev/null", "dev/null") or old_rel is None
            is_deleted = new_rel in ("/dev/null", "dev/null")
            rel_path = new_rel if not is_deleted else old_rel
            fpath = (resolved_ws / rel_path).resolve()

            if is_added or not fpath.exists():
                target_files.append((fpath, rel_path, True, False))
                created_files_manifest.append(rel_path)
            elif is_deleted:
                try:
                    orig_text = fpath.read_text(encoding="utf-8", errors="replace")
                    snapshots[fpath] = orig_text
                    b_file = backup_dir / rel_path
                    b_file.parent.mkdir(parents=True, exist_ok=True)
                    b_file.write_text(orig_text, encoding="utf-8")
                    target_files.append((fpath, rel_path, False, True))
                except Exception as e:
                    shutil.rmtree(backup_dir, ignore_errors=True)
                    return PatchApplicationResult(
                        applied=False,
                        status="FAILED",
                        error=f"Failed to create backup snapshot for deleted file {rel_path}: {str(e)}",
                        files_modified=[],
                        git_diff_before=git_diff_before,
                        git_diff_after=None,
                        backup_id=None,
                        timestamp=timestamp,
                    )
            else:
                try:
                    orig_text = fpath.read_text(encoding="utf-8", errors="replace")
                    snapshots[fpath] = orig_text
                    b_file = backup_dir / rel_path
                    b_file.parent.mkdir(parents=True, exist_ok=True)
                    b_file.write_text(orig_text, encoding="utf-8")
                    target_files.append((fpath, rel_path, False, False))
                except Exception as e:
                    shutil.rmtree(backup_dir, ignore_errors=True)
                    return PatchApplicationResult(
                        applied=False,
                        status="FAILED",
                        error=f"Failed to create backup snapshot for {rel_path}: {str(e)}",
                        files_modified=[],
                        git_diff_before=git_diff_before,
                        git_diff_after=None,
                        backup_id=None,
                        timestamp=timestamp,
                    )

        # Save manifest for rollback
        manifest = {
            "created_files": created_files_manifest,
            "backup_id": backup_id,
        }
        (backup_dir / ".manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

        # 4. Apply patch: Try git apply first if in a git repo
        files_modified: list[str] = []
        git_applied = False
        try:
            res = subprocess.run(
                ["git", "apply", "--ignore-space-change", "--whitespace=nowarn"],
                input=diff_text,
                cwd=resolved_ws,
                text=True,
                capture_output=True,
                timeout=5,
            )
            if res.returncode == 0:
                git_applied = True
                files_modified = [rel for _, rel, _, _ in target_files]
        except Exception:
            pass

        if not git_applied:
            created_during_apply: list[Path] = []
            try:
                file_diffs = split_diff_by_file(diff_text)
                for fpath, rel_path, is_added, is_deleted in target_files:
                    if is_deleted:
                        if fpath.exists():
                            fpath.unlink()
                        files_modified.append(rel_path)
                        continue

                    orig_content = snapshots.get(fpath, "")
                    file_diff = file_diffs.get(rel_path, diff_text)
                    new_content = apply_hunks_to_content(orig_content, file_diff)
                    if not is_added and new_content == orig_content:
                        raise ValueError(f"Diff did not modify content of {rel_path}")

                    fpath.parent.mkdir(parents=True, exist_ok=True)
                    if not fpath.exists():
                        created_during_apply.append(fpath)
                    fpath.write_text(new_content, encoding="utf-8")
                    files_modified.append(rel_path)
            except Exception as e:
                # ROLLBACK:
                # 1. Unlink newly created files
                for fpath in created_during_apply:
                    try:
                        fpath.unlink(missing_ok=True)
                    except Exception:
                        pass
                # 2. Restore modified/deleted files from snapshot
                for fpath, orig_content in snapshots.items():
                    try:
                        fpath.parent.mkdir(parents=True, exist_ok=True)
                        fpath.write_text(orig_content, encoding="utf-8")
                    except Exception:
                        pass
                return PatchApplicationResult(
                    applied=False,
                    status="ROLLED_BACK",
                    error=f"Patch application failed during write; rollback executed: {str(e)}",
                    files_modified=[],
                    git_diff_before=git_diff_before,
                    git_diff_after=self._get_git_output(["diff"]),
                    backup_id=backup_id,
                    timestamp=timestamp,
                )

        # 5. Capture Git state after patch
        git_diff_after = self._get_git_output(["diff"])

        return PatchApplicationResult(
            applied=True,
            status="APPLIED",
            error=None,
            files_modified=files_modified,
            git_diff_before=git_diff_before,
            git_diff_after=git_diff_after,
            backup_id=backup_id,
            timestamp=timestamp,
        )

    def rollback(self, backup_id: str) -> bool:
        """
        Restore original repository files from a backup snapshot directory.
        Removes any files created during the patch according to .manifest.json.
        Returns True if rollback was executed cleanly.
        """
        resolved_ws = self._resolve_ws()
        backup_dir = resolved_ws / ".fixforge_backups" / backup_id
        if not backup_dir.is_dir():
            return False

        # Check manifest for created files to delete
        manifest_file = backup_dir / ".manifest.json"
        if manifest_file.is_file():
            try:
                manifest_data = json.loads(manifest_file.read_text(encoding="utf-8"))
                for created_rel in manifest_data.get("created_files", []):
                    created_path = (resolved_ws / created_rel).resolve()
                    if created_path.is_relative_to(resolved_ws) and created_path.exists():
                        created_path.unlink(missing_ok=True)
            except Exception:
                pass

        restored_any = False
        for b_file in backup_dir.rglob("*"):
            if b_file.is_file() and b_file.name != ".manifest.json":
                rel_path = b_file.relative_to(backup_dir)
                dest = resolved_ws / rel_path
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_text(b_file.read_text(encoding="utf-8", errors="replace"), encoding="utf-8")
                restored_any = True

        return restored_any

