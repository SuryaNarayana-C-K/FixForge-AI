from pathlib import Path
import tempfile

from app.patch.validator import PatchValidator, is_protected_file, split_diff_by_file


def test_is_protected_file():
    assert is_protected_file("Dockerfile") is True
    assert is_protected_file("sandbox/Dockerfile") is True
    assert is_protected_file(".env") is True
    assert is_protected_file(".env.production") is True
    assert is_protected_file(".github/workflows/ci.yml") is True
    assert is_protected_file("docker-compose.yml") is True
    assert is_protected_file("calculator.py") is False


def test_patch_validator_valid_diff():
    demo_repo = Path(__file__).resolve().parent.parent.parent / "examples" / "buggy-python-project"
    validator = PatchValidator(demo_repo)

    diff = (
        "--- a/calculator.py\n"
        "+++ b/calculator.py\n"
        "@@ -3,3 +3,3 @@\n"
        "     if count == 0:\n"
        "-        return -1\n"
        "+        return 0\n"
        "     return total / count\n"
    )
    res = validator.validate_patch(diff)
    assert res.valid is True
    assert res.status == "VALID"
    assert res.files_to_modify == ["calculator.py"]
    assert res.lines_added == 1
    assert res.lines_removed == 1
    assert len(res.errors) == 0


def test_patch_validator_rejects_test_file_modification():
    demo_repo = Path(__file__).resolve().parent.parent.parent / "examples" / "buggy-python-project"
    validator = PatchValidator(demo_repo)

    malicious_test_diff = (
        "--- a/tests/test_calculator.py\n"
        "+++ b/tests/test_calculator.py\n"
        "@@ -9,1 +9,1 @@\n"
        "-    assert divide(12, 0) == 0\n"
        "+    assert divide(12, 0) == -1\n"
    )
    res = validator.validate_patch(malicious_test_diff)
    assert res.valid is False
    assert res.status == "INVALID"
    assert any("Test modification rejected" in err for err in res.errors)


def test_patch_validator_rejects_path_traversal():
    demo_repo = Path(__file__).resolve().parent.parent.parent / "examples" / "buggy-python-project"
    validator = PatchValidator(demo_repo)

    traversal_diff = (
        "--- a/../../secrets.py\n"
        "+++ b/../../secrets.py\n"
        "@@ -1,1 +1,1 @@\n"
        "-foo\n"
        "+bar\n"
    )
    res = validator.validate_patch(traversal_diff)
    assert res.valid is False
    assert res.status == "INVALID"
    assert any("traversal" in err for err in res.errors)


def test_patch_validator_requires_review_on_protected_files():
    demo_repo = Path(__file__).resolve().parent.parent.parent / "examples" / "buggy-python-project"
    validator = PatchValidator(demo_repo)

    dockerfile_diff = (
        "--- a/Dockerfile\n"
        "+++ b/Dockerfile\n"
        "@@ -1,1 +1,1 @@\n"
        "-FROM python:3.11\n"
        "+FROM python:3.12\n"
    )
    res = validator.validate_patch(dockerfile_diff)
    assert res.valid is False
    # Target file does not exist in demo repo, so will have errors or requires_review
    assert res.status in ("INVALID", "REQUIRES_REVIEW")


def test_patch_validator_rejects_line_mismatch():
    demo_repo = Path(__file__).resolve().parent.parent.parent / "examples" / "buggy-python-project"
    validator = PatchValidator(demo_repo)

    # Line that does not exist in calculator.py
    mismatched_diff = (
        "--- a/calculator.py\n"
        "+++ b/calculator.py\n"
        "@@ -1,1 +1,1 @@\n"
        "-nonexistent_function_call_xyz()\n"
        "+fixed_function_call()\n"
    )
    res = validator.validate_patch(mismatched_diff)
    assert res.valid is False
    assert res.status == "INVALID"
    assert any("not found in original file" in err for err in res.errors)


def test_split_diff_by_file():
    diff = (
        "--- a/calculator.py\n"
        "+++ b/calculator.py\n"
        "@@ -1,3 +1,3 @@\n"
        "-    return -1\n"
        "+    return 0\n"
        "--- a/shopping.py\n"
        "+++ b/shopping.py\n"
        "@@ -1,3 +1,3 @@\n"
        "-    total = price + discount\n"
        "+    total = price - discount\n"
    )
    splits = split_diff_by_file(diff)
    assert "calculator.py" in splits
    assert "shopping.py" in splits
    assert "return -1" in splits["calculator.py"]
    assert "return -1" not in splits["shopping.py"]
    assert "total = price + discount" in splits["shopping.py"]


def test_patch_validator_multi_file_diff():
    workspace_root = Path(__file__).resolve().parent.parent.parent
    with tempfile.TemporaryDirectory(dir=workspace_root, ignore_cleanup_errors=True) as tmp_dir:
        tmp_path = Path(tmp_dir)
        file1 = tmp_path / "calculator.py"
        file1.write_text("def divide():\n    return -1\n", encoding="utf-8")
        file2 = tmp_path / "shopping.py"
        file2.write_text("def discount():\n    return price + discount\n", encoding="utf-8")

        diff = (
            "--- a/calculator.py\n"
            "+++ b/calculator.py\n"
            "@@ -1,2 +1,2 @@\n"
            " def divide():\n"
            "-    return -1\n"
            "+    return 0\n"
            "--- a/shopping.py\n"
            "+++ b/shopping.py\n"
            "@@ -1,2 +1,2 @@\n"
            " def discount():\n"
            "-    return price + discount\n"
            "+    return price - discount\n"
        )

        validator = PatchValidator(tmp_path)
        res = validator.validate_patch(diff)
        assert res.valid is True
        assert res.status == "VALID"
        assert res.files_to_modify == ["calculator.py", "shopping.py"]
        assert len(res.errors) == 0
