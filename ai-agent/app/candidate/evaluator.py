"""
FixForge M12.3 — Isolated Candidate Patch Evaluator.
Evaluates each candidate patch in an isolated disposable workspace created
from the immutable baseline revision. Guarantees no candidate ever bleeds into
another candidate or the canonical repository.
"""

from datetime import datetime, timezone
import json
import logging
from pathlib import Path
import shutil
import tempfile
import time
from typing import Any

from app.candidate.normalizer import compute_diff_hash, deduplicate_candidates
from app.parser import get_test_parser
from app.patch.applier import PatchApplier
from app.patch.validator import PatchValidator
from app.patch_schemas import PatchValidationResult, RepairCandidate
from app.runner import get_execution_runner
from app.verification.policy import VerificationEvaluation, VerificationPolicy

logger = logging.getLogger(__name__)


from uuid import uuid4

def create_disposable_workspace(baseline_path: Path, candidate_id: str) -> Path:
    """
    Provisions a fresh, disposable temporary directory copying the clean baseline repo.
    Excludes cache, git, backups, and nested runner workspaces to ensure complete isolation.
    """
    cand_root = baseline_path.parent / ".candidate_workspaces"
    try:
        cand_root.mkdir(parents=True, exist_ok=True)
        temp_dir = cand_root / f"cand_{candidate_id}_{uuid4().hex[:8]}"
        temp_dir.mkdir(parents=True, exist_ok=True)
    except Exception:
        temp_dir = Path(tempfile.mkdtemp(prefix=f"fixforge_cand_{candidate_id}_"))

    def _ignore_patterns(path: str, names: list[str]) -> set[str]:
        ignored = set()
        for name in names:
            if name in (
                "__pycache__",
                ".pytest_cache",
                ".git",
                ".fixforge_backups",
                ".benchmark_workspaces",
                ".candidate_workspaces",
                "node_modules",
                ".tox",
                ".venv",
            ) or name.endswith(".pyc"):
                ignored.add(name)
        return ignored

    # Copy baseline tree into the temporary directory
    shutil.copytree(baseline_path, temp_dir, dirs_exist_ok=True, ignore=_ignore_patterns)
    return temp_dir


def cleanup_disposable_workspace(ws_path: Path) -> None:
    """Safely cleans up a disposable candidate workspace."""
    try:
        if ws_path.exists():
            shutil.rmtree(ws_path, ignore_errors=True)
    except Exception as e:
        logger.warning(f"Failed to cleanup candidate workspace {ws_path}: {e}")


