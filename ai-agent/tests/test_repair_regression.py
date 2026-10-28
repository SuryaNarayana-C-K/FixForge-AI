"""
Regression tests for automatic issue repair, provider integrity, and verification policy.
"""

import asyncio
import pytest

from app.providers.gemini import GeminiProvider
from app.verification.policy import VerificationPolicy


def test_gemini_provider_has_asyncio_module():
    """Ensure gemini.py has asyncio imported and can execute sleep without NameError."""
    import app.providers.gemini as gemini_mod
    assert hasattr(gemini_mod, "asyncio"), "gemini.py must import asyncio"

    async def _test_sleep():
        await gemini_mod.asyncio.sleep(0.001)

    asyncio.run(_test_sleep())


def test_verification_policy_rejects_zero_tests():
    """Ensure zero collected/executed tests never pass verification."""
    eval_res = VerificationPolicy.evaluate(
        exec_exit_code=0,
        exec_timed_out=False,
        parse_total=0,
        parse_passed=0,
        parse_failed=0,
        parse_skipped=0,
        parse_errors=0,
        post_failures=[],
        baseline_failures=[],
        stdout="collected 0 items\nno tests ran",
        stderr="",
    )
    assert not eval_res.is_verified
    assert eval_res.status == "NO_TESTS_COLLECTED"


def test_verification_policy_rejects_skipped_only():
    """Ensure suites with only skipped tests never pass verification."""
    eval_res = VerificationPolicy.evaluate(
        exec_exit_code=0,
        exec_timed_out=False,
        parse_total=4,
        parse_passed=0,
        parse_failed=0,
        parse_skipped=4,
        parse_errors=0,
        post_failures=[],
        baseline_failures=[],
        stdout="4 skipped",
        stderr="",
    )
    assert not eval_res.is_verified
    assert eval_res.status == "SKIPPED_ONLY"


def test_verification_policy_rejects_regressions():
    """Ensure regressions are flagged and rejected."""
    eval_res = VerificationPolicy.evaluate(
        exec_exit_code=1,
        exec_timed_out=False,
        parse_total=3,
        parse_passed=2,
        parse_failed=1,
        parse_skipped=0,
        parse_errors=0,
        post_failures=[{"test_name": "test_new_bug"}],
        baseline_failures=[{"test_name": "test_old_bug"}],
        stdout="1 failed, 2 passed",
        stderr="",
    )
    assert not eval_res.is_verified
    assert eval_res.status == "REGRESSION_DETECTED"
    assert eval_res.regression_detected


def test_verification_policy_clean_pass():
    """Ensure clean run with 0 failures and exit code 0 is verified."""
    eval_res = VerificationPolicy.evaluate(
        exec_exit_code=0,
        exec_timed_out=False,
        parse_total=4,
        parse_passed=4,
        parse_failed=0,
        parse_skipped=0,
        parse_errors=0,
        post_failures=[],
        baseline_failures=[{"test_name": "test_old_bug"}],
        stdout="4 passed in 0.2s",
        stderr="",
    )
    assert eval_res.is_verified
    assert eval_res.status in ("PASSED", "VERIFIED")
    assert not eval_res.regression_detected
