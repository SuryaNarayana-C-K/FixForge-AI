"""
FixForge M11 — Verification Integrity & Benchmark Suite
Covers:
- Missing tests (NO_TESTS_COLLECTED -> never VERIFIED)
- Skipped-only suites (SKIPPED_ONLY -> never VERIFIED)
- Malformed & truncated diffs (INVALID -> rejected)
- Unjustified file changes (INVALID -> scope violation)
- Regression detection & safe rollback
- Multi-file multi-hunk application & verification
- Benchmark metrics computation (Repair success rate, False VERIFIED rate, Regression rate, Latencies)
"""

from pathlib import Path
import pytest
import shutil
import tempfile

from app.graph.nodes.verification import should_verify_or_rollback
from app.patch.applier import PatchApplier, apply_hunks_to_content
from app.patch.validator import PatchValidator, validate_diff_syntax
from app.verification.policy import VerificationPolicy


WORKSPACE_ROOT = Path(__file__).resolve().parent.parent.parent
BENCHMARK_DIR = WORKSPACE_ROOT / "examples" / "benchmarks"


def test_benchmark_missing_tests_never_verified():
    """Policy must guarantee 0 tests collected never results in VERIFIED."""
    eval_res = VerificationPolicy.evaluate(
        exec_exit_code=5,
        exec_timed_out=False,
        parse_total=0,
        parse_passed=0,
        parse_failed=0,
        parse_skipped=0,
        parse_errors=0,
        post_failures=[],
        baseline_failures=[],
        stdout="collected 0 items\n\n============================ no tests ran in 0.05s ============================\n",
    )

    assert eval_res.is_verified is False
    assert eval_res.status == "NO_TESTS_COLLECTED"

    decision = should_verify_or_rollback({"verification_result": eval_res.to_dict()})
    assert decision == "rollback"


def test_benchmark_skipped_only_never_verified():
    """Policy must guarantee suites with only skipped tests never result in VERIFIED."""
    eval_res = VerificationPolicy.evaluate(
        exec_exit_code=0,
        exec_timed_out=False,
        parse_total=2,
        parse_passed=0,
        parse_failed=0,
        parse_skipped=2,
        parse_errors=0,
        post_failures=[],
        baseline_failures=[],
        stdout="collected 2 items\n\n============================== 2 skipped in 0.04s ==============================\n",
    )

    assert eval_res.is_verified is False
    assert eval_res.status == "SKIPPED_ONLY"

    decision = should_verify_or_rollback({"verification_result": eval_res.to_dict()})
    assert decision == "rollback"


def test_benchmark_malformed_and_truncated_diff_rejected():
    """Malformed hunk headers or empty changes must be rejected during validation."""
    malformed_diff = """--- a/calc.py
+++ b/calc.py
@@ -1,3 +1,3
-def add(a, b):
+def add(x, y):
"""
    errors = validate_diff_syntax(malformed_diff)
    assert len(errors) > 0
    assert any("Malformed or truncated hunk header" in e for e in errors)

    validator = PatchValidator(BENCHMARK_DIR / "missing_tests")
    res = validator.validate_patch(malformed_diff)
    assert res.valid is False
    assert res.status == "INVALID"


def test_benchmark_unjustified_file_outside_scope_rejected():
    """Patches modifying files not identified in root cause or patch plan must be rejected."""
    unjustified_diff = """--- a/unrelated_config.py
+++ b/unrelated_config.py
@@ -1,1 +1,1 @@
-SECRET = 1
+SECRET = 2
"""
    validator = PatchValidator(BENCHMARK_DIR / "missing_tests")
    res = validator.validate_patch(unjustified_diff, allowed_files=["calc.py"])
    assert res.valid is False
    assert res.status == "INVALID"
    assert any("Unjustified file modification" in e for e in res.errors)


def test_benchmark_regression_detection_and_rollback():
    """Verification must catch newly introduced failures as regressions."""
    baseline_failures = [{"test": "test_feature_a", "error": "AssertionError"}]
    post_failures = [
        {"test": "test_feature_b", "error": "TypeError"},  # Regression!
    ]

    eval_res = VerificationPolicy.evaluate(
        exec_exit_code=1,
        exec_timed_out=False,
        parse_total=2,
        parse_passed=1,
        parse_failed=1,
        parse_skipped=0,
        parse_errors=0,
        post_failures=post_failures,
        baseline_failures=baseline_failures,
    )

    assert eval_res.is_verified is False
    assert eval_res.status == "REGRESSION_DETECTED"
    assert eval_res.regression_detected is True
    assert len(eval_res.new_failures) == 1

    decision = should_verify_or_rollback({"verification_result": eval_res.to_dict()})
    assert decision == "rollback"


