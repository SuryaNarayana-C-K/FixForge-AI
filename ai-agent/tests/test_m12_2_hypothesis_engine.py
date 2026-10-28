"""
FixForge M12.2 — Multi-Hypothesis Diagnosis & Evidence-Ranked Repair Selection Test Suite.
Tests hypothesis schema validation, evidence grounding, deterministic ranking,
abstention gates, candidate evaluation, duplicate candidate rejection, and benchmark metrics.
"""

from pathlib import Path
import pytest
from unittest.mock import AsyncMock, patch

from app.benchmark.metrics import compute_benchmark_metrics
from app.benchmark.models import BenchmarkCaseResult
from app.graph.builder import _check_root_cause_outcome
from app.graph.nodes.root_cause import root_cause_analysis_node
from app.hypothesis.ranker import HypothesisRanker, rank_hypotheses
from app.patch_schemas import (
    DiagnosisHypothesis,
    GeneratedPatch,
    PatchValidationResult,
    RepairCandidate,
    RootCauseAnalysis,
)


@pytest.fixture
def sample_repo(tmp_path: Path):
    """Creates a temporary repository structure for deterministic ranking tests."""
    calc_py = tmp_path / "calc.py"
    calc_py.write_text(
        "def add(a, b):\n    return a - b\n\ndef multiply(a, b):\n    return a * b\n",
        encoding="utf-8",
    )
    test_calc_py = tmp_path / "test_calc.py"
    test_calc_py.write_text(
        "from calc import add\ndef test_add():\n    assert add(2, 3) == 5\n",
        encoding="utf-8",
    )
    return tmp_path


# 1. Hypothesis Schema Validation
def test_hypothesis_schema_instantiation():
    hyp = DiagnosisHypothesis(
        hypothesis_id="hyp-1",
        root_cause_statement="Inverted sign in add function",
        relevant_files=["calc.py:2"],
        supporting_evidence=["test_add failed: -1 != 5"],
        observed_behavior="Returned -1",
        expected_behavior="Return 5",
        causal_explanation="add() subtracts b from a instead of adding",
        confidence_score=0.90,
        missing_evidence_or_assumptions=[],
        proposed_repair_strategy="Change '-' to '+' in calc.py",
    )
    assert hyp.hypothesis_id == "hyp-1"
    assert hyp.confidence_score == 0.90
    assert hyp.rank is None
    assert hyp.ranking_score is None


def test_repair_candidate_schema():
    cand = RepairCandidate(
        candidate_id="cand-1",
        hypothesis_id="hyp-1",
        rationale="Fix subtraction in add",
        files=["calc.py"],
        diff="--- a/calc.py\n+++ b/calc.py\n@@ -2,1 +2,1 @@\n-    return a - b\n+    return a + b\n",
        status="PENDING",
    )
    assert cand.candidate_id == "cand-1"
    assert cand.status == "PENDING"
    assert cand.validation is None


# 2. Evidence Grounding & File Existence
def test_ranker_penalizes_hallucinated_files(sample_repo: Path):
    ranker = HypothesisRanker(sample_repo)
    valid_hyp = DiagnosisHypothesis(
        hypothesis_id="hyp-1",
        root_cause_statement="Bug in calc.py",
        relevant_files=["calc.py:2"],
        supporting_evidence=["test_add"],
        observed_behavior="-1",
        expected_behavior="5",
        causal_explanation="Logic error",
        confidence_score=0.8,
    )
    hallucinated_hyp = DiagnosisHypothesis(
        hypothesis_id="hyp-2",
        root_cause_statement="Bug in non_existent_module.py",
        relevant_files=["non_existent_module.py:50"],
        supporting_evidence=["test_add"],
        observed_behavior="-1",
        expected_behavior="5",
        causal_explanation="Imaginary module bug",
        confidence_score=0.8,
    )
    failures = [{"test_name": "test_add", "message": "assert -1 == 5", "traceback": 'File "calc.py", line 2'}]
    ranked = ranker.rank([hallucinated_hyp, valid_hyp], failures)

    assert ranked[0].hypothesis_id == "hyp-1"
    assert ranked[0].rank == 1
    assert ranked[1].hypothesis_id == "hyp-2"
    assert ranked[1].rank == 2
    assert ranked[0].ranking_score > ranked[1].ranking_score


