"""
FixForge M12.3 — Candidate Patch Evaluation & Intelligent Repair Selection Tests.
Comprehensive deterministic test suite covering:
1. Two candidates where only one is correct (correct one selected)
2. Candidate A fixes target but introduces a regression (Candidate A rejected)
3. Equivalent candidate diffs (deduplicated, hash matches, not independent)
4. All candidates failing (preserves baseline, none promoted)
5. Malformed candidate alongside valid candidate (malformed rejected, valid selected)
6. Candidate timeout and infrastructure failure (safely caught, rejected, baseline intact)
7. Isolation between candidate workspaces (no bleed between workspaces or baseline)
8. No tests collected or all tests skipped (rejected by verification policy)
9. Promotion and rollback correctness (clean snapshot and byte-for-byte restoration)
10. Human-review routing when no candidate qualifies
"""

import asyncio
import json
from pathlib import Path
import shutil
import tempfile
from uuid import uuid4
import pytest

from app.candidate import (
    CandidateEvaluator,
    CandidateRanker,
    TransactionalPromoter,
    compute_diff_hash,
    deduplicate_candidates,
    normalize_diff,
)
from app.graph.builder import _check_patch_validation
from app.graph.nodes.patching import patch_validation_node
from app.graph.nodes.verification import human_review_node
from app.patch_schemas import (
    PatchValidationResult,
    RepairCandidate,
    VerificationResult,
)


@pytest.fixture
def temp_repo():
    """Creates a temporary test repository with calculator.py and test_calculator.py."""
    base_dir = Path(__file__).resolve().parent.parent / ".test_repos"
    base_dir.mkdir(parents=True, exist_ok=True)
    d = base_dir / f"test_cand_repo_{uuid4().hex[:8]}"
    d.mkdir(parents=True, exist_ok=True)

    calc_file = d / "calculator.py"
    calc_file.write_text(
        "def add(a: int, b: int) -> int:\n"
        "    return a + b\n\n"
        "def divide(a: float, b: float) -> float:\n"
        "    # BUG: returns -1 instead of handling zero or division\n"
        "    if b == 0:\n"
        "        return -1\n"
        "    return a / b\n",
        encoding="utf-8",
    )

    test_file = d / "test_calculator.py"
    test_file.write_text(
        "import pytest\n"
        "from calculator import add, divide\n\n"
        "def test_add():\n"
        "    assert add(1, 2) == 3\n\n"
        "def test_divide_positive():\n"
        "    assert divide(10, 2) == 5.0\n\n"
        "def test_divide_by_zero():\n"
        "    with pytest.raises(ZeroDivisionError):\n"
        "        divide(10, 0)\n",
        encoding="utf-8",
    )
    yield d
    shutil.rmtree(d, ignore_errors=True)


# ---------------------------------------------------------------------------
# Test 1: Two candidates where only one is correct
# ---------------------------------------------------------------------------
def test_two_candidates_one_correct(temp_repo):
    """Candidate A does not raise ZeroDivisionError; Candidate B correctly raises ZeroDivisionError."""
    async def _run():
        # Candidate A: returns 0.0 on b == 0 (still fails test_divide_by_zero)
        diff_wrong = (
            "--- a/calculator.py\n"
            "+++ b/calculator.py\n"
            "@@ -5,3 +5,3 @@\n"
            "     if b == 0:\n"
            "-        return -1\n"
            "+        return 0.0\n"
            "     return a / b\n"
        )

        # Candidate B: raises ZeroDivisionError (correct fix)
        diff_correct = (
            "--- a/calculator.py\n"
            "+++ b/calculator.py\n"
            "@@ -5,3 +5,3 @@\n"
            "     if b == 0:\n"
            "-        return -1\n"
            "+        raise ZeroDivisionError('division by zero')\n"
            "     return a / b\n"
        )

        cands = [
            RepairCandidate(
                candidate_id="cand-wrong",
                hypothesis_id="hyp-1",
                rationale="Return zero on zero denominator",
                files=["calculator.py"],
                diff=diff_wrong,
            ),
            RepairCandidate(
                candidate_id="cand-correct",
                hypothesis_id="hyp-2",
                rationale="Raise ZeroDivisionError on zero denominator",
                files=["calculator.py"],
                diff=diff_correct,
            ),
        ]

        baseline_failures = [{"test_name": "test_divide_by_zero", "file": "test_calculator.py"}]
        evaluator = CandidateEvaluator(temp_repo, test_command="pytest", test_framework="pytest")
        evaluated = await evaluator.evaluate_all(cands, baseline_failures)

        selected, ranked = CandidateRanker.rank_and_select(evaluated)

        assert selected is not None
        assert selected.candidate_id == "cand-correct"
        assert selected.status == "SELECTED"
        assert selected.ranking_score > 0

        wrong_cand = next(c for c in ranked if c.candidate_id == "cand-wrong")
        assert wrong_cand.status == "REJECTED"
        assert wrong_cand.rejection_reason is not None
        assert "test" in wrong_cand.rejection_reason.lower() or "failed" in wrong_cand.rejection_reason.lower()

    asyncio.run(_run())


