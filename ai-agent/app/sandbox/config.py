"""
Configuration for the FixForge Docker Sandbox execution environment.
All limits and runtime options are configurable via environment variables.
"""

from dataclasses import dataclass
import os


@dataclass(frozen=True)
class SandboxConfig:
    timeout_seconds: float = 120.0
    memory_limit: str = "512m"
    cpus_limit: str = "1"
    pids_limit: int = 128
    output_limit_bytes: int = 5242880  # 5 MB
    image_name: str = "fixforge-sandbox:latest"
    user: str = "sandboxuser"
    network_mode: str = "none"
    execution_mode: str = "docker"  # "docker" or "local"
    read_only_root: bool = True
    drop_capabilities: bool = True
    no_new_privileges: bool = True
    tmpfs_tmp_size: str = "64m"
    allow_local_subprocess: bool = False

    @classmethod
    def from_env(cls) -> "SandboxConfig":
        """Load configuration from environment variables with safe defaults."""
        timeout = float(os.environ.get("SANDBOX_TIMEOUT", "120"))
        memory = os.environ.get("SANDBOX_MEMORY", "512m").strip()
        cpus = os.environ.get("SANDBOX_CPUS", "1").strip()
        pids = int(os.environ.get("SANDBOX_PIDS_LIMIT", "128"))
        output_limit = int(os.environ.get("SANDBOX_OUTPUT_LIMIT", "5242880"))
        image = os.environ.get("SANDBOX_IMAGE", "fixforge-sandbox:latest").strip()
        user = os.environ.get("SANDBOX_USER", "sandboxuser").strip()
        network = os.environ.get("SANDBOX_NETWORK", "none").strip()
        mode = os.environ.get("EXECUTION_MODE", "docker").strip().lower()

        read_only = os.environ.get("SANDBOX_READ_ONLY_ROOT", "true").strip().lower() in ("true", "1", "yes")
        drop_caps = os.environ.get("SANDBOX_DROP_CAPABILITIES", "true").strip().lower() in ("true", "1", "yes")
        no_privs = os.environ.get("SANDBOX_NO_NEW_PRIVILEGES", "true").strip().lower() in ("true", "1", "yes")
        tmpfs_size = os.environ.get("SANDBOX_TMPFS_SIZE", "64m").strip()
        allow_local = os.environ.get("ALLOW_LOCAL_SUBPROCESS", "false").strip().lower() in ("true", "1", "yes")

        return cls(
            timeout_seconds=timeout,
            memory_limit=memory,
            cpus_limit=cpus,
            pids_limit=pids,
            output_limit_bytes=output_limit,
            image_name=image,
            user=user,
            network_mode=network,
            execution_mode=mode,
            read_only_root=read_only,
            drop_capabilities=drop_caps,
            no_new_privileges=no_privs,
            tmpfs_tmp_size=tmpfs_size,
            allow_local_subprocess=allow_local,
        )
