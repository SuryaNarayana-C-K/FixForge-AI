"""
FixForge M12.3 Candidate Patch Evaluation & Intelligent Repair Selection module.
"""

from app.candidate.evaluator import CandidateEvaluator, create_disposable_workspace, cleanup_disposable_workspace
from app.candidate.normalizer import compute_diff_hash, deduplicate_candidates, normalize_diff
from app.candidate.promoter import TransactionalPromoter
from app.candidate.ranker import CandidateRanker

__all__ = [
    "CandidateEvaluator",
    "CandidateRanker",
    "TransactionalPromoter",
    "cleanup_disposable_workspace",
    "compute_diff_hash",
    "create_disposable_workspace",
    "deduplicate_candidates",
    "normalize_diff",
]