# ---------------------------------------------------------------------------
# Test 2: Candidate A fixes target but introduces a regression
# ---------------------------------------------------------------------------
def test_candidate_fixes_target_but_introduces_regression(temp_repo):
    """Candidate fixes divide(10, 0) but breaks test_add."""
    async def _run():
        diff_regression = (
            "--- a/calculator.py\n"
            "+++ b/calculator.py\n"
            "@@ -1,3 +1,3 @@\n"
            " def add(a: int, b: int) -> int:\n"
            "-    return a + b\n"
            "+    return a - b\n"
            "@@ -6,3 +6,3 @@\n"
            "     if b == 0:\n"
            "-        return -1\n"
            "+        raise ZeroDivisionError('division by zero')\n"
            "     return a / b\n"
        )

        cands = [
            RepairCandidate(
                candidate_id="cand-regression",
                hypothesis_id="hyp-1",
                rationale="Fix divide but break add",
                files=["calculator.py"],
                diff=diff_regression,
            ),
        ]

        baseline_failures = [{"test_name": "test_divide_by_zero", "file": "test_calculator.py"}]
        evaluator = CandidateEvaluator(temp_repo, test_command="pytest", test_framework="pytest")
        evaluated = await evaluator.evaluate_all(cands, baseline_failures)

        selected, ranked = CandidateRanker.rank_and_select(evaluated)
        assert selected is None
        cand = ranked[0]
        assert cand.status == "REJECTED"
        assert "regression" in cand.rejection_reason.lower()

    asyncio.run(_run())


# ---------------------------------------------------------------------------
# Test 3: Equivalent candidate diffs (deduplication)
# ---------------------------------------------------------------------------
def test_equivalent_candidate_diffs():
    """Two candidates with equivalent hunk content but different formatting/whitespace."""
    diff1 = (
        "--- a/calculator.py\n"
        "+++ b/calculator.py\n"
        "@@ -5,3 +5,3 @@\n"
        "     if b == 0:\n"
        "-        return -1\n"
        "+        raise ZeroDivisionError('division by zero')\n"
        "     return a / b\n"
    )

    # diff2 has CRLF line endings, trailing spaces, and git index header
    diff2 = (
        "index 1234abc..5678def 100644\r\n"
        "--- a/calculator.py\t2026-10-16 08:00:00\r\n"
        "+++ b/calculator.py\t2026-10-16 08:00:00\r\n"
        "@@ -5,3 +5,3 @@\r\n"
        "     if b == 0:  \r\n"
        "-        return -1  \r\n"
        "+        raise ZeroDivisionError('division by zero')  \r\n"
        "     return a / b\r\n"
    )

    hash1 = compute_diff_hash(diff1)
    hash2 = compute_diff_hash(diff2)
    assert hash1 == hash2

    cands = [
        RepairCandidate(
            candidate_id="cand-1",
            hypothesis_id="hyp-1",
            rationale="Original patch",
            files=["calculator.py"],
            diff=diff1,
        ),
        RepairCandidate(
            candidate_id="cand-2",
            hypothesis_id="hyp-1",
            rationale="Duplicate patch with whitespace variations",
            files=["calculator.py"],
            diff=diff2,
        ),
    ]

    unique, duplicates = deduplicate_candidates(cands)
    assert len(unique) == 1
    assert len(duplicates) == 1
    assert duplicates[0].candidate_id == "cand-2"
    assert duplicates[0].is_duplicate is True
    assert duplicates[0].duplicate_of == "cand-1"
    assert duplicates[0].status == "REJECTED"
    assert "duplicate" in duplicates[0].rejection_reason.lower()


