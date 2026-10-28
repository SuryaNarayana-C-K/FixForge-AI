"""
Patch validation and application package for FixForge.
"""

from .applier import PatchApplier, apply_hunks_to_content
from .validator import PatchValidator, is_protected_file, parse_unified_diff_files

__all__ = [
    "PatchApplier",
    "PatchValidator",
    "apply_hunks_to_content",
    "is_protected_file",
    "parse_unified_diff_files",
]
