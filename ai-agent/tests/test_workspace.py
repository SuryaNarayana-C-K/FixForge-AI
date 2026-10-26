import pytest
from pathlib import Path
from app.workspace import WorkspaceManager, WorkspaceSecurityError


def test_valid_workspace_path(tmp_path: Path):
    manager = WorkspaceManager(base_dir=tmp_path)
    sub = tmp_path / "my-repo"
    sub.mkdir()
    resolved = manager.resolve_repository_path("my-repo")
    assert resolved == sub


def test_prevents_traversal_above_base(tmp_path: Path):
    manager = WorkspaceManager(base_dir=tmp_path)
    with pytest.raises(WorkspaceSecurityError, match="Path traversal detected"):
        manager.resolve_repository_path("../outside")


def test_prevents_absolute_path_escape(tmp_path: Path):
    manager = WorkspaceManager(base_dir=tmp_path)
    outside = tmp_path.parent / "secret"
    with pytest.raises(WorkspaceSecurityError, match="Path traversal detected"):
        manager.resolve_repository_path(str(outside))


def test_nonexistent_directory_raises(tmp_path: Path):
    manager = WorkspaceManager(base_dir=tmp_path)
    with pytest.raises(FileNotFoundError):
        manager.resolve_repository_path("does-not-exist")


def test_file_instead_of_dir_raises(tmp_path: Path):
    manager = WorkspaceManager(base_dir=tmp_path)
    test_file = tmp_path / "file.txt"
    test_file.write_text("hello", encoding="utf-8")
    with pytest.raises(NotADirectoryError):
        manager.resolve_repository_path("file.txt")


def test_parse_github_repo():
    from app.workspace import parse_github_repo
    # Explicit HTTPS GitHub URL
    parsed = parse_github_repo("https://github.com/SuryaNarayana-C-K/testingggg")
    assert parsed is not None
    assert parsed[0] == "SuryaNarayana-C-K"
    assert parsed[1] == "testingggg"
    assert parsed[2] == "https://github.com/SuryaNarayana-C-K/testingggg.git"

    # Windows paths must not be parsed as GitHub repos
    assert parse_github_repo(r"C:\Users\Temp\fixforge-test") is None
    assert parse_github_repo("C:/Users/Temp/fixforge-test") is None
    # Local relative paths must not be parsed as GitHub repos
    assert parse_github_repo("examples/buggy-python-project") is None
    assert parse_github_repo("./my-local-dir") is None


def test_resolve_github_url_does_not_append_as_windows_path(tmp_path: Path):
    manager = WorkspaceManager(base_dir=tmp_path)
    # Pre-populate dummy clone to avoid network call during fast unit test
    clone_dir = tmp_path / "repos" / "SuryaNarayana-C-K" / "testingggg"
    clone_dir.mkdir(parents=True)
    (clone_dir / "cart.py").write_text("# dummy cart", encoding="utf-8")

    resolved = manager.resolve_repository_path("https://github.com/SuryaNarayana-C-K/testingggg")
    assert resolved == clone_dir
    assert "https:" not in str(resolved)
    assert (resolved / "cart.py").exists()


def test_windows_style_paths_and_normalization(tmp_path: Path):
    """Verify Windows backslash paths, mixed slashes, and casing resolve correctly."""
    manager = WorkspaceManager(base_dir=tmp_path)
    sub = tmp_path / "nested" / "project"
    sub.mkdir(parents=True)

    # Windows backslash string
    resolved_bs = manager.resolve_repository_path(r"nested\project")
    assert resolved_bs == sub.resolve()

    # Forward slash string
    resolved_fs = manager.resolve_repository_path("nested/project")
    assert resolved_fs == sub.resolve()

    # Absolute Windows path with backslashes
    resolved_abs = manager.resolve_repository_path(str(sub))
    assert resolved_abs == sub.resolve()


def test_complex_traversal_attempts_rejected(tmp_path: Path):
    """Verify various traversal attempts (.., nested ../.., mixed slashes) are rejected."""
    manager = WorkspaceManager(base_dir=tmp_path)
    sub = tmp_path / "valid_dir"
    sub.mkdir()

    traversal_inputs = [
        "../outside",
        r"..\outside",
        "valid_dir/../../outside",
        r"valid_dir\..\..\outside",
        "valid_dir/../../../etc/passwd",
    ]

    for trav in traversal_inputs:
        with pytest.raises(WorkspaceSecurityError, match="Path traversal detected"):
            manager.resolve_repository_path(trav)


def test_dot_directories_not_parsed_as_github_repo():
    """Verify .benchmark_workspaces and dot-prefixed paths are never parsed as GitHub repos."""
    from app.workspace import parse_github_repo

    assert parse_github_repo(".benchmark_workspaces/run-123") is None
    assert parse_github_repo(r".benchmark_workspaces\run-123") is None
    assert parse_github_repo(".agents/skills") is None
    assert parse_github_repo(".cache/temp") is None

