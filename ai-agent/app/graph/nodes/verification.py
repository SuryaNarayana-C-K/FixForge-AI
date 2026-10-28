"""
Verification, regression detection, rollback, and lifecycle nodes for Milestone 5 self-correction loop.
"""

from datetime import datetime, timezone
import hashlib
from pathlib import Path
import time
from typing import Any

from app.parser import PytestOutputParser, UnittestOutputParser
from app.patch.applier import PatchApplier
from app.patch_schemas import RepairAttemptRecord, VerificationResult
from app.runner import get_execution_runner



async def verification_testing_node(state: dict[str, Any]) -> dict[str, Any]:
    """
    Executes repository test suite inside Docker sandbox (or configured runner) after patch application.
    """
    timestamps = dict(state.get("timestamps", {}))
    timestamps["verification_testing"] = datetime.now(timezone.utc).isoformat()

    agent_events = list(state.get("agent_events", []))
    attempt_num = state.get("attempt_number", 1)
    print(f"[ATTEMPT {attempt_num}] VERIFICATION_STARTED", flush=True)

    agent_events.append({
        "event": "VERIFICATION_STARTED",
        "attempt": attempt_num,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "state": "VERIFICATION_TESTING",
    })

    repo_path = Path(state["repository_path"])
    test_framework = state.get("test_framework", "pytest")
    test_command = state.get("test_command", "pytest")

    runner = get_execution_runner()
    print(f"[ATTEMPT {attempt_num}] EXECUTION_STARTED: {test_command} in {repo_path}", flush=True)
    exec_result = await runner.run(
        command=test_command,
        cwd=repo_path,
        timeout=120.0,
        job_id=state.get("job_id", "default"),
    )
    duration = exec_result.duration
    timestamps["verification_duration_ms"] = int(duration * 1000)
    print(f"[ATTEMPT {attempt_num}] EXECUTION_COMPLETED: exit_code={exec_result.exit_code}, duration={duration}s", flush=True)
    if exec_result.exit_code != 0:
        print(f"[ATTEMPT {attempt_num}] STDOUT: {exec_result.stdout[:300]}", flush=True)
        print(f"[ATTEMPT {attempt_num}] STDERR: {exec_result.stderr[:300]}", flush=True)

    # Parse execution result using framework parser
    from app.parser import get_test_parser
    parser_cls = get_test_parser(test_framework)
    parse_result = parser_cls.parse(
        stdout=exec_result.stdout,
        stderr=exec_result.stderr,
        exit_code=exec_result.exit_code,
        duration=duration,
        command=test_command,
    )

    print(f"[ATTEMPT {attempt_num}] TEST_RESULT_PARSED: {parse_result.passed} passed, {parse_result.failed} failed, total={parse_result.total}", flush=True)

    post_failures = [f.to_dict() if hasattr(f, "to_dict") else f for f in parse_result.failures]
    baseline_failures = state.get("failure_signatures", []) or state.get("failures", [])

    from app.verification.policy import VerificationPolicy
    eval_res = VerificationPolicy.evaluate(
        exec_exit_code=exec_result.exit_code,
        exec_timed_out=exec_result.timed_out,
        parse_total=parse_result.total,
        parse_passed=parse_result.passed,
        parse_failed=parse_result.failed,
        parse_skipped=parse_result.skipped,
        parse_errors=parse_result.errors,
        post_failures=post_failures,
        baseline_failures=baseline_failures,
        stdout=exec_result.stdout,
        stderr=exec_result.stderr,
    )

    status = eval_res.status
    regression_detected = eval_res.regression_detected
    new_failures = eval_res.new_failures
    resolved_failures = eval_res.resolved_failures

    v_result = VerificationResult(
        status=status,
        exit_code=exec_result.exit_code,
        passed=parse_result.passed,
        failed=parse_result.failed,
        skipped=parse_result.skipped,
        total=parse_result.total,
        stdout=exec_result.stdout,
        stderr=exec_result.stderr,
        duration=duration,
        timed_out=exec_result.timed_out,
        regression_detected=regression_detected,
        failure_signatures=post_failures,
        new_failures=new_failures,
        resolved_failures=resolved_failures,
    )

    print(f"[ATTEMPT {attempt_num}] VERIFICATION_COMPLETED: status={status}", flush=True)

    return {
        "current_state": "VERIFICATION_TESTING",
        "verification": v_result.model_dump(),
        "verification_result": v_result.model_dump(),
        "regression_detected": regression_detected,
        "timestamps": timestamps,
        "agent_events": agent_events,
    }


