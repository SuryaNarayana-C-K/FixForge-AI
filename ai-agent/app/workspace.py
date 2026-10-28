import os
import re
import subprocess
from pathlib import Path


class WorkspaceSecurityError(ValueError):
    """Raised when a workspace path violates security constraints."""
    pass


def parse_github_repo(input_str: str) -> tuple[str, str, str] | None:
    """
    Parses a GitHub repository string into (owner, repo, clone_url).
    Returns None if the input is a local path or not a GitHub URL/shorthand.
    """
    if not input_str or not isinstance(input_str, str):
        return None

    trimmed = input_str.strip().replace("\\", "/")

    # If it starts with a Windows drive letter (e.g. C:/) or absolute/relative path prefixes, it's a local path
    if re.match(r"^[a-zA-Z]:/", trimmed) or re.match(r"^\.?\.?/", trimmed):
        return None

    # Check for explicit URLs
    is_explicit = bool(re.match(r"^(https?://|git@|git://|github\.com)", trimmed, re.IGNORECASE))
    if is_explicit:
        m = re.search(
            r"(?:https?://|git://)?(?:[^@/\s]+@)?(?:www\.)?github\.com[:/]([a-zA-Z0-9_.-]+)/([a-zA-Z0-9_.-]+?)(?:\.git|/)?$",
            trimmed,
            re.IGNORECASE,
        )
        if m:
            owner = m.group(1)
            repo = re.sub(r"\.git$", "", m.group(2), flags=re.IGNORECASE)
            return owner, repo, f"https://github.com/{owner}/{repo}.git"
        return None

    # Shorthand owner/repo pattern (e.g. "SuryaNarayana-C-K/testingggg")
    m = re.match(r"^([a-zA-Z0-9_.-]+)/([a-zA-Z0-9_.-]+?)(?:\.git|/)?$", trimmed)
    if m:
        owner = m.group(1)
        repo = re.sub(r"\.git$", "", m.group(2), flags=re.IGNORECASE)
        reserved = {
            "examples", "lib", "artifacts", "sandbox", "node_modules", "dist", "src",
            "repos", "database", "scripts", "app", "tests", "temp", "tmp",
            "benchmarks", ".benchmark_workspaces", ".agents", ".conversation", ".cache",
        }
        if owner.startswith(".") or owner.lower() in reserved:
            return None
        return owner, repo, f"https://github.com/{owner}/{repo}.git"

    return None