# 3. Deterministic Ranking Criteria & Tie-Breaking
def test_ranker_traceback_alignment_and_determinism(sample_repo: Path):
    ranker = HypothesisRanker(sample_repo)
    failures = [
        {
            "test_name": "test_add",
            "message": "assert add(2, 3) == 5",
            "traceback": 'File "calc.py", line 2, in add\n    assert add(2, 3) == 5',
        }
    ]

    h1 = DiagnosisHypothesis(
        hypothesis_id="hyp-1",
        root_cause_statement="Matches traceback line exactly",
        relevant_files=["calc.py:2"],
        supporting_evidence=["test_add"],
        observed_behavior="-1",
        expected_behavior="5",
        causal_explanation="add() subtracts",
        confidence_score=0.85,
    )
    h2 = DiagnosisHypothesis(
        hypothesis_id="hyp-2",
        root_cause_statement="No line specified",
        relevant_files=["calc.py"],
        supporting_evidence=["test_add"],
        observed_behavior="-1",
        expected_behavior="5",
        causal_explanation="calc error",
        confidence_score=0.85,
    )

    ranked_run1 = ranker.rank([h2, h1], failures)
    ranked_run2 = ranker.rank([h1, h2], failures)

    # Determinism: exact same ordering regardless of initial list order
    assert [h.hypothesis_id for h in ranked_run1] == ["hyp-1", "hyp-2"]
    assert [h.hypothesis_id for h in ranked_run2] == ["hyp-1", "hyp-2"]
    assert ranked_run1[0].ranking_score > ranked_run1[1].ranking_score


# 4. Protected Test File Penalty
def test_ranker_disqualifies_modifying_tests(sample_repo: Path):
    ranker = HypothesisRanker(sample_repo)
    failures = [{"test_name": "test_add", "traceback": "calc.py"}]

    safe_hyp = DiagnosisHypothesis(
        hypothesis_id="hyp-safe",
        root_cause_statement="Fix calc.py",
        relevant_files=["calc.py:2"],
        supporting_evidence=["test_add"],
        observed_behavior="-1",
        expected_behavior="5",
        causal_explanation="Fix calculation",
        confidence_score=0.8,
    )
    illegal_hyp = DiagnosisHypothesis(
        hypothesis_id="hyp-illegal",
        root_cause_statement="Change test assertion",
        relevant_files=["test_calc.py:3"],
        supporting_evidence=["test_add"],
        observed_behavior="-1",
        expected_behavior="-1",
        causal_explanation="Relax test",
        confidence_score=0.99,
    )

    ranked = ranker.rank([illegal_hyp, safe_hyp], failures)
    assert ranked[0].hypothesis_id == "hyp-safe"
    assert any("CRITICAL: Hypothesis targets protected test files" in r for r in ranked[1].ranking_reasons)


# 5. Multi-Failure Shared Defect Bonus
def test_ranker_multi_failure_bonus(sample_repo: Path):
    ranker = HypothesisRanker(sample_repo)
    failures = [
        {"test_name": "test_first", "traceback": "calc.py"},
        {"test_name": "test_second", "traceback": "calc.py"},
        {"test_name": "test_third", "traceback": "calc.py"},
    ]

    single_hyp = DiagnosisHypothesis(
        hypothesis_id="hyp-single",
        root_cause_statement="Only explains test_first",
        relevant_files=["calc.py:2"],
        supporting_evidence=["test_first"],
        observed_behavior="Fail",
        expected_behavior="Pass",
        causal_explanation="Single bug",
        confidence_score=0.8,
    )
    shared_hyp = DiagnosisHypothesis(
        hypothesis_id="hyp-shared",
        root_cause_statement="Explains test_first, test_second, test_third",
        relevant_files=["calc.py:2"],
        supporting_evidence=["test_first", "test_second", "test_third"],
        observed_behavior="Fails all 3",
        expected_behavior="Passes all 3",
        causal_explanation="Shared defect",
        confidence_score=0.8,
    )

    ranked = ranker.rank([single_hyp, shared_hyp], failures)
    assert ranked[0].hypothesis_id == "hyp-shared"
    assert any("Explains multiple interacting/shared failures" in r for r in ranked[0].ranking_reasons)


# 6. Abstention Gate Detection
def test_abstention_conditional_edge_routing():
    # Abstention recommended -> routes to HUMAN_REVIEW
    state_abstain = {"abstention": True}
    assert _check_root_cause_outcome(state_abstain) == "human_review"

    # Confident diagnosis -> routes to PATCH_PLANNING
    state_proceed = {"abstention": False}
    assert _check_root_cause_outcome(state_proceed) == "patch_planning"


