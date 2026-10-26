"""
FixForge M12.1 — Benchmark Fixtures Discovery and Workspace Isolation.
Loads canonical fixtures, validates descriptors, and provisions isolated temporary workspaces.
Guarantees canonical fixtures are NEVER modified by benchmark runs.
"""

import json
from pathlib import Path
import shutil
from typing import Any
from uuid import uuid4

from app.benchmark.models import BenchmarkFixture


WORKSPACE_ROOT = Path(__file__).resolve().parent.parent.parent.parent
CANONICAL_FIXTURES_DIR = WORKSPACE_ROOT / "benchmarks" / "fixtures"
BENCHMARK_WORKSPACES_ROOT = WORKSPACE_ROOT / ".benchmark_workspaces"


def load_fixture_from_dir(fixture_dir: Path) -> BenchmarkFixture | None:
    """Loads a single BenchmarkFixture from its directory containing fixture.json."""
    descriptor_path = fixture_dir / "fixture.json"
    if not descriptor_path.is_file():
        return None

    try:
        data = json.loads(descriptor_path.read_text(encoding="utf-8"))
        data["relative_path"] = str(fixture_dir.relative_to(CANONICAL_FIXTURES_DIR))
        return BenchmarkFixture.model_validate(data)
    except Exception as e:
        print(f"Warning: Failed to load benchmark fixture at {fixture_dir}: {e}")
        return None


def list_fixtures() -> list[BenchmarkFixture]:
    """Discovers and returns all valid canonical benchmark fixtures sorted by ID."""
    fixtures: list[BenchmarkFixture] = []
    if not CANONICAL_FIXTURES_DIR.is_dir():
        return fixtures

    for sub_dir in sorted(CANONICAL_FIXTURES_DIR.iterdir()):
        if sub_dir.is_dir():
            fix = load_fixture_from_dir(sub_dir)
            if fix:
                fixtures.append(fix)

    return fixtures


def get_fixture(fixture_id: str) -> BenchmarkFixture | None:
    """Retrieves a specific benchmark fixture by its stable ID."""
    for fix in list_fixtures():
        if fix.id == fixture_id:
            return fix
    return None


def provision_isolated_workspace(fixture: BenchmarkFixture, run_id: str) -> Path:
    """
    Creates an isolated copy of the fixture in a temporary workspace directory.
    Guarantees the canonical fixture files are strictly read-only and never modified.
    """
    source_dir = CANONICAL_FIXTURES_DIR / fixture.relative_path
    if not source_dir.is_dir():
        raise FileNotFoundError(f"Canonical fixture directory not found: {source_dir}")

    target_ws = BENCHMARK_WORKSPACES_ROOT / run_id / fixture.id
    target_ws.parent.mkdir(parents=True, exist_ok=True)
    if target_ws.exists():
        shutil.rmtree(target_ws, ignore_errors=True)

    # Copy canonical fixture contents to isolated workspace (ignoring __pycache__)
    shutil.copytree(
        source_dir,
        target_ws,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".fixforge_backups"),
    )

    return target_ws


def cleanup_isolated_workspace(workspace_path: Path) -> None:
    """Cleans up the isolated workspace after benchmark execution."""
    try:
        if not workspace_path:
            return
        ws_resolved = Path(workspace_path).resolve()
        bench_root = BENCHMARK_WORKSPACES_ROOT.resolve()
        project_root = WORKSPACE_ROOT.resolve()

        # Prevent deletion of project root, benchmark root, filesystem root, or any parent
        if (
            ws_resolved == project_root
            or ws_resolved == bench_root
            or ws_resolved == ws_resolved.parent
            or ws_resolved.parent == project_root
        ):
            return

        if not ws_resolved.is_relative_to(bench_root) or not ws_resolved.is_relative_to(project_root):
            return

        if ws_resolved.exists() and ws_resolved.is_dir():
            shutil.rmtree(ws_resolved, ignore_errors=True)
    except Exception as e:
        print(f"Warning: Failed to clean up benchmark workspace {workspace_path}: {e}")
