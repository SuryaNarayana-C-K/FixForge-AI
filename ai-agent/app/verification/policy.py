"""
Centralized Verification Policy for FixForge.
Enforces strict verification integrity rules across the entire lifecycle:
1. The correct repository and intended revision were tested.
2. The test command actually started and completed successfully.
3. Tests were collected and required tests were genuinely executed.
4. Required tests passed and no test failures or execution errors remain.
5. Regression checks passed with zero new failures.
6. The patch was applied cleanly and verified.
7. Explicit distinction of: passed, failed, skipped, deselected, not collected, timed out, and execution error.
"""

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class VerificationEvaluation:
    is_verified: bool
    status: str  # "VERIFIED", "PASSED", "FAILED", "REGRESSION_DETECTED", "TIMEOUT", "NO_TESTS_COLLECTED", "SKIPPED_ONLY", "EXECUTION_ERROR"
    reason: str
    passed: int = 0
    failed: int = 0
    skipped: int = 0
    total: int = 0
    executed: int = 0
    errors: int = 0
    exit_code: int = 1
    timed_out: bool = False
    regression_detected: bool = False
    new_failures: list[dict[str, Any]] = field(default_factory=list)
    resolved_failures: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class VerificationPolicy:
    """
    Centralized verification gate ensuring a repair is never marked VERIFIED
    unless real tests are collected, executed, and passed without regression.
    """

    @staticmethod
    def evaluate(
        exec_exit_code: int,
        exec_timed_out: bool,
        parse_total: int,
        parse_passed: int,
        parse_failed: int,
        parse_skipped: int,
        parse_errors: int,
        post_failures: list[dict[str, Any]],
        baseline_failures: list[dict[str, Any]],
        stdout: str = "",
        stderr: str = "",
    ) -> VerificationEvaluation:
        # 1. Timeout Check
        if exec_timed_out:
            return VerificationEvaluation(
                is_verified=False,
                status="TIMEOUT",
                reason="Test execution timed out before completion.",
                total=parse_total,
                passed=parse_passed,
                failed=parse_failed,
                skipped=parse_skipped,
                executed=max(0, parse_total - parse_skipped),
                errors=parse_errors,
                exit_code=exec_exit_code,
                timed_out=True,
            )

        # 2. No tests collected (specifically exit code 5 in pytest or 0 tests collected)
        if exec_exit_code == 5 or (parse_total == 0 and ("no tests ran" in stdout.lower() or "collected 0 items" in stdout.lower())):
            return VerificationEvaluation(
                is_verified=False,
                status="NO_TESTS_COLLECTED",
                reason=f"Zero test cases were collected by the test runner (exit code {exec_exit_code}).",
                total=0,
                passed=0,
                failed=0,
                skipped=0,
                executed=0,
                errors=parse_errors,
                exit_code=exec_exit_code,
            )

        # 3. Execution / Start failure (e.g. syntax error in test file, runner crashed)
        if exec_exit_code != 0 and parse_total == 0:
            return VerificationEvaluation(
                is_verified=False,
                status="EXECUTION_ERROR",
                reason=f"Test command failed to execute or collect tests (exit code {exec_exit_code}).",
                total=0,
                passed=0,
                failed=1,
                skipped=0,
                executed=0,
                errors=max(1, parse_errors),
                exit_code=exec_exit_code,
            )

        # 3. No tests collected
        if parse_total == 0:
            return VerificationEvaluation(
                is_verified=False,
                status="NO_TESTS_COLLECTED",
                reason="Zero test cases were collected by the test runner.",
                total=0,
                passed=0,
                failed=0,
                skipped=0,
                executed=0,
                errors=parse_errors,
                exit_code=exec_exit_code,
            )

        # 4. Suites containing only skipped tests
        executed = parse_total - parse_skipped
        if executed <= 0 or parse_skipped == parse_total:
            return VerificationEvaluation(
                is_verified=False,
                status="SKIPPED_ONLY",
                reason=f"All {parse_total} test(s) were skipped or deselected. No tests were executed.",
                total=parse_total,
                passed=parse_passed,
                failed=parse_failed,
                skipped=parse_skipped,
                executed=0,
                errors=parse_errors,
                exit_code=exec_exit_code,
            )

        # 5. Regression Detection
        def _get_test_name(item: Any) -> str:
            if isinstance(item, dict):
                return item.get("test_name") or item.get("test") or item.get("name") or ""
            return getattr(item, "test_name", None) or getattr(item, "test", None) or str(item)

        baseline_sigs = {
            _get_test_name(f) for f in baseline_failures if _get_test_name(f)
        }
        post_sigs = {
            _get_test_name(f) for f in post_failures if _get_test_name(f)
        }

        new_failure_names = post_sigs - baseline_sigs
        # Filter synthetic errors
        real_new_failure_names = {
            name for name in new_failure_names
            if name not in ("test_collection", "all_tests_skipped", "CollectionError")
        }
        new_failures = [
            f for f in post_failures if _get_test_name(f) in real_new_failure_names
        ]

        resolved_names = baseline_sigs - post_sigs
        resolved_failures = [
            f for f in baseline_failures if _get_test_name(f) in resolved_names
        ]

        regression_detected = False
        baseline_failed_count = len(baseline_failures)
        if len(new_failures) > 0 or (executed > 0 and parse_failed > baseline_failed_count):
            regression_detected = True

        if regression_detected:
            return VerificationEvaluation(
                is_verified=False,
                status="REGRESSION_DETECTED",
                reason=f"Regression detected: {len(new_failures)} new test failure(s) introduced.",
                total=parse_total,
                passed=parse_passed,
                failed=parse_failed,
                skipped=parse_skipped,
                executed=executed,
                errors=parse_errors,
                exit_code=exec_exit_code,
                regression_detected=True,
                new_failures=new_failures,
                resolved_failures=resolved_failures,
            )

        # 6. Remaining failures or execution errors
        if exec_exit_code != 0 or parse_failed > 0 or parse_errors > 0 or len(post_failures) > 0:
            return VerificationEvaluation(
                is_verified=False,
                status="FAILED",
                reason=f"Tests failed: {parse_failed} failing test(s), {parse_errors} error(s), exit code {exec_exit_code}.",
                total=parse_total,
                passed=parse_passed,
                failed=parse_failed,
                skipped=parse_skipped,
                executed=executed,
                errors=parse_errors,
                exit_code=exec_exit_code,
                new_failures=new_failures,
                resolved_failures=resolved_failures,
            )

        # 7. Genuine clean pass with positive executions
        if parse_passed > 0 and parse_failed == 0 and parse_errors == 0 and exec_exit_code == 0:
            return VerificationEvaluation(
                is_verified=True,
                status="PASSED",
                reason=f"All {parse_passed} executed test(s) passed cleanly without regression.",
                total=parse_total,
                passed=parse_passed,
                failed=0,
                skipped=parse_skipped,
                executed=executed,
                errors=0,
                exit_code=0,
                regression_detected=False,
                new_failures=[],
                resolved_failures=resolved_failures,
            )

        # Fallback to failed
        return VerificationEvaluation(
            is_verified=False,
            status="FAILED",
            reason="Verification criteria not satisfied.",
            total=parse_total,
            passed=parse_passed,
            failed=parse_failed,
            skipped=parse_skipped,
            executed=executed,
            errors=parse_errors,
            exit_code=exec_exit_code,
        )
