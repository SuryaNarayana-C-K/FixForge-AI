"""
FixForge M12.3 — Candidate Patch Ranker & Selection Engine.
Deterministically ranks verified candidates using explicit criteria:
- Verified test pass with zero regressions
- Minimal lines changed (added + removed)
- Smaller file scope (1-2 files preferred over multi-file)
- Lower complexity (single hunk preferred)
- Stable tie-breaking that never allows model confidence to override test results
"""

import re
from typing import Any

from app.patch_schemas import RepairCandidate


class CandidateRanker:
    """
    Ranks successful candidate patches and selects the optimal repair candidate.
    """

    @staticmethod
    def _count_hunks(diff_text: str) -> int:
        """Counts the number of @@ hunk headers in unified diff."""
        if not diff_text:
            return 0
        return len(re.findall(r"^@@", diff_text, flags=re.MULTILINE))

    @classmethod
    def score_candidate(cls, candidate: RepairCandidate) -> tuple[float, list[str]]:
        """
        Computes a deterministic score and inspectable reasoning list for a verified candidate.
        Invalid, unverified, or regression-inducing candidates score 0.0 or negative.
        """
        score = 0.0
        reasons: list[str] = []

        eval_data = candidate.evaluation or {}
        is_verified = bool(eval_data.get("is_verified", False))
        regression = bool(eval_data.get("regression_detected", False))

        if not is_verified or regression:
            return 0.0, ["Candidate failed verification or introduced regressions (+0.0)"]

        # 1. Verification pass baseline (+50.0)
        score += 50.0
        passed_tests = eval_data.get("passed", 0)
        reasons.append(f"Passed all {passed_tests} executed tests cleanly without regressions (+50.0)")

        # 2. Resolved baseline failures bonus (+15.0 per resolved failure)
        resolved = eval_data.get("resolved_failures", [])
        if resolved:
            resolved_bonus = len(resolved) * 15.0
            score += resolved_bonus
            reasons.append(f"Successfully resolved {len(resolved)} baseline test failure(s) (+{resolved_bonus:.1f})")

        # 3. Minimal change penalty (prefer smaller changes: lines added + removed)
        total_lines_changed = candidate.lines_added + candidate.lines_removed
        lines_penalty = round(0.5 * total_lines_changed, 2)
        score -= lines_penalty
        reasons.append(f"Patch change volume penalty: {total_lines_changed} lines changed (-{lines_penalty})")

        # 4. Diff size penalty
        diff_len = len(candidate.diff or "")
        diff_penalty = round(0.01 * min(diff_len, 2000), 2)
        score -= diff_penalty
        reasons.append(f"Diff character length penalty: {diff_len} chars (-{diff_penalty})")

        # 5. File scope preference (Occam's razor)
        files_count = len(candidate.changed_files or candidate.files)
        if files_count == 1:
            score += 15.0
            reasons.append("Single-file repair scope adheres strictly to Occam's razor (+15.0)")
        elif files_count == 2:
            score += 10.0
            reasons.append("Two-file repair scope is tightly bounded (+10.0)")
        elif files_count > 2:
            scope_penalty = (files_count - 2) * 5.0
            score -= scope_penalty
            reasons.append(f"Multi-file repair scope ({files_count} files) (-{scope_penalty})")

        # 6. Patch complexity and risk (hunk count)
        hunk_count = cls._count_hunks(candidate.diff)
        if hunk_count <= 1:
            score += 5.0
            reasons.append("Single-hunk localized modification (+5.0)")
        elif hunk_count > 1:
            hunk_penalty = (hunk_count - 1) * 2.0
            score -= hunk_penalty
            reasons.append(f"Multiple hunk modifications ({hunk_count} hunks) (-{hunk_penalty})")

        # 7. Model self-confidence minor weighting (max 0.5 pts, CANNOT override test results)
        meta = candidate.generation_metadata or {}
        conf = float(meta.get("confidence", 0.0))
        if 0.0 < conf <= 1.0:
            conf_pts = round(conf * 0.5, 2)
            score += conf_pts
            reasons.append(f"Minor model confidence weight ({conf:.2f} * 0.5 = +{conf_pts})")

        return round(score, 2), reasons

    @classmethod
    def rank_and_select(
        cls,
        candidates: list[RepairCandidate],
    ) -> tuple[RepairCandidate | None, list[RepairCandidate]]:
        """
        Ranks evaluated candidates deterministically, assigns ranking scores/reasons,
        and selects the highest-scoring candidate that satisfies verification.

        Returns:
            (selected_candidate, all_processed_candidates)
        """
        if not candidates:
            return None, []

        passing_candidates: list[RepairCandidate] = []
        rejected_candidates: list[RepairCandidate] = []

        for cand in candidates:
            eval_data = cand.evaluation or {}
            is_verified = bool(eval_data.get("is_verified", False))
            regression = bool(eval_data.get("regression_detected", False))

            if cand.status in ("VALID", "EVALUATED") and is_verified and not regression:
                score, reasons = cls.score_candidate(cand)
                cand.ranking_score = score
                cand.ranking_reasons = reasons
                passing_candidates.append(cand)
            else:
                if cand.status != "REJECTED":
                    cand.status = "REJECTED"
                if not cand.rejection_reason:
                    cand.rejection_reason = eval_data.get("reason", "Verification criteria not satisfied.")
                cand.ranking_score = 0.0
                cand.ranking_reasons = [f"Rejected: {cand.rejection_reason}"]
                rejected_candidates.append(cand)

        # Sort passing candidates deterministically:
        # 1. Ranking score descending
        # 2. Total lines changed ascending (fewer lines changed wins)
        # 3. Diff length ascending
        # 4. Candidate ID ascending (stable tie-breaker)
        passing_candidates.sort(
            key=lambda c: (
                -(c.ranking_score or 0.0),
                (c.lines_added + c.lines_removed),
                len(c.diff or ""),
                c.candidate_id,
            )
        )

        selected: RepairCandidate | None = None
        if passing_candidates:
            selected = passing_candidates[0]
            selected.status = "SELECTED"
            selected.selection_reasons = list(selected.ranking_reasons)
            selected.selection_rationale = (
                f"Selected candidate '{selected.candidate_id}' (score {selected.ranking_score:.2f}) "
                f"as optimal verified patch: {'; '.join(selected.ranking_reasons)}"
            )

            # Annotate remaining passing candidates as EVALUATED
            for other in passing_candidates[1:]:
                other.status = "EVALUATED"
                other.selection_reasons = list(other.ranking_reasons)
                other.selection_rationale = (
                    f"Candidate '{other.candidate_id}' passed verification (score {other.ranking_score:.2f}), "
                    f"but ranked below '{selected.candidate_id}'"
                )

        all_candidates = passing_candidates + rejected_candidates
        return selected, all_candidates