# 7. Root Cause Analysis Node Integration with Multi-Hypothesis
def test_root_cause_node_multi_hypothesis_integration(sample_repo: Path):
    import asyncio
    mock_llm = AsyncMock()
    mock_llm.generate_structured.return_value = RootCauseAnalysis(
        summary="Potential defect in add function",
        failure_type="logic_error",
        root_cause="Signs reversed",
        observed="-1",
        hypothesis="add() subtracts",
        confidence=0.85,
        evidence=[],
        hypotheses=[
            DiagnosisHypothesis(
                hypothesis_id="hyp-1",
                root_cause_statement="Inverted sign in calc.py",
                relevant_files=["calc.py:2"],
                supporting_evidence=["test_add"],
                observed_behavior="-1",
                expected_behavior="5",
                causal_explanation="add subtracts",
                confidence_score=0.90,
            ),
            DiagnosisHypothesis(
                hypothesis_id="hyp-2",
                root_cause_statement="Caller passes negative arguments",
                relevant_files=["test_calc.py:2"],
                supporting_evidence=["test_add"],
                observed_behavior="-1",
                expected_behavior="-1",
                causal_explanation="Test issue",
                confidence_score=0.40,
                missing_evidence_or_assumptions=["Alters test code"],
            ),
        ],
    )

    with patch("app.graph.nodes.root_cause.get_llm_provider", return_value=mock_llm):
        state = {
            "repository_path": str(sample_repo),
            "failures": [{"test_name": "test_add", "traceback": 'File "calc.py", line 2'}],
            "baseline_result": {"exit_code": 1, "total": 1, "failed": 1},
            "attempt_number": 1,
            "timestamps": {},
        }
        out = asyncio.run(root_cause_analysis_node(state))

    assert out["current_state"] == "ROOT_CAUSE_ANALYSIS"
    assert out["primary_hypothesis_id"] == "hyp-1"
    assert len(out["hypotheses"]) == 2
    assert out["selected_hypothesis"]["hypothesis_id"] == "hyp-1"
    assert out["abstention"] is False


# 8. Benchmark Metrics Calculations (Diagnosis & Abstention Denominators)
def test_benchmark_metrics_diagnosis_and_abstention_denominators():
    cases = [
        # 1. Eligible repair, correct repair, diagnosis accurate
        BenchmarkCaseResult(
            fixture_id="f1",
            name="Fix 1",
            category="arithmetic",
            eligible_for_repair=True,
            status="CORRECT_REPAIR",
            is_verified=True,
            duration_ms=1000,
            diagnosis_accurate=True,
        ),
        # 2. Eligible repair, failed repair, diagnosis accurate
        BenchmarkCaseResult(
            fixture_id="f2",
            name="Fix 2",
            category="exception",
            eligible_for_repair=True,
            status="FAILED_REPAIR",
            is_verified=False,
            duration_ms=1200,
            diagnosis_accurate=True,
        ),
        # 3. Eligible repair, diagnosis inaccurate
        BenchmarkCaseResult(
            fixture_id="f3",
            name="Fix 3",
            category="boundary",
            eligible_for_repair=True,
            status="FAILED_REPAIR",
            is_verified=False,
            duration_ms=800,
            diagnosis_accurate=False,
        ),
        # 4. Abstention target case, correctly abstained
        BenchmarkCaseResult(
            fixture_id="f4",
            name="Abstain 1",
            category="insufficient_evidence",
            eligible_for_repair=False,
            status="CORRECT_ABSTENTION",
            is_verified=False,
            duration_ms=500,
            abstention_selected=True,
        ),
        # 5. Abstention target case, falsely verified
        BenchmarkCaseResult(
            fixture_id="f5",
            name="Abstain 2",
            category="contradictory_evidence",
            eligible_for_repair=False,
            status="FALSE_VERIFIED",
            is_verified=True,
            duration_ms=600,
            abstention_selected=False,
        ),
        # 6. Malformed patch rejected
        BenchmarkCaseResult(
            fixture_id="f6",
            name="Malformed",
            category="malformed_patch",
            eligible_for_repair=False,
            status="REJECTED_INVALID_PATCH",
            is_verified=False,
            duration_ms=400,
        ),
    ]

    m = compute_benchmark_metrics(cases)

    # Eligible repairs: 3 eligible, 1 correct
    assert m.eligible_repair_cases == 3
    assert m.correct_repairs == 1
    assert m.repair_success_rate == pytest.approx(1 / 3)

    # Diagnosis accuracy: 3 cases evaluated (f1, f2, f3), 2 accurate
    assert m.diagnosis_cases == 3
    assert m.correct_diagnoses == 2
    assert m.diagnosis_accuracy == pytest.approx(2 / 3)

    # Abstention accuracy: 2 target cases (f4, f5), 1 correct abstention (f4)
    assert m.abstention_cases == 2
    assert m.correct_abstentions == 1
    assert m.abstention_accuracy == pytest.approx(0.5)

    # Unintended abstentions: 0 eligible cases were abstained
    assert m.unintended_abstentions == 0

    # Token & cost are reported as None (never fake zero)
    assert m.total_tokens is None
    assert m.total_cost_usd is None