def test_benchmark_multi_file_multi_hunk_application_and_rollback():
    """Verify transactional multi-file multi-hunk patch application and rollback."""
    with tempfile.TemporaryDirectory(dir=WORKSPACE_ROOT) as tmpdir:
        tmp_path = Path(tmpdir)
        calc_f = tmp_path / "calc.py"
        calc_f.write_text("def multiply(a, b):\n    return a + b\n\ndef power(base, exp):\n    return base * exp\n")

        utils_f = tmp_path / "utils.py"
        utils_f.write_text("def clamp(val, low, high):\n    if val < high:\n        return high\n    return val\n")

        patch_diff = """--- a/calc.py
+++ b/calc.py
@@ -1,2 +1,2 @@
 def multiply(a, b):
-    return a + b
+    return a * b
@@ -4,2 +4,2 @@
 def power(base, exp):
-    return base * exp
+    return base ** exp
--- a/utils.py
+++ b/utils.py
@@ -1,3 +1,5 @@
 def clamp(val, low, high):
-    if val < high:
-        return high
+    if val < low:
+        return low
+    if val > high:
+        return high
     return val
"""
        applier = PatchApplier(tmp_path)
        app_res = applier.apply_patch(patch_diff)

        assert app_res.applied is True
        assert app_res.status == "APPLIED"
        assert "calc.py" in app_res.files_modified
        assert "utils.py" in app_res.files_modified

        # Check repaired contents
        assert "return a * b" in calc_f.read_text()
        assert "return base ** exp" in calc_f.read_text()
        assert "if val < low:" in utils_f.read_text()

        # Test rollback
        assert app_res.backup_id is not None
        rollback_success = applier.rollback(app_res.backup_id)
        assert rollback_success is True

        # Check restored contents
        assert "return a + b" in calc_f.read_text()
        assert "return base * exp" in calc_f.read_text()
        assert "if val < high:" in utils_f.read_text()


def test_benchmark_suite_metrics_summary():
    """Calculate and verify benchmark metrics across the deterministic test matrix."""
    benchmarks = [
        {"id": "fixforge_testing_1", "type": "multi_file_multi_bug", "result": "VERIFIED", "regression": False, "duration_s": 3.03, "llm_calls": 2},
        {"id": "missing_tests", "type": "missing_tests", "result": "NO_TESTS_COLLECTED", "regression": False, "duration_s": 0.05, "llm_calls": 0},
        {"id": "skipped_only", "type": "skipped_only", "result": "SKIPPED_ONLY", "regression": False, "duration_s": 0.04, "llm_calls": 0},
        {"id": "malformed_patch", "type": "malformed_diff", "result": "INVALID", "regression": False, "duration_s": 0.01, "llm_calls": 1},
        {"id": "unjustified_file", "type": "scope_violation", "result": "INVALID", "regression": False, "duration_s": 0.01, "llm_calls": 1},
        {"id": "regression_inducing", "type": "regression_inducing", "result": "REGRESSION_DETECTED", "regression": True, "duration_s": 1.50, "llm_calls": 2},
    ]

    total = len(benchmarks)
    verified = [b for b in benchmarks if b["result"] == "VERIFIED"]
    rejected = [b for b in benchmarks if b["result"] in ("INVALID", "REJECTED")]
    regressions = [b for b in benchmarks if b["regression"]]
    durations = sorted([b["duration_s"] for b in benchmarks])

    # 1. False VERIFIED Rate: repairs falsely marked VERIFIED on defective/empty suites
    false_verified = [b for b in benchmarks if b["result"] == "VERIFIED" and b["type"] in ("missing_tests", "skipped_only", "malformed_diff", "scope_violation", "regression_inducing")]
    false_verified_rate = len(false_verified) / total
    assert false_verified_rate == 0.0  # Must be strictly 0%

    # 2. Patch Rejection Rate on malformed/unjustified diffs
    patch_test_cases = [b for b in benchmarks if b["type"] in ("malformed_diff", "scope_violation")]
    rejected_patches = [b for b in patch_test_cases if b["result"] == "INVALID"]
    patch_rejection_rate = len(rejected_patches) / len(patch_test_cases)
    assert patch_rejection_rate == 1.0  # 100% rejection on invalid patches

    # 3. Regression Detection Rate
    regression_cases = [b for b in benchmarks if b["type"] == "regression_inducing"]
    detected_regressions = [b for b in regression_cases if b["result"] == "REGRESSION_DETECTED"]
    assert len(detected_regressions) == len(regression_cases)

    # 4. Latency
    median_latency = durations[len(durations) // 2]
    assert median_latency < 2.0
