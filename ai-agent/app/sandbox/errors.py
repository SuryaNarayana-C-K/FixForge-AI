"""
Structured error definitions for FixForge Docker Sandbox execution.
"""


class SandboxError(Exception):
    """Base exception for all FixForge sandbox errors."""
    pass


class SandboxUnavailable(SandboxError):
    """Raised when the Docker daemon or CLI is not available."""
    pass


class SandboxTimeout(SandboxError):
    """Raised when a sandbox execution exceeds the configured duration limit."""
    pass


class SandboxResourceLimit(SandboxError):
    """Raised when a resource limit (e.g. memory, CPU, PID) is exceeded."""
    pass


class SandboxWorkspaceViolation(SandboxError):
    """Raised when an invalid or unsafe workspace path is requested for mounting."""
    pass


class SandboxStartupFailure(SandboxError):
    """Raised when the sandbox container fails to start."""
    pass


class SandboxExecutionFailure(SandboxError):
    """Raised when execution inside the container fails unexpectedly."""
    pass


class SandboxCleanupFailure(SandboxError):
    """Raised when container cleanup fails."""
    pass