class WorkspaceManager:
    """Safely manages and validates workspace paths, preventing traversal and escapes."""

    def __init__(self, base_dir: Path | str | None = None):
        if base_dir is not None:
            self.base_dir = Path(base_dir).resolve()
        elif "WORKSPACE_BASE_DIR" in os.environ:
            self.base_dir = Path(os.environ["WORKSPACE_BASE_DIR"]).resolve()
        elif (Path(__file__).resolve().parent.parent.parent / "package.json").exists():
            # Repository root layout (ai-agent/app/workspace.py -> 3 levels up)
            self.base_dir = Path(__file__).resolve().parent.parent.parent.resolve()
        elif (Path(__file__).resolve().parent.parent / "requirements.txt").exists():
            # Container layout (/app/app/workspace.py -> 2 levels up to /app)
            self.base_dir = Path(__file__).resolve().parent.parent.resolve()
        else:
            self.base_dir = Path(__file__).resolve().parent.parent.parent.resolve()

    def resolve_repository_path(self, relative_or_safe_path: str | Path) -> Path:
        """
        Validate and resolve a repository path within the allowed workspace.
        
        For HTTPS GitHub URLs:
        Clones the repository into a dedicated local workspace ('repos/{owner}/{repo}')
        using a safe Git subprocess argument array.
        
        For local directory inputs:
        Rejects:
        - Path traversal ('..')
        - Absolute paths outside the base directory
        - Symlink escapes
        - Non-existent directories
        """
        raw_str = str(relative_or_safe_path).strip()
        if not raw_str:
            raise WorkspaceSecurityError("Repository path cannot be empty.")

        # Check if the input is an existing local directory first
        local_exists = False
        try:
            cand = Path(raw_str)
            if cand.is_absolute():
                local_exists = cand.exists()
            else:
                local_exists = (self.base_dir / cand).exists()
        except Exception:
            local_exists = False

        # Check if the input is a remote GitHub repository URL or shorthand
        parsed_remote = parse_github_repo(raw_str)
        if parsed_remote:
            norm_str = raw_str.strip().replace("\\", "/")
            is_explicit = bool(re.match(r"^(https?://|git@|git://|github\.com)", norm_str, re.IGNORECASE))
            if not is_explicit and (local_exists or "\\" in raw_str):
                parsed_remote = None

        if parsed_remote:
            owner, repo, clone_url = parsed_remote
            target_dir = (self.base_dir / "repos" / owner / repo).resolve()
            legacy_dir = (self.base_dir / "repos" / repo).resolve()

            # Check if already cloned in dedicated workspace or legacy workspace
            if target_dir.exists() and target_dir.is_dir() and any(target_dir.iterdir()):
                resolved = target_dir
            elif legacy_dir.exists() and legacy_dir.is_dir() and any(legacy_dir.iterdir()):
                resolved = legacy_dir
            else:
                target_dir.parent.mkdir(parents=True, exist_ok=True)
                env = dict(os.environ)
                env["GIT_TERMINAL_PROMPT"] = "0"
                try:
                    proc = subprocess.run(
                        ["git", "clone", clone_url, str(target_dir)],
                        capture_output=True,
                        text=True,
                        check=False,
                        timeout=120,
                        env=env,
                    )
                    if proc.returncode != 0:
                        raise RuntimeError(
                            f"Failed to clone repository from '{clone_url}': {proc.stderr or proc.stdout}"
                        )
                except Exception as clone_err:
                    raise RuntimeError(f"Git clone error: {clone_err}") from clone_err
                resolved = target_dir

            # Enforce containment inside the base directory
            base_resolved = self.base_dir.resolve()
            is_clone_contained = False
            try:
                is_clone_contained = resolved.is_relative_to(base_resolved)
            except (ValueError, TypeError):
                is_clone_contained = False

            if not is_clone_contained:
                raise WorkspaceSecurityError(
                    f"Cloned repository resolves outside workspace base '{self.base_dir}'."
                )

            if not resolved.exists():
                raise FileNotFoundError(f"Repository directory does not exist: '{resolved}'.")
            if not resolved.is_dir():
                raise NotADirectoryError(f"Repository path is not a directory: '{resolved}'.")

            return resolved

        # Local directory resolution
        base_resolved = self.base_dir.resolve()
        path_obj = Path(raw_str)

        if path_obj.is_absolute():
            resolved = path_obj.resolve()
        else:
            resolved = (base_resolved / path_obj).resolve()

        # Enforce containment inside the allowed base directory
        is_contained = False
        try:
            is_contained = resolved.is_relative_to(base_resolved)
        except (ValueError, TypeError):
            is_contained = False

        if not is_contained:
            raise WorkspaceSecurityError(
                f"Path traversal detected: '{raw_str}' resolves outside workspace base '{self.base_dir}'."
            )

        # Check for real symlink escapes if symlinks exist
        try:
            real_path = Path(os.path.realpath(str(resolved))).resolve()
            real_base = Path(os.path.realpath(str(base_resolved))).resolve()
            if not real_path.is_relative_to(real_base):
                raise WorkspaceSecurityError(
                    f"Symlink escape detected: '{raw_str}' points outside workspace."
                )
        except (ValueError, TypeError):
            raise WorkspaceSecurityError(
                f"Symlink escape detected: '{raw_str}' points outside workspace."
            )

        if not resolved.exists():
            raise FileNotFoundError(f"Repository directory does not exist: '{resolved}'.")

        if not resolved.is_dir():
            raise NotADirectoryError(f"Repository path is not a directory: '{resolved}'.")

        return resolved
