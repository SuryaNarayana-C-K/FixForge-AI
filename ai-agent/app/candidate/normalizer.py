"""
Diff normalization and deduplication service for FixForge M12.3.
Deduplicates equivalent patches before execution, ensuring identical diff hunks
are never falsely claimed as independent candidates.
"""

import hashlib
import re
from typing import Any

from app.patch_schemas import RepairCandidate


def normalize_diff(diff_str: str) -> str:
    """
    Normalizes a unified diff string so that functionally equivalent patches
    produce the exact same hash:
    1. Normalizes line endings (\r\n -> \n)
    2. Strips trailing whitespace on all lines
    3. Strips variable timestamp or index metadata lines (e.g. 'index abc..def 100644' or file timestamps)
    4. Strips leading/trailing empty lines
    """
    if not diff_str or not diff_str.strip():
        return ""

    raw_lines = diff_str.replace("\r\n", "\n").replace("\r", "\n").splitlines()
    normalized_lines: list[str] = []

    for line in raw_lines:
        trimmed = line.rstrip()
        # Skip git metadata lines that do not affect the hunk content
        if trimmed.startswith("index ") and re.match(r"^index [0-9a-fA-F]+\.\.[0-9a-fA-F]+", trimmed):
            continue
        if trimmed.startswith("similarity index") or trimmed.startswith("dissimilarity index"):
            continue

        # Strip variable timestamp comments on file headers:
        # e.g., '--- a/calc.py  2026-10-16 08:00:00' -> '--- a/calc.py'
        if trimmed.startswith("--- ") or trimmed.startswith("+++ "):
            parts = trimmed.split("\t")
            if len(parts) > 1:
                trimmed = parts[0]
            else:
                space_parts = trimmed.split()
                if len(space_parts) > 2 and space_parts[0] in ("---", "+++"):
                    trimmed = f"{space_parts[0]} {space_parts[1]}"

        normalized_lines.append(trimmed)

    # Join and strip excess empty lines at start and end
    joined = "\n".join(normalized_lines).strip()
    return joined


def compute_diff_hash(diff_str: str) -> str:
    """Computes a SHA-256 hex digest of the normalized unified diff."""
    norm = normalize_diff(diff_str)
    if not norm:
        return ""
    return hashlib.sha256(norm.encode("utf-8")).hexdigest()


def deduplicate_candidates(
    candidates: list[RepairCandidate],
) -> tuple[list[RepairCandidate], list[RepairCandidate]]:
    """
    Inspects candidate patches, computes stable diff hashes, and flags duplicate
    patches before execution.

    Returns:
        (unique_candidates_to_evaluate, duplicate_candidates_rejected)
    """
    seen_hashes: dict[str, str] = {}  # diff_hash -> first_candidate_id
    unique_candidates: list[RepairCandidate] = []
    duplicate_candidates: list[RepairCandidate] = []

    for cand in candidates:
        diff_h = compute_diff_hash(cand.diff)
        cand.diff_hash = diff_h

        if not diff_h:
            # Empty diff
            cand.status = "REJECTED"
            cand.rejection_reason = "Empty patch diff."
            unique_candidates.append(cand)
            continue

        if diff_h in seen_hashes:
            orig_id = seen_hashes[diff_h]
            cand.is_duplicate = True
            cand.duplicate_of = orig_id
            cand.status = "REJECTED"
            cand.rejection_reason = f"Duplicate patch: diff is equivalent to candidate {orig_id}"
            duplicate_candidates.append(cand)
        else:
            seen_hashes[diff_h] = cand.candidate_id
            unique_candidates.append(cand)

    return unique_candidates, duplicate_candidates
