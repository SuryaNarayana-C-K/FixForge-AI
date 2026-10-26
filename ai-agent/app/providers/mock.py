"""
Deterministic mock LLM provider for unit tests, offline evaluation, and CI pipelines.
"""

from typing import Any, TypeVar
from pydantic import BaseModel

from app.patch_schemas import (
    GeneratedPatch,
    PatchChange,
    PatchPlan,
    RootCauseAnalysis,
    RootCauseEvidence,
)
from app.providers.base import LLMProvider

T = TypeVar("T", bound=BaseModel)


class MockLLMProvider(LLMProvider):
    """
    Mock provider providing reproducible, deterministic outputs without network calls.
    Supports overrides and scenario modes for Milestone 5 self-correction testing.
    """

    def __init__(
        self,
        override_root_cause: RootCauseAnalysis | None = None,
        override_plan: PatchPlan | None = None,
        override_patch: GeneratedPatch | None = None,
        override_patches_sequence: list[GeneratedPatch] | None = None,
        scenario: str = "default",
    ):
        self.override_root_cause = override_root_cause
        self.override_plan = override_plan
        self.override_patch = override_patch
        self.override_patches_sequence = list(override_patches_sequence) if override_patches_sequence else None
        self.scenario = scenario
        self.last_messages: list[dict[str, str]] = []
        self._patch_call_count = 0

    async def complete(self, messages: list[dict[str, str]], **kwargs: Any) -> str:
        self.last_messages = messages
        return "Mock LLM completion"

    async def generate_structured(
        self,
        messages: list[dict[str, str]],
        response_model: type[T],
        **kwargs: Any,
    ) -> T:
        self.last_messages = messages
        prompt_text = " ".join(m.get("content", "") for m in messages)

        # Check for sequence overrides
        if response_model == GeneratedPatch and self.override_patches_sequence:
            if self._patch_call_count < len(self.override_patches_sequence):
                patch = self.override_patches_sequence[self._patch_call_count]
                self._patch_call_count += 1
                return patch  # type: ignore

        # Check for single overrides
        if response_model == RootCauseAnalysis and self.override_root_cause is not None:
            return self.override_root_cause  # type: ignore

        if response_model == PatchPlan and self.override_plan is not None:
            return self.override_plan  # type: ignore

        if response_model == GeneratedPatch and self.override_patch is not None:
            return self.override_patch  # type: ignore

        is_js = "calculator.js" in prompt_text or "javascript" in prompt_text.lower() or "jest" in prompt_text.lower()

        if response_model == RootCauseAnalysis:
            is_post_patch = "PREVIOUS ATTEMPT" in prompt_text
            summary_text = (
                "Post-patch analysis: previous patch failed to resolve zero divisor issue."
                if is_post_patch
                else "Function divide returns -1 instead of 0 when count is zero."
            )
            src_file = "calculator.js" if is_js else "calculator.py"
            test_file = "tests/calculator.test.js" if is_js else "tests/test_calculator.py"
            evidence_line = 3 if is_js else 4

            return RootCauseAnalysis(
                summary=summary_text,
                failure_type="logic_error",
                root_cause="The zero-division check branch in divide returns -1 instead of the safe default 0.",
                observed="Test expected 0 but divide(12, 0) returned -1.",
                hypothesis="The developer intended safe fallback of 0 for zero divisor, but returned -1.",
                evidence=[
                    RootCauseEvidence(
                        file=src_file,
                        line=evidence_line,
                        reason="Branch handles count == 0 by returning -1.",
                    ),
                    RootCauseEvidence(
                        file=test_file,
                        line=9,
                        reason="Test explicitly asserts divide(12, 0) == 0.",
                    ),
                ],
                confidence=0.92,
            )  # type: ignore

        if response_model == PatchPlan:
            if self.scenario == "requires_review":
                return PatchPlan(
                    objective="Update container environment configuration",
                    files_to_modify=["Dockerfile"],
                    changes=[
                        PatchChange(file="Dockerfile", location="line 1", description="Change base image")
                    ],
                    risks=["Critical security infrastructure file"],
                )  # type: ignore

            src_file = "calculator.js" if is_js else "calculator.py"
            return PatchPlan(
                objective="Fix divide zero-count fallback to return 0",
                files_to_modify=[src_file],
                changes=[
                    PatchChange(
                        file=src_file,
                        location="line 3/4 (divide function)",
                        description="Change return -1 to return 0 when count is 0.",
                    )
                ],
                risks=["None; ensures divide returns 0 on zero divisor as tested."],
            )  # type: ignore

        if response_model == GeneratedPatch:
            self._patch_call_count += 1

            if self.scenario == "requires_review":
                return GeneratedPatch(
                    files=["Dockerfile"],
                    diff="--- a/Dockerfile\n+++ b/Dockerfile\n@@ -1,1 +1,1 @@\n-# base\n+# modified\n",
                    explanation="Modify Dockerfile infrastructure",
                )  # type: ignore

            if is_js:
                diff_text = (
                    "--- a/calculator.js\n"
                    "+++ b/calculator.js\n"
                    "@@ -2,3 +2,3 @@\n"
                    "   if (count === 0) {\n"
                    "-    return -1;\n"
                    "+    return 0;\n"
                    "   }\n"
                )
                return GeneratedPatch(
                    files=["calculator.js"],
                    diff=diff_text,
                    explanation="Update divide() in calculator.js to return 0 when count === 0.",
                )  # type: ignore

            if self.scenario == "regression":
                # Break clamp logic so test_clamp_uses_bounds fails, causing regression!
                diff_text = (
                    "--- a/calculator.py\n"
                    "+++ b/calculator.py\n"
                    "@@ -8,3 +8,3 @@\n"
                    " def clamp(value: float, lower: float = 0, upper: float = 100) -> float:\n"
                    "     if lower > upper:\n"
                    "-        raise ValueError(\"lower bound must not exceed upper bound\")\n"
                    "+        return -999\n"
                    "-    return min(max(value, lower), upper)\n"
                    "+    return -999\n"
                )
                return GeneratedPatch(
                    files=["calculator.py"],
                    diff=diff_text,
                    explanation="Introduces regression in clamp.",
                )  # type: ignore

            if self.scenario == "two_attempts_success":
                # Attempt 1: return 99 (fails verification)
                if "PREVIOUS ATTEMPT" not in prompt_text and self._patch_call_count == 1:
                    diff_text = (
                        "--- a/calculator.py\n"
                        "+++ b/calculator.py\n"
                        "@@ -3,3 +3,3 @@\n"
                        "     if count == 0:\n"
                        "-        return -1\n"
                        "+        return 99\n"
                        "     return total / count\n"
                    )
                    return GeneratedPatch(
                        files=["calculator.py"],
                        diff=diff_text,
                        explanation="Attempt 1: imperfect patch returning 99.",
                    )  # type: ignore
                # Attempt 2: return 0 (succeeds)
                diff_text = (
                    "--- a/calculator.py\n"
                    "+++ b/calculator.py\n"
                    "@@ -3,3 +3,3 @@\n"
                    "     if count == 0:\n"
                    "-        return -1\n"
                    "+        return 0\n"
                    "     return total / count\n"
                )
                return GeneratedPatch(
                    files=["calculator.py"],
                    diff=diff_text,
                    explanation="Attempt 2: verified fix returning 0.",
                )  # type: ignore

            if self.scenario == "all_fail":
                # Always returns an incorrect value 99
                diff_text = (
                    "--- a/calculator.py\n"
                    "+++ b/calculator.py\n"
                    "@@ -3,3 +3,3 @@\n"
                    "     if count == 0:\n"
                    "-        return -1\n"
                    "+        return 99\n"
                    "     return total / count\n"
                )
                return GeneratedPatch(
                    files=["calculator.py"],
                    diff=diff_text,
                    explanation="Persistent failure patch returning 99.",
                )  # type: ignore

            # Default: working patch for divide
            diff_text = (
                "--- a/calculator.py\n"
                "+++ b/calculator.py\n"
                "@@ -3,3 +3,3 @@\n"
                "     if count == 0:\n"
                "-        return -1\n"
                "+        return 0\n"
                "     return total / count\n"
            )
            return GeneratedPatch(
                files=["calculator.py"],
                diff=diff_text,
                explanation="Update divide() to return 0 when count == 0.",
            )  # type: ignore

        return response_model.model_validate({})