async def verification_analysis_node(state: dict[str, Any]) -> dict[str, Any]:
    """
    Analyzes post-patch test results, persists attempt record, and updates attempt history.
    """
    v_dict = state.get("verification_result", {})
    status = v_dict.get("status", "FAILED")
    attempt_num = state.get("attempt_number", 1)
    agent_events = list(state.get("agent_events", []))
    attempt_history = list(state.get("attempt_history", []))

    if status == "PASSED":
        agent_events.append({
            "event": "VERIFICATION_COMPLETED",
            "attempt": attempt_num,
            "status": "PASSED",
            "testsPassed": v_dict.get("passed", 0),
            "testsFailed": v_dict.get("failed", 0),
            "duration": v_dict.get("duration", 0.0),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })
    elif status == "REGRESSION_DETECTED":
        agent_events.append({
            "event": "REGRESSION_DETECTED",
            "attempt": attempt_num,
            "status": "REGRESSION_DETECTED",
            "newFailures": len(v_dict.get("new_failures", [])),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })
        agent_events.append({
            "event": "VERIFICATION_FAILED",
            "attempt": attempt_num,
            "reason": "New test regressions detected after patch",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })
    else:
        agent_events.append({
            "event": "VERIFICATION_FAILED",
            "attempt": attempt_num,
            "testsPassed": v_dict.get("passed", 0),
            "testsFailed": v_dict.get("failed", 0),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })

    # Build Attempt Record
    attempt_record = {
        "attempt": attempt_num,
        "attempt_number": attempt_num,
        "status": status,
        "root_cause": state.get("root_cause_analysis"),
        "root_cause_confidence": state.get("root_cause_confidence"),
        "patch_plan": state.get("patch_plan"),
        "generated_patch": state.get("generated_patch"),
        "patch_hash": state.get("patch_hash"),
        "validation": state.get("patch_validation"),
        "application": state.get("patch_application"),
        "verification": v_dict,
        "rollback_performed": False,
        "duration": v_dict.get("duration", 0.0),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    attempt_history.append(attempt_record)

    print(f"[ATTEMPT {attempt_num}] ATTEMPT_COMPLETED: status={status}", flush=True)

    return {
        "current_state": "VERIFICATION_ANALYSIS",
        "attempt_history": attempt_history,
        "agent_events": agent_events,
    }


async def rollback_node(state: dict[str, Any]) -> dict[str, Any]:
    """
    Safely rolls back the failed patch using the backup snapshot before retrying.
    """
    attempt_num = state.get("attempt_number", 1)
    agent_events = list(state.get("agent_events", []))
    attempt_history = list(state.get("attempt_history", []))

    agent_events.append({
        "event": "ROLLBACK_STARTED",
        "attempt": attempt_num,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })

    repo_path = Path(state["repository_path"])
    backup_id = state.get("patch_application", {}).get("backup_id")

    rollback_ok = False
    if backup_id:
        applier = PatchApplier(repo_path)
        rollback_ok = applier.rollback(backup_id)

    # Update rollback status in last attempt record or record invalid patch attempt
    val = state.get("patch_validation", {})
    if not attempt_history or attempt_history[-1].get("attempt_number") != attempt_num:
        attempt_record = {
            "attempt": attempt_num,
            "attempt_number": attempt_num,
            "status": "FAILED",
            "failure_reason": "INVALID_PATCH" if not val.get("valid") else "FAILED",
            "root_cause": state.get("root_cause_analysis"),
            "root_cause_confidence": state.get("root_cause_confidence"),
            "patch_plan": state.get("patch_plan"),
            "generated_patch": state.get("generated_patch"),
            "patch_hash": state.get("patch_hash"),
            "validation": val,
            "application": state.get("patch_application"),
            "verification": None,
            "rollback_performed": rollback_ok,
            "duration": 0.0,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        attempt_history.append(attempt_record)
    else:
        attempt_history[-1]["rollback_performed"] = rollback_ok

    agent_events.append({
        "event": "ROLLBACK_COMPLETED",
        "attempt": attempt_num,
        "success": rollback_ok,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })

    next_attempt = attempt_num + 1

    return {
        "current_state": "ROLLBACK",
        "attempt_number": next_attempt,
        "rollback_performed": rollback_ok,
        "attempt_history": attempt_history,
        "agent_events": agent_events,
    }


async def verified_node(state: dict[str, Any]) -> dict[str, Any]:
    """Sets final status to VERIFIED when test execution confirms repair."""
    agent_events = list(state.get("agent_events", []))
    agent_events.append({
        "event": "REPAIR_VERIFIED",
        "attempt": state.get("attempt_number", 1),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "summary": "Repository tests passed without regression inside sandbox execution",
    })
    return {
        "current_state": "VERIFIED",
        "final_status": "VERIFIED",
        "is_verified": True,
        "agent_events": agent_events,
    }


async def failed_node(state: dict[str, Any]) -> dict[str, Any]:
    """Sets final status to FAILED when repair attempts are exhausted or timeout occurs."""
    agent_events = list(state.get("agent_events", []))
    reason = state.get("failure_reason", "Maximum repair attempts reached without successful verification")
    agent_events.append({
        "event": "REPAIR_FAILED",
        "attempt": state.get("attempt_number", 1),
        "reason": reason,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })
    return {
        "current_state": "FAILED",
        "final_status": "FAILED",
        "is_verified": False,
        "agent_events": agent_events,
    }


async def human_review_node(state: dict[str, Any]) -> dict[str, Any]:
    """Stops autonomous execution when security or critical infrastructure review is required."""
    agent_events = list(state.get("agent_events", []))
    agent_events.append({
        "event": "REPAIR_REQUIRES_REVIEW",
        "attempt": state.get("attempt_number", 1),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "summary": "Patch modifies protected files and requires explicit human review",
    })
    return {
        "current_state": "REQUIRES_REVIEW",
        "final_status": "REQUIRES_REVIEW",
        "is_verified": False,
        "agent_events": agent_events,
    }


# Conditional Edge Evaluation Functions

def should_verify_or_rollback(state: dict[str, Any]) -> str:
    """Evaluates whether verification passed or rollback is required."""
    v_dict = state.get("verification_result") or state.get("verification") or {}
    total = v_dict.get("total", 0)
    skipped = v_dict.get("skipped", 0)
    passed = v_dict.get("passed", 0)
    failed = v_dict.get("failed", 0)
    errors = v_dict.get("errors", 0)
    exit_code = v_dict.get("exit_code", 1)
    status = v_dict.get("status")
    regression = v_dict.get("regression_detected", False)
    executed = total - skipped

    if (
        status == "PASSED"
        and exit_code == 0
        and total > 0
        and executed > 0
        and passed > 0
        and failed == 0
        and errors == 0
        and not regression
    ):
        return "verified"
    return "rollback"


def check_retry_condition(state: dict[str, Any]) -> str:
    """Evaluates retry budget limits: max attempts, timeout, and max LLM calls."""
    attempt_num = state.get("attempt_number", 1)
    max_attempts = state.get("max_attempts", 3)
    max_repair_time = state.get("max_repair_time", 600.0)
    repair_started_at = state.get("repair_started_at")
    total_llm_calls = state.get("total_llm_calls", 0)
    max_llm_calls = state.get("max_llm_calls", 10)

    # 1. Attempt limit check
    if attempt_num > max_attempts:
        return "failed"

    # 2. Total time limit check
    if repair_started_at:
        try:
            start_dt = datetime.fromisoformat(repair_started_at)
            elapsed = (datetime.now(timezone.utc) - start_dt).total_seconds()
            if elapsed > max_repair_time:
                return "failed"
        except Exception:
            pass

    # 3. LLM call budget check
    if total_llm_calls >= max_llm_calls:
        return "failed"

    return "retry"