class CandidateEvaluator:
    """
    Evaluates candidate patches against baseline test failures in isolated disposable workspaces.
    """

    def __init__(
        self,
        baseline_repo_path: Path,
        test_command: str = "pytest",
        test_framework: str = "pytest",
        timeout: float = 60.0,
        focal_test_command: str | None = None,
        allowed_files: list[str] | None = None,
    ):
        self.baseline_repo_path = baseline_repo_path.resolve()
        self.test_command = test_command
        self.test_framework = test_framework
        self.timeout = timeout
        self.focal_test_command = focal_test_command
        self.allowed_files = allowed_files

    async def evaluate_candidate(
        self,
        candidate: RepairCandidate,
        baseline_failures: list[dict[str, Any]],
    ) -> RepairCandidate:
        """
        Executes full validation, application, and test verification lifecycle
        for a single candidate in its own isolated disposable workspace.
        """
        t0 = time.perf_counter()

        # 0. Deduplication check
        if candidate.is_duplicate:
            candidate.duration_ms = int((time.perf_counter() - t0) * 1000)
            return candidate

        if not candidate.diff or not candidate.diff.strip():
            candidate.status = "REJECTED"
            candidate.rejection_reason = "Empty patch diff."
            candidate.duration_ms = int((time.perf_counter() - t0) * 1000)
            return candidate

        # Compute stable diff hash
        if not candidate.diff_hash:
            candidate.diff_hash = compute_diff_hash(candidate.diff)

        # 1. Provision isolated disposable workspace from baseline revision
        ws_path = create_disposable_workspace(self.baseline_repo_path, candidate.candidate_id)

        try:
            # 2. Diff syntax and scope validation
            validator = PatchValidator(ws_path)
            val_res = validator.validate_patch(
                candidate.diff,
                allowed_files=self.allowed_files,
            )
            candidate.validation = val_res
            candidate.lines_added = val_res.lines_added
            candidate.lines_removed = val_res.lines_removed
            if val_res.files_to_modify:
                candidate.changed_files = list(val_res.files_to_modify)
                candidate.files = list(val_res.files_to_modify)

            if not val_res.valid:
                candidate.status = "REJECTED"
                err_msg = "; ".join(val_res.errors) if val_res.errors else "Patch validation failed"
                candidate.rejection_reason = f"Diff validation rejected: {err_msg}"
                return candidate

            # 3. Patch application check in disposable workspace
            applier = PatchApplier(ws_path)
            app_res = applier.apply_patch(candidate.diff, pre_validated_result=val_res)
            if not app_res.applied:
                candidate.status = "REJECTED"
                candidate.rejection_reason = f"Patch application failed: {app_res.error}"
                return candidate

            runner = get_execution_runner()
            parser_cls = get_test_parser(self.test_framework)

            # 4. Targeted test execution if available
            if self.focal_test_command:
                focal_exec = await runner.run(
                    command=self.focal_test_command,
                    cwd=ws_path,
                    timeout=min(self.timeout, 15.0),
                    job_id=f"eval-{candidate.candidate_id}-focal",
                )
                focal_parsed = parser_cls.parse(
                    stdout=focal_exec.stdout,
                    stderr=focal_exec.stderr,
                    exit_code=focal_exec.exit_code,
                    duration=focal_exec.duration,
                    command=self.focal_test_command,
                )
                if focal_exec.exit_code != 0 or focal_parsed.failed > 0:
                    candidate.status = "REJECTED"
                    candidate.rejection_reason = "Targeted test failed after applying candidate patch."
                    return candidate

            # 5. Required full test suite execution
            full_exec = await runner.run(
                command=self.test_command,
                cwd=ws_path,
                timeout=self.timeout,
                job_id=f"eval-{candidate.candidate_id}-full",
            )

            # 6. Parse results
            full_parsed = parser_cls.parse(
                stdout=full_exec.stdout,
                stderr=full_exec.stderr,
                exit_code=full_exec.exit_code,
                duration=full_exec.duration,
                command=self.test_command,
            )

            post_failures = [
                f.to_dict() if hasattr(f, "to_dict") else f for f in full_parsed.failures
            ]

            # 7. VerificationPolicy evaluation (includes regression detection)
            eval_res = VerificationPolicy.evaluate(
                exec_exit_code=full_exec.exit_code,
                exec_timed_out=full_exec.timed_out,
                parse_total=full_parsed.total,
                parse_passed=full_parsed.passed,
                parse_failed=full_parsed.failed,
                parse_skipped=full_parsed.skipped,
                parse_errors=full_parsed.errors,
                post_failures=post_failures,
                baseline_failures=baseline_failures,
                stdout=full_exec.stdout,
                stderr=full_exec.stderr,
            )

            candidate.evaluation = eval_res.to_dict()

            # 8. Check verification & regression status
            if eval_res.regression_detected:
                candidate.status = "REJECTED"
                candidate.rejection_reason = f"Regression detected: {eval_res.reason}"
            elif not eval_res.is_verified or eval_res.status != "PASSED":
                candidate.status = "REJECTED"
                candidate.rejection_reason = eval_res.reason
            else:
                candidate.status = "VALID"
                candidate.rejection_reason = None

            return candidate

        except Exception as e:
            candidate.status = "REJECTED"
            candidate.rejection_reason = f"Candidate evaluation infrastructure failure: {str(e)}"
            return candidate

        finally:
            cleanup_disposable_workspace(ws_path)
            candidate.duration_ms = int((time.perf_counter() - t0) * 1000)

    async def evaluate_all(
        self,
        candidates: list[RepairCandidate],
        baseline_failures: list[dict[str, Any]],
    ) -> list[RepairCandidate]:
        """
        Evaluates a bounded set of candidates across independent isolated workspaces.
        Deduplicates equivalent candidates before execution.
        """
        if not candidates:
            return []

        # 1. Deduplicate patches before execution
        unique, duplicates = deduplicate_candidates(candidates)

        evaluated: list[RepairCandidate] = []
        for cand in unique:
            res = await self.evaluate_candidate(cand, baseline_failures)
            evaluated.append(res)

        # Append duplicates with rejection reasons intact
        for dup in duplicates:
            evaluated.append(dup)

        return evaluated
