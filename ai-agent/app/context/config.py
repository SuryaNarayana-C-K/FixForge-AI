"""
Configuration and budget limits for AI context assembly.
Prevents unbounded token explosion or overwhelming LLMs with large repository files.
"""

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class ContextBudget:
    max_context_files: int = int(os.getenv("MAX_CONTEXT_FILES", "5"))
    max_file_size: int = int(os.getenv("MAX_FILE_SIZE", "51200"))  # 50 KB
    max_context_chars: int = int(os.getenv("MAX_CONTEXT_CHARS", "16000"))
    max_traceback_size: int = int(os.getenv("MAX_TRACEBACK_SIZE", "4000"))
    max_test_output_size: int = int(os.getenv("MAX_TEST_OUTPUT_SIZE", "8000"))


DEFAULT_BUDGET = ContextBudget()
