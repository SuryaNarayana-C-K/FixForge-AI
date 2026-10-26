"""
FixForge M12.3 — Transactional Candidate Promoter.
Only promotes the selected verified candidate patch into the main repair workspace
after evaluation. Preserves rollback snapshots and source-revision consistency.
"""

from datetime import datetime, timezone
import logging
from pathlib import Path

from app.patch.applier import PatchApplier
from app.patch_schemas import PatchApplicationResult, RepairCandidate

logger = logging.getLogger(__name__)


class TransactionalPromoter:
    """
    Applies the winning candidate patch to the target repair workspace
    with full transactional safety, git diff inspection, and snapshot-based rollback.
    """

    def __init__(self, target_repo_path: Path):
        self.target_repo_path = target_repo_path.resolve()
        self.applier = PatchApplier(self.target_repo_path)

    def promote_candidate(
        self,
        candidate: RepairCandidate | None,
    ) -> PatchApplicationResult:
        """
        Promotes the selected candidate into the main repository workspace.
        If candidate is None, preserves baseline untouched.
        """
        if candidate is None:
            return PatchApplicationResult(
                applied=False,
                status="FAILED",
                error="No candidate qualified for promotion. Baseline preserved.",
                files_modified=[],
                git_diff_before=None,
                git_diff_after=None,
                backup_id=None,
                timestamp=datetime.now(timezone.utc).isoformat(),
            )

        if not candidate.diff or not candidate.diff.strip():
            return PatchApplicationResult(
                applied=False,
                status="FAILED",
                error="Selected candidate diff is empty.",
                files_modified=[],
                git_diff_before=None,
                git_diff_after=None,
                backup_id=None,
                timestamp=datetime.now(timezone.utc).isoformat(),
            )

        # Apply patch transactionally with snapshot creation
        app_res = self.applier.apply_patch(
            candidate.diff,
            pre_validated_result=candidate.validation,
        )
        return app_res

    def rollback(self, backup_id: str) -> bool:
        """Restores repository to pristine baseline using the snapshot backup ID."""
        return self.applier.rollback(backup_id)