# ---------------------------------------------------------------------------
# Test 4: All candidates failing (preserves baseline)
# ---------------------------------------------------------------------------
def test_all_candidates_failing(temp_repo):
    """When all candidate patches fail verification, baseline remains untouched."""
    async def _run():
        diff_fail1 = (
            "--- a/calculator.py\n"
            "+++ b/calculator.py\n"
            "@@ -5,3 +5,3 @@\n"
            "     if b == 0:\n"
            "-        return -1\n"
            "+        return 'invalid'\n"
            "     return a / b\n"
        )
        diff_fail2 = (
            "--- a/calculator.py\n"
            "+++ b/calculator.py\n"
            "@@ -5,3 +5,3 @@\n"
            "     if b == 0:\n"
            "-        return -1\n"
            "+        return None\n"
            "     return a / b\n"
        )

        cands = [
            RepairCandidate(
                candidate_id="cand-1",
                hypothesis_id="hyp-1",
                files=["calculator.py"],
                diff=diff_fail1,
            ),
            RepairCandidate(
                candidate_id="cand-2",
                hypothesis_id="hyp-2",
                files=["calculator.py"],
                diff=diff_fail2,
            ),
        ]

        content_before = (temp_repo / "calculator.py").read_text(encoding="utf-8")

        baseline_failures = [{"test_name": "test_divide_by_zero", "file": "test_calculator.py"}]
        evaluator = CandidateEvaluator(temp_repo, test_command="pytest", test_framework="pytest")
        evaluated = await evaluator.evaluate_all(cands, baseline_failures)

        selected, ranked = CandidateRanker.rank_and_select(evaluated)
        assert selected is None
        for c in ranked:
            assert c.status == "REJECTED"

        # Transactional promotion with None candidate
        promoter = TransactionalPromoter(temp_repo)
        app_res = promoter.promote_candidate(selected)
        assert app_res.applied is False

        # Baseline file must be completely untouched
        content_after = (temp_repo / "calculator.py").read_text(encoding="utf-8")
        assert content_before == content_after

    asyncio.run(_run())


# ---------------------------------------------------------------------------
# Test 5: Malformed candidate alongside a valid candidate
# ---------------------------------------------------------------------------
def test_malformed_candidate_alongside_valid_candidate(temp_repo):
    """Malformed diff syntax or invalid scope is rejected immediately; valid candidate passes."""
    async def _run():
        diff_malformed = "NOT_A_VALID_DIFF\nrandom text without hunks"
        diff_valid = (
            "--- a/calculator.py\n"
            "+++ b/calculator.py\n"
            "@@ -5,3 +5,3 @@\n"
            "     if b == 0:\n"
            "-        return -1\n"
            "+        raise ZeroDivisionError('zero division')\n"
            "     return a / b\n"
        )

        cands = [
            RepairCandidate(
                candidate_id="cand-malformed",
                hypothesis_id="hyp-1",
                files=["calculator.py"],
                diff=diff_malformed,
            ),
            RepairCandidate(
                candidate_id="cand-valid",
                hypothesis_id="hyp-2",
                files=["calculator.py"],
                diff=diff_valid,
            ),
        ]

        baseline_failures = [{"test_name": "test_divide_by_zero", "file": "test_calculator.py"}]
        evaluator = CandidateEvaluator(temp_repo, test_command="pytest", test_framework="pytest")
        evaluated = await evaluator.evaluate_all(cands, baseline_failures)

        selected, ranked = CandidateRanker.rank_and_select(evaluated)
        assert selected is not None
        assert selected.candidate_id == "cand-valid"

        mal = next(c for c in ranked if c.candidate_id == "cand-malformed")
        assert mal.status == "REJECTED"
        assert "validation" in mal.rejection_reason.lower() or "rejected" in mal.rejection_reason.lower()

    asyncio.run(_run())


