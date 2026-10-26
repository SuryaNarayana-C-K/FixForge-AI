"""
Container lifecycle management and command generation for FixForge Docker Sandbox.
"""

import asyncio
import os
from pathlib import Path
import re
import uuid
from app.sandbox.config import SandboxConfig
from app.sandbox.security import build_safe_container_env


TRUNCATION_MARKER = "\n[output truncated by FixForge sandbox]"


def generate_container_name(job_id: str, run_id: str | None = None) -> str:
    """
    Generate a unique, deterministic container name.
    Avoids collisions between concurrent jobs or attempts.
    """
    # Sanitize job_id to alphanumeric and dashes
    clean_job = re.sub(r"[^a-zA-Z0-9_-]", "", job_id)[:16] or "job"
    run_suffix = run_id[:8] if run_id else uuid.uuid4().hex[:8]
    return f"fixforge-sandbox-{clean_job}-{run_suffix}"


def truncate_output(text: str, limit_bytes: int) -> str:
    """
    Truncate text if it exceeds the limit in bytes, appending a clear warning marker.
    """
    if not text:
        return ""

    encoded = text.encode("utf-8", errors="replace")
    if len(encoded) <= limit_bytes:
        return text

    truncated_bytes = encoded[:limit_bytes]
    truncated_str = truncated_bytes.decode("utf-8", errors="ignore")
    return truncated_str + TRUNCATION_MARKER


_ACTIVE_CONTAINERS: set[str] = set()


def register_active_container(container_name: str) -> None:
    """Track an active container for guaranteed cancellation and cleanup."""
    if container_name:
        _ACTIVE_CONTAINERS.add(container_name)


def unregister_active_container(container_name: str) -> None:
    """Untrack a container once cleaned up."""
    _ACTIVE_CONTAINERS.discard(container_name)


def get_active_containers() -> list[str]:
    """Return all currently tracked container names."""
    return list(_ACTIVE_CONTAINERS)


def build_docker_run_args(
    container_name: str,
    command: str,
    workspace_path: Path,
    config: SandboxConfig,
    extra_env: dict[str, str] | None = None,
) -> list[str]:
    """
    Build the full list of arguments for `docker run`.
    Enforces non-root user, network disabled, CPU/memory/PID limits,
    capability dropping, no-new-privileges, optional read-only rootfs, and workspace volume mounting.
    """
    safe_env = build_safe_container_env(extra_env)

    # Normalize host path for Docker volume mounting
    host_workspace = str(workspace_path.resolve())
    host_root = os.environ.get("HOST_WORKSPACE_ROOT")
    if host_root:
        try:
            rel = workspace_path.resolve().relative_to(Path("/app"))
            host_workspace = str(Path(host_root) / rel)
        except (ValueError, TypeError):
            pass
    if "\\" in host_workspace:
        # On Windows, Docker CLI accepts forward slashes or standard drive paths
        host_workspace = host_workspace.replace("\\", "/")

    args = [
        "docker",
        "run",
        "--name",
        container_name,
        "--rm",  # Automatically cleanup on exit when possible
        "--user",
        config.user,
        "--network",
        config.network_mode,
        "--memory",
        config.memory_limit,
        "--cpus",
        config.cpus_limit,
        "--pids-limit",
        str(config.pids_limit),
    ]

    # Enhanced Linux security containment
    if getattr(config, "no_new_privileges", True):
        args.extend(["--security-opt", "no-new-privileges:true"])

    if getattr(config, "drop_capabilities", True):
        args.extend(["--cap-drop", "ALL"])

    if getattr(config, "read_only_root", False):
        args.append("--read-only")
        tmpfs_size = getattr(config, "tmpfs_tmp_size", "64m")
        args.extend(["--tmpfs", f"/tmp:rw,noexec,nosuid,size={tmpfs_size}"])

    args.extend([
        "-v",
        f"{host_workspace}:/workspace:rw",
        "-w",
        "/workspace",
    ])

    # Inject isolated environment variables
    for k, v in safe_env.items():
        args.extend(["-e", f"{k}={v}"])

    args.append(config.image_name)

    # Execute command in shell inside container
    args.extend(["sh", "-c", command])

    return args


async def cleanup_container(container_name: str) -> None:
    """
    Guaranteed cleanup: forcefully stop and remove container if still present.
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            "docker",
            "rm",
            "-f",
            container_name,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await proc.wait()
    except Exception:
        # Ignore cleanup errors if docker is not running or container already gone
        pass
    finally:
        unregister_active_container(container_name)


async def cleanup_all_active_containers() -> int:
    """Clean up all recorded active containers."""
    containers = list(_ACTIVE_CONTAINERS)
    cleaned = 0
    for c in containers:
        await cleanup_container(c)
        cleaned += 1
    return cleaned
