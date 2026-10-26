"""
FixForge M13.1 — Job Lifecycle State Machine & Concurrency Management.
Guarantees explicit valid state transitions:
QUEUED → RUNNING → VERIFYING → SUCCEEDED | FAILED | CANCELLED | TIMED_OUT
Ensures:
- Idempotent cancellation
- Termination of active subprocesses/containers
- Inability for late success callbacks to overwrite CANCELLED or TIMED_OUT
- Concurrency bounding and duplicate execution prevention
"""

import asyncio
from datetime import datetime, timezone
from enum import Enum
import os
from typing import Any


class JobState(str, Enum):
    QUEUED = "QUEUED"
    RUNNING = "RUNNING"
    VERIFYING = "VERIFYING"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"
    TIMED_OUT = "TIMED_OUT"


# Mapping from legacy / lowercase statuses to canonical JobState
STATE_ALIASES: dict[str, JobState] = {
    "queued": JobState.QUEUED,
    "QUEUED": JobState.QUEUED,
    "analyzing": JobState.RUNNING,
    "self_correcting": JobState.RUNNING,
    "running": JobState.RUNNING,
    "RUNNING": JobState.RUNNING,
    "testing": JobState.VERIFYING,
    "verifying": JobState.VERIFYING,
    "VERIFYING": JobState.VERIFYING,
    "verified": JobState.SUCCEEDED,
    "passed": JobState.SUCCEEDED,
    "succeeded": JobState.SUCCEEDED,
    "SUCCEEDED": JobState.SUCCEEDED,
    "failed": JobState.FAILED,
    "error": JobState.FAILED,
    "FAILED": JobState.FAILED,
    "cancelled": JobState.CANCELLED,
    "CANCELLED": JobState.CANCELLED,
    "timeout": JobState.TIMED_OUT,
    "timed_out": JobState.TIMED_OUT,
    "TIMED_OUT": JobState.TIMED_OUT,
}

VALID_TRANSITIONS: dict[JobState, set[JobState]] = {
    JobState.QUEUED: {JobState.RUNNING, JobState.CANCELLED},
    JobState.RUNNING: {
        JobState.VERIFYING,
        JobState.SUCCEEDED,
        JobState.FAILED,
        JobState.CANCELLED,
        JobState.TIMED_OUT,
    },
    JobState.VERIFYING: {
        JobState.SUCCEEDED,
        JobState.FAILED,
        JobState.CANCELLED,
        JobState.TIMED_OUT,
    },
    JobState.SUCCEEDED: set(),
    JobState.FAILED: set(),
    JobState.CANCELLED: set(),
    JobState.TIMED_OUT: set(),
}

TERMINAL_STATES = {
    JobState.SUCCEEDED,
    JobState.FAILED,
    JobState.CANCELLED,
    JobState.TIMED_OUT,
}


class LifecycleError(Exception):
    """Base error for job lifecycle operations."""
    pass


class InvalidStateTransitionError(LifecycleError):
    """Raised when an illegal state machine transition is attempted."""
    pass


class LateCallbackIgnoredError(LifecycleError):
    """Raised when a late callback attempts to overwrite a terminal state."""
    pass


class JobConflictError(LifecycleError):
    """Raised when attempting to start an already running job."""
    pass


class CapacityExceededError(LifecycleError):
    """Raised when maximum concurrent jobs limit is exceeded."""
    pass


class JobRecord:
    def __init__(self, job_id: str, state: JobState = JobState.QUEUED, metadata: dict[str, Any] | None = None):
        self.job_id = job_id
        self.state = state
        self.created_at = datetime.now(timezone.utc).isoformat()
        self.updated_at = self.created_at
        self.started_at: str | None = None
        self.completed_at: str | None = None
        self.container_id: str | None = None
        self.metadata = metadata or {}
        self.history: list[dict[str, Any]] = [
            {"state": self.state.value, "timestamp": self.created_at, "reason": "Job queued"}
        ]
        self.active_task: asyncio.Task | None = None