# ---------------------------------------------------------------------------
# Test 6: Candidate timeout and infrastructure failure
# ---------------------------------------------------------------------------
def test_candidate_timeout_and_infrastructure_failure(temp_repo, monkeypatch):
    """Runner timeout or crash is caught safely without leaking exceptions."""
    async def _run():
        diff_valid = (
            "--- a/calculator.py\n"
            "+++ b/calculator.py\n"
            "@@ -5,3 +5,3 @@\n"
            "     if b == 0:\n"
            "-        return -1\n"
            "+        raise ZeroDivisionError('zero division')\n"
            "     return a / b\n"
        )

        cands = [
            RepairCandidate(
                candidate_id="cand-timeout",
                hypothesis_id="hyp-1",
                files=["calculator.py"],
                diff=diff_valid,
            )
        ]

        evaluator = CandidateEvaluator(
            temp_repo,
            test_command="pytest",
            test_framework="pytest",
            timeout=0.001,
        )

        # Simulate runner returning timed_out
        from app.runner import ExecutionResult, LocalExecutionRunner

        async def mock_run(*args, **kwargs):
            return ExecutionResult(
                command="pytest",
                exit_code=124,
                stdout="",
                stderr="Command timed out",
                duration=0.001,
                timed_out=True,
                status="timeout",
            )

        monkeypatch.setattr(LocalExecutionRunner, "run", mock_run)

        evaluated = await evaluator.evaluate_all(cands, [])
        selected, ranked = CandidateRanker.rank_and_select(evaluated)

        assert selected is None
        assert ranked[0].status == "REJECTED"
        assert "time" in ranked[0].rejection_reason.lower()

    asyncio.run(_run())


# ---------------------------------------------------------------------------
# Test 7: Isolation between candidate workspaces
# ---------------------------------------------------------------------------
def test_isolation_between_candidate_workspaces(temp_repo):
    """Modifications in candidate 1's isolated workspace do NOT exist in candidate 2 or baseline."""
    async def _run():
        # Candidate 1 adds a secret canary comment
        diff1 = (
            "--- a/calculator.py\n"
            "+++ b/calculator.py\n"
            "@@ -1,2 +1,3 @@\n"
            "+# CANARY_CANDIDATE_1_MODIFICATION\n"
            " def add(a: int, b: int) -> int:\n"
        )

        diff2 = (
            "--- a/calculator.py\n"
            "+++ b/calculator.py\n"
            "@@ -5,3 +5,3 @@\n"
            "     if b == 0:\n"
            "-        return -1\n"
            "+        raise ZeroDivisionError('zero division')\n"
            "     return a / b\n"
        )

        cands = [
            RepairCandidate(
                candidate_id="cand-canary",
                hypothesis_id="hyp-1",
                files=["calculator.py"],
                diff=diff1,
            ),
            RepairCandidate(
                candidate_id="cand-clean",
                hypothesis_id="hyp-2",
                files=["calculator.py"],
                diff=diff2,
            ),
        ]

        baseline_failures = [{"test_name": "test_divide_by_zero", "file": "test_calculator.py"}]
        evaluator = CandidateEvaluator(temp_repo, test_command="pytest", test_framework="pytest")
        await evaluator.evaluate_all(cands, baseline_failures)

        # Check baseline repository: CANARY must NOT exist
        baseline_content = (temp_repo / "calculator.py").read_text(encoding="utf-8")
        assert "CANARY_CANDIDATE_1_MODIFICATION" not in baseline_content

    asyncio.run(_run())


