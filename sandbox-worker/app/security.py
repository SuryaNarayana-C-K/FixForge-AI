"""
Security validation, safe archive decompression, and secret redaction for FixForge Sandbox Worker.
"""

import hmac
import io
import os
from pathlib import Path
import re
import tarfile
from fastapi import Request


# Maximum limits for workspace archive decompression (Defense against Tarbombs)
MAX_ARCHIVE_BYTES = 20 * 1024 * 1024  # 20 MB compressed
MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024  # 100 MB uncompressed
MAX_MEMBER_COUNT = 5000

# Secret keywords that must never be logged or leaked into containers
SENSITIVE_PATTERNS = [
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


class ArchiveSecurityError(ValueError):
    """Raised when an uploaded archive violates security boundaries."""
    pass


def verify_worker_auth(request: Request, expected_key: str) -> bool:
    """
    Safely compare service credentials using constant-time comparison.
    Redacts keys and prevents timing attacks.
    """
    if not expected_key:
        return False

    auth_header = request.headers.get("x-worker-key", "").strip()
    if not auth_header:
        bearer = request.headers.get("authorization", "").strip()
        if bearer.lower().startswith("bearer "):
            auth_header = bearer[7:].strip()

    if not auth_header:
        return False

    return hmac.compare_digest(auth_header, expected_key.strip())


def sanitize_text(text: str) -> str:
    """
    Redact potential secrets, keys, and tokens from error strings and log text.
    """
    if not text:
        return ""

    sanitized = text
    # Redact common key=value patterns
    sanitized = re.sub(
        r"(?i)(key|secret|token|password|auth|credential|api_key)=([^\s,;]+)",
        r"\1=[REDACTED]",
        sanitized,
    )
    # Redact Bearer tokens
    sanitized = re.sub(
        r"(?i)bearer\s+([a-zA-Z0-9_\-\.]+)",
        r"Bearer [REDACTED]",
        sanitized,
    )
    return sanitized


def safe_extract_archive(
    archive_bytes: bytes,
    destination: Path,
    max_archive_bytes: int = MAX_ARCHIVE_BYTES,
    max_uncompressed_bytes: int = MAX_UNCOMPRESSED_BYTES,
    max_files: int = MAX_MEMBER_COUNT,
) -> Path:
    """
    Safely extract a tar.gz archive into destination directory.
    Enforces:
    - Compressed archive size bounds
    - Uncompressed total size bounds
    - Maximum member / file count
    - Rejection of path traversal ('../') and absolute paths ('/etc', 'C:\\')
    - Rejection of hardlinks and symlinks escaping destination directory
    - Rejection of special device nodes, FIFOs, and sockets
    """
    if len(archive_bytes) > max_archive_bytes:
        raise ArchiveSecurityError(
            f"Archive exceeds maximum compressed size limit of {max_archive_bytes} bytes."
        )

    destination = destination.resolve()
    destination.mkdir(parents=True, exist_ok=True)

    try:
        archive_file = io.BytesIO(archive_bytes)
        with tarfile.open(fileobj=archive_file, mode="r:*") as tar:
            total_size = 0
            member_count = 0

            for member in tar.getmembers():
                member_count += 1
                if member_count > max_files:
                    raise ArchiveSecurityError(f"Archive exceeds maximum file count of {max_files}.")

                total_size += member.size
                if total_size > max_uncompressed_bytes:
                    raise ArchiveSecurityError(
                        f"Archive exceeds maximum uncompressed size limit of {max_uncompressed_bytes} bytes."
                    )

                # Validate member name: prevent directory traversal & absolute path
                name = member.name.replace("\\", "/")
                if name.startswith("/") or re.match(r"^[a-zA-Z]:", name):
                    raise ArchiveSecurityError(f"Absolute path in archive rejected: {member.name}")

                parts = Path(name).parts
                if ".." in parts:
                    raise ArchiveSecurityError(f"Path traversal detected in archive entry: {member.name}")

                # Reject dangerous file types
                if member.isdev() or member.ischr() or member.isblk() or member.isfifo():
                    raise ArchiveSecurityError(f"Special device or FIFO file rejected in archive: {member.name}")

                # Check destination path resolution
                target_path = (destination / member.name).resolve()
                try:
                    target_path.relative_to(destination)
                except ValueError:
                    raise ArchiveSecurityError(f"Path escape outside workspace boundary: {member.name}")

                # Check symlink destinations
                if member.issym():
                    link_target = member.linkname.replace("\\", "/")
                    if link_target.startswith("/") or re.match(r"^[a-zA-Z]:", link_target):
                        raise ArchiveSecurityError(f"Absolute symlink target rejected: {link_target}")
                    resolved_link = (target_path.parent / member.linkname).resolve()
                    try:
                        resolved_link.relative_to(destination)
                    except ValueError:
                        raise ArchiveSecurityError(f"Symlink target escapes workspace boundary: {link_target}")

                # Check hard link destinations
                if member.islnk():
                    raise ArchiveSecurityError(f"Hard links are prohibited in workspace archive: {member.name}")

            # All members validated; safe to extract
            tar.extractall(path=str(destination), filter=None)

    except tarfile.TarError as e:
        raise ArchiveSecurityError(f"Corrupt or invalid tar archive: {e}") from e

    return destination


def filter_safe_env(extra_env: dict[str, str] | None = None) -> dict[str, str]:
    """
    Construct safe execution environment by filtering out host secrets.
    """
    safe = {
        "PYTHONUNBUFFERED": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PIP_NO_CACHE_DIR": "1",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PATH": "/usr/local/bin:/usr/bin:/bin",
    }

    if extra_env:
        for k, v in extra_env.items():
            is_sensitive = any(re.search(pat, k, re.IGNORECASE) for pat in SENSITIVE_PATTERNS)
            if not is_sensitive:
                safe[k] = str(v)

    return safe
