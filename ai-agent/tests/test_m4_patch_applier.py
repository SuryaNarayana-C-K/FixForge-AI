from pathlib import Path
import shutil
import tempfile

from app.patch.applier import PatchApplier, apply_hunks_to_content


def test_apply_hunks_to_content():
    orig = (
        "def divide(total: float, count: int) -> float:\n"
        "    if count == 0:\n"
        "        return -1\n"
        "    return total / count\n"
    )
    diff = (
        "--- a/calc.py\n"
        "+++ b/calc.py\n"
        "@@ -3,1 +3,1 @@\n"
        "-        return -1\n"
        "+        return 0\n"
    )
    result = apply_hunks_to_content(orig, diff)
    assert "return 0" in result
    assert "return -1" not in result


def test_patch_applier_lifecycle_on_temp_dir():
    # Setup temporary directory containing a copy of calculator.py
    workspace_root = Path(__file__).resolve().parent.parent.parent
    demo_repo = workspace_root / "examples" / "buggy-python-project"

    with tempfile.TemporaryDirectory(dir=workspace_root, ignore_cleanup_errors=True) as tmp_dir:
        tmp_path = Path(tmp_dir)
        # Copy demo files
        for f in demo_repo.iterdir():
            if f.is_file():
                shutil.copy(f, tmp_path / f.name)
            elif f.is_dir() and f.name != "__pycache__":
                shutil.copytree(f, tmp_path / f.name)

        calc_file = tmp_path / "calculator.py"
        assert "return -1" in calc_file.read_text(encoding="utf-8")

        diff = (
            "--- a/calculator.py\n"
            "+++ b/calculator.py\n"
            "@@ -3,3 +3,3 @@\n"
            "     if count == 0:\n"
            "-        return -1\n"
            "+        return 0\n"
            "     return total / count\n"
        )

        applier = PatchApplier(tmp_path)
        app_res = applier.apply_patch(diff)

        assert app_res.applied is True
        assert app_res.status == "APPLIED"
        assert "calculator.py" in app_res.files_modified
        assert app_res.backup_id is not None

        # Verify calculator.py was actually updated
        updated_content = calc_file.read_text(encoding="utf-8")
        assert "return 0" in updated_content
        assert "return -1" not in updated_content


def test_patch_applier_rollback_on_failure():
    workspace_root = Path(__file__).resolve().parent.parent.parent
    demo_repo = workspace_root / "examples" / "buggy-python-project"

    with tempfile.TemporaryDirectory(dir=workspace_root, ignore_cleanup_errors=True) as tmp_dir:
        tmp_path = Path(tmp_dir)
        for f in demo_repo.iterdir():
            if f.is_file():
                shutil.copy(f, tmp_path / f.name)

        calc_file = tmp_path / "calculator.py"
        orig_content = calc_file.read_text(encoding="utf-8")

        # Invalid patch targeting a test file (which is rejected by validator)
        bad_diff = (
            "--- a/tests/test_calculator.py\n"
            "+++ b/tests/test_calculator.py\n"
            "@@ -1,1 +1,1 @@\n"
            "-foo\n"
            "+bar\n"
        )

        applier = PatchApplier(tmp_path)
        app_res = applier.apply_patch(bad_diff)

        assert app_res.applied is False
        assert app_res.status == "FAILED"
        # Content untouched
        assert calc_file.read_text(encoding="utf-8") == orig_content


def test_apply_hunks_to_content_multi_hunk():
    content = (
        "def first():\n"
        "    return -1\n"
        "\n"
        "def middle():\n"
        "    return 42\n"
        "\n"
        "def second():\n"
        "    return False\n"
    )
    diff = (
        "--- a/module.py\n"
        "+++ b/module.py\n"
        "@@ -1,3 +1,3 @@\n"
        " def first():\n"
        "-    return -1\n"
        "+    return 1\n"
        "@@ -6,3 +6,3 @@\n"
        " def second():\n"
        "-    return False\n"
        "+    return True\n"
    )
    res = apply_hunks_to_content(content, diff)
    assert "return 1" in res
    assert "return True" in res
    assert "return 42" in res
    assert "return -1" not in res
    assert "return False" not in res


def test_patch_applier_multi_file_patch():
    workspace_root = Path(__file__).resolve().parent.parent.parent
    with tempfile.TemporaryDirectory(dir=workspace_root, ignore_cleanup_errors=True) as tmp_dir:
        tmp_path = Path(tmp_dir)
        f1 = tmp_path / "calculator.py"
        f1.write_text("def divide():\n    return -1\n", encoding="utf-8")
        f2 = tmp_path / "shopping.py"
        f2.write_text("def discount():\n    return price + discount\n", encoding="utf-8")

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

        applier = PatchApplier(tmp_path)
        res = applier.apply_patch(diff)
        assert res.applied is True
        assert res.status == "APPLIED"
        assert "calculator.py" in res.files_modified
        assert "shopping.py" in res.files_modified
        assert "return 0" in f1.read_text(encoding="utf-8")
        assert "return price - discount" in f2.read_text(encoding="utf-8")
