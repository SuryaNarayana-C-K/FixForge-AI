from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.analyzer import analyze_repository
from app.parser import PytestOutputParser, UnittestOutputParser
from app.runner import ExecutionRunner, LocalExecutionRunner
from app.workspace import WorkspaceManager


async def init_node(state: dict[str, Any]) -> dict[str, Any]:
    """Initialize job state and validate repository accessibility."""
    timestamps = state.get("timestamps", {})
    timestamps["init"] = datetime.now(timezone.utc).isoformat()

    repo_raw = state.get("repository_path", "")
    manager = WorkspaceManager()
    resolved_path = manager.resolve_repository_path(repo_raw)

    return {
        "current_state": "INIT",
        "repository_path": str(resolved_path),
        "errors": state.get("errors", []),
        "timestamps": timestamps,
    }


# Cache repository analysis results by path and mtime to avoid redundant file system traversals
_REPO_ANALYSIS_CACHE: dict[str, tuple[float, Any]] = {}


async def repository_analysis_node(state: dict[str, Any]) -> dict[str, Any]:
    """Inspect repository structure, files, dependencies, and test framework."""
    timestamps = state.get("timestamps", {})
    timestamps["repository_analysis"] = datetime.now(timezone.utc).isoformat()

    repo_dir = Path(state["repository_path"])
    explicit_lang = state.get("explicit_language") or state.get("language")

    # Safe cache check
    cache_key = f"{str(repo_dir)}:{explicit_lang or ''}"
    try:
        dir_mtime = repo_dir.stat().st_mtime
    except Exception:
        dir_mtime = 0.0

    if cache_key in _REPO_ANALYSIS_CACHE and _REPO_ANALYSIS_CACHE[cache_key][0] == dir_mtime:
        structure = _REPO_ANALYSIS_CACHE[cache_key][1]
    else:
        structure, _files = analyze_repository(repo_dir, explicit_lang)
        _REPO_ANALYSIS_CACHE[cache_key] = (dir_mtime, structure)

    return {
        "current_state": "REPOSITORY_ANALYSIS",
        "language": structure.language,
        "test_framework": state.get("test_framework") or structure.test_framework,
        "test_command": state.get("test_command") or structure.test_command,
        "dependency_files": structure.dependency_files,
        "project_structure": structure.to_dict(),
        "timestamps": timestamps,
    }


async def baseline_testing_node(
    state: dict[str, Any],
    runner: ExecutionRunner | None = None,
) -> dict[str, Any]:
    """Execute baseline tests and parse initial outcome."""
    timestamps = state.get("timestamps", {})
    timestamps["baseline_testing"] = datetime.now(timezone.utc).isoformat()

    if runner is None:
        from app.runner import get_execution_runner
        runner = get_execution_runner()

    repo_dir = Path(state["repository_path"])
    job_id = state.get("job_id", "default")
    command = state.get("test_command", "pytest")
    framework = state.get("test_framework", "pytest")

    # Run the test command
    exec_result = await runner.run(command=command, cwd=repo_dir, timeout=120.0, job_id=job_id)
    timestamps["baseline_test_duration_ms"] = int(exec_result.duration * 1000)

    from app.parser import get_test_parser
    parser_cls = get_test_parser(framework)
    parsed = parser_cls.parse(
        stdout=exec_result.stdout,
        stderr=exec_result.stderr,
        exit_code=exec_result.exit_code,
        duration=exec_result.duration,
        command=command,
    )

    if exec_result.timed_out:
        parsed.status = "timeout"

    return {
        "current_state": "BASELINE_TESTING",
        "baseline_result": parsed.to_dict(),
        "timestamps": timestamps,
    }


async def failure_detection_node(state: dict[str, Any]) -> dict[str, Any]:
    """Extract and normalize all failure signatures from the baseline test results."""
    timestamps = state.get("timestamps", {})
    timestamps["failure_detection"] = datetime.now(timezone.utc).isoformat()

    baseline = state.get("baseline_result", {})
    failures = baseline.get("failures", [])

    return {
        "current_state": "FAILURE_DETECTION",
        "failures": failures,
        "failure_signatures": failures,
        "timestamps": timestamps,
    }

