import pytest
from pydantic import ValidationError

from app.patch_schemas import (
    GeneratedPatch,
    PatchApplicationResult,
    PatchChange,
    PatchPlan,
    PatchValidationResult,
    RootCauseAnalysis,
    RootCauseEvidence,
)


def test_root_cause_analysis_schema_valid():
    rc = RootCauseAnalysis(
        summary="Zero division fallback returns -1.",
        failure_type="logic_error",
        root_cause="Line 4 returns -1 instead of 0.",
        observed="Expected 0, received -1",
        hypothesis="Fallback branch handling is incorrect",
        evidence=[RootCauseEvidence(file="calculator.py", line=4, reason="Returns -1")],
        confidence=0.95,
    )
    assert rc.confidence == 0.95
    assert len(rc.evidence) == 1
    assert rc.evidence[0].file == "calculator.py"


def test_root_cause_analysis_confidence_bounds():
    with pytest.raises(ValidationError):
        RootCauseAnalysis(
            summary="Invalid confidence",
            root_cause="Invalid",
            confidence=1.5,  # must be <= 1.0
        )


def test_patch_plan_schema():
    plan = PatchPlan(
        objective="Fix zero count return",
        files_to_modify=["calculator.py"],
        changes=[
            PatchChange(
                file="calculator.py",
                location="line 4",
                description="Change -1 to 0",
            )
        ],
        risks=["No risk"],
    )
    assert plan.files_to_modify == ["calculator.py"]
    assert len(plan.changes) == 1


def test_generated_patch_schema():
    patch = GeneratedPatch(
        files=["calculator.py"],
        diff="--- a/calculator.py\n+++ b/calculator.py\n",
        explanation="Fixes bug",
    )
    assert patch.files == ["calculator.py"]
    assert patch.diff.startswith("--- a/")


def test_patch_validation_result_schema():
    res = PatchValidationResult(
        valid=True,
        status="VALID",
        errors=[],
        warnings=[],
        files_to_modify=["calculator.py"],
        lines_added=1,
        lines_removed=1,
    )
    assert res.valid is True
    assert res.status == "VALID"
    assert res.lines_added == 1


def test_patch_application_result_schema():
    app = PatchApplicationResult(
        applied=True,
        status="APPLIED",
        error=None,
        files_modified=["calculator.py"],
        git_diff_before=None,
        git_diff_after=None,
        backup_id="backup-123",
        timestamp="2026-09-29T12:00:00Z",
    )
    assert app.applied is True
    assert app.status == "APPLIED"
    assert app.backup_id == "backup-123"
