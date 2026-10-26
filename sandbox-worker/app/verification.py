"""
Verification policy evaluator for FixForge Sandbox Worker.
Enforces that skipped or unexecuted tests can NEVER produce VERIFIED status.
"""

import re
from typing import Any
from .schemas import VerificationSummary


def parse_pytest_output(stdout: str, stderr: str) -> dict[str, int]:
    """Extract test counts from pytest stdout."""
    combined = f"{stdout}\n{stderr}"

    passed = 0
    failed = 0
    skipped = 0
    errors = 0

    # Look for summary lines like:
    # "== 4 passed, 1 failed, 2 skipped, 1 error in 0.5s =="
    # or "== 2 passed in 0.12s =="
    summary_match = re.search(
        r"==+.*?([\d]+\s+passed|[\d]+\s+failed|[\d]+\s+skipped|[\d]+\s+error).*?==+",
        combined,
        re.IGNORECASE,
    )
    if summary_match:
        line = summary_match.group(0)
        p_m = re.search(r"(\d+)\s+passed", line)
        f_m = re.search(r"(\d+)\s+failed", line)
        s_m = re.search(r"(\d+)\s+skipped", line)
        e_m = re.search(r"(\d+)\s+error", line)

        if p_m:
            passed = int(p_m.group(1))
        if f_m:
            failed = int(f_m.group(1))
        if s_m:
            skipped = int(s_m.group(1))
        if e_m:
            errors = int(e_m.group(1))

    total = passed + failed + skipped + errors
    return {
        "passed": passed,
        "failed": failed,
        "skipped": skipped,
        "errors": errors,
        "total": total,
    }


def evaluate_verification(
    exit_code: int,
    timed_out: bool,
    cancelled: bool,
    stdout: str,
    stderr: str,
) -> VerificationSummary:
    """
    Evaluate verification status based on deterministic criteria.
    Critical Invariant: Skipped or unexecuted tests CANNOT produce VERIFIED status.
    """
    if cancelled:
        return VerificationSummary(
            is_verified=False,
            status="CANCELLED",
            reason="Job execution was cancelled by request.",
        )

    if timed_out:
        return VerificationSummary(
            is_verified=False,
            status="TIMEOUT",
            reason="Execution timed out before completion.",
        )

    counts = parse_pytest_output(stdout, stderr)
    total = counts["total"]
    passed = counts["passed"]
    failed = counts["failed"]
    skipped = counts["skipped"]
    errors = counts["errors"]
    executed = total - skipped

    # Case 1: Execution error before tests collected
    if exit_code != 0 and total == 0:
        return VerificationSummary(
            is_verified=False,
            status="EXECUTION_ERROR",
            reason=f"Test runner exited with non-zero code {exit_code} before collecting tests.",
            total=total,
            passed=passed,
            failed=max(1, failed),
            skipped=skipped,
            executed=0,
            errors=max(1, errors),
        )

    # Case 2: Zero test cases collected
    if total == 0:
        return VerificationSummary(
            is_verified=False,
            status="NO_TESTS_COLLECTED",
            reason="Zero test cases were collected by the test runner.",
            total=0,
            passed=0,
            failed=0,
            skipped=0,
            executed=0,
            errors=errors,
        )

    # Case 3: All tests skipped or deselected (no tests executed)
    if executed <= 0 or skipped == total:
        return VerificationSummary(
            is_verified=False,
            status="SKIPPED_ONLY",
            reason=f"All {total} test(s) were skipped or deselected. Unexecuted tests cannot produce VERIFIED.",
            total=total,
            passed=passed,
            failed=failed,
            skipped=skipped,
            executed=0,
            errors=errors,
        )

    # Case 4: Test failures or errors present
    if failed > 0 or errors > 0 or exit_code != 0:
        return VerificationSummary(
            is_verified=False,
            status="FAILED",
            reason=f"Test failures detected: {failed} failed, {errors} errors (exit code {exit_code}).",
            total=total,
            passed=passed,
            failed=failed,
            skipped=skipped,
            executed=executed,
            errors=errors,
        )

    # Case 5: Real tests executed, all passed, 0 failures, 0 errors, exit_code 0
    return VerificationSummary(
        is_verified=True,
        status="VERIFIED",
        reason=f"All {passed} executed test(s) passed cleanly without errors.",
        total=total,
        passed=passed,
        failed=0,
        skipped=skipped,
        executed=executed,
        errors=0,
    )
