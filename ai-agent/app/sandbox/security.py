"""
Security controls and validation for the FixForge Docker Sandbox.
"""

from pathlib import Path
import re
from app.workspace import WorkspaceManager, WorkspaceSecurityError
from app.sandbox.errors import SandboxWorkspaceViolation


# Explicitly permitted container environment variables
ALLOWED_ENV_VARS = {
    "PYTHONUNBUFFERED": "1",
    "PYTHONDONTWRITEBYTECODE": "1",
    "PIP_NO_CACHE_DIR": "1",
    "LANG": "C.UTF-8",
    "LC_ALL": "C.UTF-8",
    "PATH": "/usr/local/bin:/usr/bin:/bin",
}

# Sensitive keyword patterns that must NEVER leak from host environment into sandbox
SENSITIVE_ENV_PATTERNS = [
    r"SECRET",
    r"KEY",
    r"TOKEN",
    r"PASSWORD",
    r"AUTH",
    r"DATABASE",
    r"PRISMA",
    r"CREDENTIAL",
    r"AWS",
    r"OPENAI",
    r"ANTHROPIC",
    r"GEMINI",
    r"GITHUB",
]


def validate_sandbox_workspace(workspace: Path | str, base_dir: Path | None = None) -> Path:
    """
    Validate that the workspace directory is strictly contained within the allowed base path.
    Prevents path traversal, absolute path escapes, symlink escapes, and sensitive system mounts.
    """
    manager = WorkspaceManager(base_dir=base_dir)
    try:
        resolved = manager.resolve_repository_path(workspace)
        
        # Enforce that workspace cannot be host root, home directory, or critical system paths
        try:
            home = Path.home().resolve()
        except Exception:
            home = None
            
        if home and resolved == home:
            raise SandboxWorkspaceViolation("Cannot mount host home directory into sandbox.")

        # Check for filesystem root
        if resolved == resolved.parent or str(resolved).rstrip("\\/") in ("/", "C:", "C:\\", "c:", "c:\\"):
            raise SandboxWorkspaceViolation("Cannot mount host root filesystem into sandbox.")

        # Check for sensitive system paths
        resolved_str = str(resolved).replace("\\", "/").lower()
        forbidden_mount_prefixes = [
            "/var/run",
            "/etc",
            "/proc",
            "/sys",
            "/dev",
            "/root",
            "c:/windows",
            "c:/program files",
        ]
        for prefix in forbidden_mount_prefixes:
            if resolved_str == prefix or resolved_str.startswith(f"{prefix}/"):
                raise SandboxWorkspaceViolation(f"Cannot mount sensitive host path into sandbox: {prefix}")

        return resolved
    except WorkspaceSecurityError as e:
        raise SandboxWorkspaceViolation(f"Sandbox workspace violation: {e}") from e


def sanitize_command(command: str) -> str:
    """
    Validate and trim the command intended for in-container execution.
    Rejects empty commands and obvious host breakout attempts.
    """
    cmd = command.strip()
    if not cmd:
        raise ValueError("Command cannot be empty.")

    # Rejection of obvious host escape patterns
    # While container isolation is the primary barrier, defense-in-depth rejects blatant host targets.
    forbidden_tokens = ["/var/run/docker.sock", "docker.sock", ":/host", "/proc/sysrq-trigger"]
    for token in forbidden_tokens:
        if token in cmd:
            raise ValueError(f"Command contains forbidden token: {token}")

    return cmd


def build_safe_container_env(extra_env: dict[str, str] | None = None) -> dict[str, str]:
    """
    Build an isolated, minimal environment for the sandbox container.
    Host environment variables (API keys, tokens, DB URLs) are strictly excluded.
    """
    safe_env = dict(ALLOWED_ENV_VARS)

    if extra_env:
        for k, v in extra_env.items():
            # Validate key name
            is_sensitive = any(
                re.search(pat, k, re.IGNORECASE) for pat in SENSITIVE_ENV_PATTERNS
            )
            if not is_sensitive:
                safe_env[k] = str(v)

    return safe_env