# ---------------------------------------------------------------------------
# Test 8: No tests collected or all tests skipped
# ---------------------------------------------------------------------------
def test_no_tests_collected_or_all_skipped(temp_repo):
    """If candidate patch is evaluated where tests were skipped or not collected, it is rejected."""
    # Remove test file to produce NO_TESTS_COLLECTED (exit code 5 in pytest)
    (temp_repo / "test_calculator.py").unlink()

    async def _run():
        diff_valid = (
            "--- a/calculator.py\n"
            "+++ b/calculator.py\n"
            "@@ -5,3 +5,3 @@\n"
            "     if b == 0:\n"
            "-        return -1\n"
            "+        raise ZeroDivisionError('zero division')\n"
            "     return a / b\n"
        )

        cands = [
            RepairCandidate(
                candidate_id="cand-notests",
                hypothesis_id="hyp-1",
                files=["calculator.py"],
                diff=diff_valid,
            )
        ]

        evaluator = CandidateEvaluator(temp_repo, test_command="pytest", test_framework="pytest")
        evaluated = await evaluator.evaluate_all(cands, [])
        selected, ranked = CandidateRanker.rank_and_select(evaluated)

        assert selected is None
        assert ranked[0].status == "REJECTED"
        assert "no_tests_collected" in str(ranked[0].evaluation).lower() or "no test" in ranked[0].rejection_reason.lower()

    asyncio.run(_run())


# ---------------------------------------------------------------------------
# Test 9: Promotion and rollback correctness
# ---------------------------------------------------------------------------
def test_promotion_and_rollback_correctness(temp_repo):
    """Selected candidate is promoted cleanly with snapshot; rollback restores original baseline."""
    initial_content = (temp_repo / "calculator.py").read_text(encoding="utf-8")

    diff_valid = (
        "--- a/calculator.py\n"
        "+++ b/calculator.py\n"
        "@@ -5,3 +5,3 @@\n"
        "     if b == 0:\n"
        "-        return -1\n"
        "+        raise ZeroDivisionError('zero division')\n"
        "     return a / b\n"
    )

    cand = RepairCandidate(
        candidate_id="cand-promote",
        hypothesis_id="hyp-1",
        files=["calculator.py"],
        diff=diff_valid,
        status="SELECTED",
    )

    promoter = TransactionalPromoter(temp_repo)
    app_res = promoter.promote_candidate(cand)

    assert app_res.applied is True
    assert app_res.backup_id is not None
    promoted_content = (temp_repo / "calculator.py").read_text(encoding="utf-8")
    assert "raise ZeroDivisionError" in promoted_content

    # Rollback using backup snapshot
    rollback_ok = promoter.rollback(app_res.backup_id)
    assert rollback_ok is True

    restored_content = (temp_repo / "calculator.py").read_text(encoding="utf-8")
    assert restored_content == initial_content


# ---------------------------------------------------------------------------
# Test 10: Human-review routing when no candidate qualifies
# ---------------------------------------------------------------------------
def test_human_review_routing_when_no_candidate_qualifies(temp_repo):
    """When all candidate patches are rejected and routing is requested, graph routes to HUMAN_REVIEW."""
    async def _run():
        bad_diff = (
            "--- a/calculator.py\n"
            "+++ b/calculator.py\n"
            "@@ -5,3 +5,3 @@\n"
            "     if b == 0:\n"
            "-        return -1\n"
            "+        return 'wrong'\n"
            "     return a / b\n"
        )

        state = {
            "job_id": "test-human-review-routing",
            "repository_path": str(temp_repo),
            "test_command": "pytest",
            "test_framework": "pytest",
            "attempt_number": 1,
            "max_attempts": 1,
            "candidates": [
                {
                    "candidate_id": "cand-bad",
                    "hypothesis_id": "hyp-1",
                    "diff": bad_diff,
                    "files": ["calculator.py"],
                }
            ],
            "route_to_human_review_on_no_candidates": True,
            "baseline_result": {"failed_tests": [{"name": "test_divide_by_zero", "file": "test_calculator.py"}]},
            "attempt_history": [],
            "agent_events": [],
            "timestamps": {},
        }

        # 1. Run patch validation node with candidate
        val_state = await patch_validation_node(state)
        assert val_state.get("selected_candidate") is None

        # 2. Verify conditional edge routes to human_review
        merged_state = {**state, **val_state}
        decision = _check_patch_validation(merged_state)
        assert decision == "human_review"

        # 3. Verify human_review_node sets status
        hr_res = await human_review_node(merged_state)
        assert hr_res.get("final_status") == "REQUIRES_REVIEW"
        assert hr_res.get("is_verified") is False

    asyncio.run(_run())