class JobLifecycleManager:
    """
    Centralized manager tracking all repair job lifecycles and concurrency limits.
    """

    def __init__(self, max_concurrent_jobs: int | None = None):
        env_limit = int(os.environ.get("MAX_CONCURRENT_REPAIR_JOBS", "4"))
        self.max_concurrent_jobs = max_concurrent_jobs if max_concurrent_jobs is not None else env_limit
        self._jobs: dict[str, JobRecord] = {}
        self._lock = asyncio.Lock()

    def get_job(self, job_id: str) -> JobRecord | None:
        return self._jobs.get(job_id)

    def get_active_count(self) -> int:
        return sum(1 for j in self._jobs.values() if j.state in (JobState.RUNNING, JobState.VERIFYING))

    async def register_job(self, job_id: str, metadata: dict[str, Any] | None = None) -> JobRecord:
        """Register a new job in QUEUED state."""
        async with self._lock:
            existing = self._jobs.get(job_id)
            if existing and existing.state in (JobState.RUNNING, JobState.VERIFYING):
                raise JobConflictError(f"Job '{job_id}' is already active in state {existing.state.value}")

            record = JobRecord(job_id=job_id, state=JobState.QUEUED, metadata=metadata)
            self._jobs[job_id] = record
            return record

    async def start_job(self, job_id: str, metadata: dict[str, Any] | None = None) -> JobRecord:
        """
        Transition job from QUEUED to RUNNING.
        Enforces concurrency limit and prevents duplicate runs.
        """
        async with self._lock:
            record = self._jobs.get(job_id)
            if not record:
                record = JobRecord(job_id=job_id, state=JobState.QUEUED, metadata=metadata)
                self._jobs[job_id] = record

            if record.state in (JobState.RUNNING, JobState.VERIFYING):
                raise JobConflictError(f"Job '{job_id}' is already executing in state {record.state.value}")

            if record.state in TERMINAL_STATES:
                raise InvalidStateTransitionError(
                    f"Cannot start job '{job_id}' from terminal state {record.state.value}"
                )

            active_count = sum(
                1 for j in self._jobs.values() if j.state in (JobState.RUNNING, JobState.VERIFYING)
            )
            if active_count >= self.max_concurrent_jobs:
                raise CapacityExceededError(
                    f"Maximum concurrent repair jobs ({self.max_concurrent_jobs}) exceeded. Current active: {active_count}."
                )

            now = datetime.now(timezone.utc).isoformat()
            record.state = JobState.RUNNING
            record.started_at = now
            record.updated_at = now
            record.history.append({"state": JobState.RUNNING.value, "timestamp": now, "reason": "Job started"})
            if metadata:
                record.metadata.update(metadata)
            return record

    async def transition(
        self,
        job_id: str,
        target_state: JobState | str,
        reason: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> JobRecord:
        """
        Safely transition job to a new state with validation.
        Prevents late success callbacks from overwriting CANCELLED or TIMED_OUT states.
        """
        async with self._lock:
            record = self._jobs.get(job_id)
            if not record:
                # If job was not pre-registered, initialize it
                record = JobRecord(job_id=job_id, state=JobState.RUNNING)
                self._jobs[job_id] = record

            canonical_target = STATE_ALIASES.get(
                target_state.value if isinstance(target_state, JobState) else str(target_state),
                JobState.FAILED,
            )

            current_state = record.state

            # Guard against late callbacks overwriting CANCELLED or TIMED_OUT
            if current_state in (JobState.CANCELLED, JobState.TIMED_OUT):
                if canonical_target in (JobState.SUCCEEDED, JobState.VERIFYING):
                    raise LateCallbackIgnoredError(
                        f"Late callback to state {canonical_target.value} ignored: "
                        f"Job '{job_id}' is already in terminal state {current_state.value}."
                    )
                # Idempotent terminal transition
                if canonical_target == current_state:
                    return record
                raise InvalidStateTransitionError(
                    f"Cannot transition job '{job_id}' from {current_state.value} to {canonical_target.value}"
                )

            # Check valid transition
            allowed = VALID_TRANSITIONS.get(current_state, set())
            if canonical_target not in allowed and canonical_target != current_state:
                raise InvalidStateTransitionError(
                    f"Invalid state transition for job '{job_id}': cannot move from {current_state.value} to {canonical_target.value}."
                )

            now = datetime.now(timezone.utc).isoformat()
            record.state = canonical_target
            record.updated_at = now
            if canonical_target in TERMINAL_STATES:
                record.completed_at = now

            record.history.append({
                "state": canonical_target.value,
                "timestamp": now,
                "reason": reason or f"Transitioned to {canonical_target.value}",
            })
            if metadata:
                record.metadata.update(metadata)

            return record

    async def cancel_job(self, job_id: str, reason: str = "Cancelled by user request") -> JobRecord:
        """
        Idempotently cancel a job.
        Terminates running subprocesses or container and transitions state to CANCELLED.
        """
        async with self._lock:
            record = self._jobs.get(job_id)
            if not record:
                record = JobRecord(job_id=job_id, state=JobState.CANCELLED)
                self._jobs[job_id] = record
                return record

            # Idempotent check
            if record.state == JobState.CANCELLED:
                return record

            # If already succeeded or failed, do not retroactively cancel completed jobs
            if record.state in (JobState.SUCCEEDED, JobState.FAILED, JobState.TIMED_OUT):
                return record

            # Cancel active asyncio task if present
            if record.active_task and not record.active_task.done():
                record.active_task.cancel()

            # Clean up active container if registered
            from app.sandbox.docker_runner import DockerSandboxRunner
            await DockerSandboxRunner.cancel_job(job_id)
            try:
                from app.sandbox.remote_runner import RemoteSandboxRunner
                await RemoteSandboxRunner.cancel_job(job_id)
            except Exception:
                pass

            now = datetime.now(timezone.utc).isoformat()
            record.state = JobState.CANCELLED
            record.updated_at = now
            record.completed_at = now
            record.history.append({
                "state": JobState.CANCELLED.value,
                "timestamp": now,
                "reason": reason,
            })
            return record

    async def reconcile_orphaned_containers(self) -> list[str]:
        """
        Reconcile and forcefully remove any orphaned Docker containers matching fixforge-sandbox-*.
        Called at startup to ensure no dangling containers remain after an agent crash or restart.
        """
        cleaned: list[str] = []
        try:
            proc = await asyncio.create_subprocess_exec(
                "docker", "ps", "-a", "--filter", "name=fixforge-sandbox-", "--format", "{{.Names}}",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10.0)
            if proc.returncode == 0:
                container_names = [line.strip() for line in stdout.decode().splitlines() if line.strip()]
                for name in container_names:
                    try:
                        rm_proc = await asyncio.create_subprocess_exec(
                            "docker", "rm", "-f", name,
                            stdout=asyncio.subprocess.DEVNULL,
                            stderr=asyncio.subprocess.DEVNULL,
                        )
                        await asyncio.wait_for(rm_proc.wait(), timeout=10.0)
                        cleaned.append(name)
                    except Exception:
                        pass
        except Exception:
            pass

        # Also trigger remote worker reconciliation if configured
        worker_url = os.environ.get("SANDBOX_WORKER_URL")
        worker_key = os.environ.get("INTERNAL_WORKER_KEY")
        if worker_url and worker_key:
            try:
                import urllib.request
                import json
                def _remote_reconcile():
                    try:
                        req = urllib.request.Request(
                            f"{worker_url.rstrip('/')}/v1/reconcile",
                            method="POST",
                            headers={"x-worker-key": worker_key},
                        )
                        with urllib.request.urlopen(req, timeout=5.0) as resp:
                            if resp.status == 200:
                                data = json.loads(resp.read().decode("utf-8"))
                                return data.get("cleaned_containers", [])
                    except Exception:
                        return []
                    return []
                remote_cleaned = await asyncio.to_thread(_remote_reconcile)
                cleaned.extend(remote_cleaned)
            except Exception:
                pass

        return cleaned

    async def reconcile_startup_state(self) -> dict[str, Any]:
        """
        Reconcile in-memory state on startup:
        - Purge orphaned Docker containers.
        - Mark any jobs that were in non-terminal states as FAILED (never mark interrupted jobs as successful).
        """
        cleaned_containers = await self.reconcile_orphaned_containers()
        reconciled_jobs: list[str] = []
        now = datetime.now(timezone.utc).isoformat()
        async with self._lock:
            for job_id, record in self._jobs.items():
                if record.state not in TERMINAL_STATES:
                    record.state = JobState.FAILED
                    record.completed_at = now
                    record.updated_at = now
                    record.history.append({
                        "state": JobState.FAILED.value,
                        "timestamp": now,
                        "reason": "Execution interrupted by agent restart. Partially executed jobs are never marked successful.",
                    })
                    reconciled_jobs.append(job_id)
        return {
            "cleaned_containers": cleaned_containers,
            "reconciled_jobs": reconciled_jobs,
        }


# Global singleton instance
global_lifecycle_manager = JobLifecycleManager()
