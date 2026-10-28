from pathlib import Path

from app.context.code_context import is_test_path, load_file_context
from app.context.config import ContextBudget
from app.context.context_selector import ContextSelector


def test_is_test_path():
    assert is_test_path("tests/test_calc.py") is True
    assert is_test_path("src/tests/helper.py") is True
    assert is_test_path("test_service.py") is True
    assert is_test_path("service_test.py") is True
    assert is_test_path("calculator.py") is False
    assert is_test_path("src/core/utils.py") is False


def test_extract_file_references_from_traceback():
    selector = ContextSelector()
    tb = (
        'Traceback (most recent call last):\n'
        '  File "tests/test_calculator.py", line 9, in test_divide_by_zero_is_safe\n'
        '    assert divide(12, 0) == 0\n'
        '  File "calculator.py", line 4, in divide\n'
        '    return -1\n'
        'AssertionError: assert -1 == 0\n'
    )
    refs = selector.extract_file_references_from_traceback(tb)
    assert len(refs) == 2
    assert refs[0] == ("tests/test_calculator.py", 9)
    assert refs[1] == ("calculator.py", 4)


def test_select_context_on_demo_repo():
    workspace_root = Path(__file__).resolve().parent.parent.parent / "examples" / "buggy-python-project"
    selector = ContextSelector()
    failures = [
        {
            "test_name": "tests/test_calculator.py::test_divide_by_zero_is_safe",
            "file": "tests/test_calculator.py",
            "error_type": "AssertionError",
            "message": "assert -1 == 0",
            "traceback": (
                '  File "tests/test_calculator.py", line 9, in test_divide_by_zero_is_safe\n'
                '    assert divide(12, 0) == 0\n'
                '  File "calculator.py", line 4, in divide\n'
                '    return -1\n'
            ),
        }
    ]

    selected = selector.select_context(workspace_root=workspace_root, failures=failures)
    assert selected.focal_test_file == "tests/test_calculator.py"
    assert "calculator.py" in selected.focal_source_files
    assert "calculator.py" in selected.file_contexts
    assert "tests/test_calculator.py" in selected.file_contexts

    calc_context = selected.file_contexts["calculator.py"]
    assert calc_context.is_test_file is False
    assert 4 in calc_context.focal_lines

    prompt_formatted = selected.format_prompt_context()
    assert "calculator.py" in prompt_formatted
    assert "TEST FILE (READ-ONLY)" in prompt_formatted
    assert "SOURCE FILE (TARGET FOR FIX)" in prompt_formatted


def test_context_budget_enforcement():
    workspace_root = Path(__file__).resolve().parent.parent.parent / "examples" / "buggy-python-project"
    # Set a tiny budget of 1 file and 200 chars
    tight_budget = ContextBudget(max_context_files=1, max_context_chars=300)
    selector = ContextSelector(budget=tight_budget)
    failures = [
        {
            "test_name": "test_dummy",
            "file": "tests/test_calculator.py",
            "traceback": 'File "calculator.py", line 4',
        }
    ]
    selected = selector.select_context(workspace_root=workspace_root, failures=failures)
    # Should only load at most 1 file
    assert len(selected.file_contexts) <= 1
