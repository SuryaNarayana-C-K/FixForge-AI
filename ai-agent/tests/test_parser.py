from app.parser import PytestOutputParser, UnittestOutputParser


def test_pytest_output_parser_passed():
    stdout = """
============================= test session starts =============================
collected 5 items

tests/test_calc.py .....                                                 [100%]

============================== 5 passed in 0.05s ==============================
"""
    parsed = PytestOutputParser.parse(stdout=stdout, stderr="", exit_code=0, duration=0.05)
    assert parsed.status == "passed"
    assert parsed.total == 5
    assert parsed.passed == 5
    assert parsed.failed == 0
    assert len(parsed.failures) == 0


def test_pytest_output_parser_with_failures():
    stdout = """
============================= test session starts =============================
collected 10 items

tests/test_calc.py ...F.F....                                            [100%]

=================================== FAILURES ===================================
__________________________ test_divide_by_zero_is_safe __________________________

    def test_divide_by_zero_is_safe():
>       assert divide(12, 0) == 0
E       ZeroDivisionError: division by zero

tests/test_calculator.py:9: ZeroDivisionError
______________________________ test_invalid_range ______________________________

    def test_invalid_range():
>       assert clamp(10, 20, 5) == 10
E       ValueError: lower bound must not exceed upper bound

tests/test_calculator.py:18: ValueError
=========================== short test summary info ===========================
FAILED tests/test_calculator.py::test_divide_by_zero_is_safe - ZeroDivisionError
FAILED tests/test_calculator.py::test_invalid_range - ValueError
========================= 2 failed, 8 passed in 0.42s =========================
"""
    parsed = PytestOutputParser.parse(stdout=stdout, stderr="", exit_code=1, duration=0.42)
    assert parsed.status == "failed"
    assert parsed.total == 10
    assert parsed.passed == 8
    assert parsed.failed == 2
    assert len(parsed.failures) == 2

    f1 = parsed.failures[0]
    assert f1.test_name == "test_divide_by_zero_is_safe"
    assert f1.error_type == "ZeroDivisionError"
    assert "division by zero" in f1.message
    assert f1.source_reference == "tests/test_calculator.py:9"

    f2 = parsed.failures[1]
    assert f2.test_name == "test_invalid_range"
    assert f2.error_type == "ValueError"
    assert "lower bound must not exceed" in f2.message


def test_unittest_output_parser_failure():
    stderr = """
..F
======================================================================
FAIL: test_feature (tests.test_app.AppTests.test_feature)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "tests/test_app.py", line 12, in test_feature
    self.assertEqual(val, 100)
AssertionError: 50 != 100

----------------------------------------------------------------------
Ran 3 tests in 0.012s

FAILED (failures=1)
"""
    parsed = UnittestOutputParser.parse(stdout="", stderr=stderr, exit_code=1, duration=0.012)
    assert parsed.status == "failed"
    assert parsed.total == 3
    assert parsed.passed == 2
    assert parsed.failed == 1
    assert len(parsed.failures) == 1
    assert parsed.failures[0].error_type == "AssertionError"


def test_pytest_output_parser_exit_code_5_no_tests_collected():
    stdout = """
============================= test session starts =============================
platform win32 -- Python 3.14.2, pytest-9.1.1, pluggy-1.6.0
collected 0 items

============================ no tests ran in 0.07s ============================
"""
    parsed = PytestOutputParser.parse(stdout=stdout, stderr="", exit_code=5, duration=0.07)
    assert parsed.status == "failed"
    assert parsed.total == 0
    assert parsed.passed == 0
    assert parsed.failed == 0
    assert parsed.errors >= 1
    assert len(parsed.failures) >= 1
    assert parsed.failures[0].error_type == "EmptyTestCollectionError"


def test_pytest_output_parser_zero_collected_exit_code_0():
    stdout = """
============================= test session starts =============================
collected 0 items
============================ no tests ran in 0.01s ============================
"""
    parsed = PytestOutputParser.parse(stdout=stdout, stderr="", exit_code=0, duration=0.01)
    assert parsed.status == "failed"
    assert parsed.total == 0
    assert parsed.passed == 0
    assert parsed.errors >= 1
    assert parsed.failures[0].error_type == "EmptyTestCollectionError"


def test_pytest_output_parser_skipped_only_run():
    stdout = """
============================= test session starts =============================
collected 3 items

tests/test_calc.py sss                                                   [100%]
============================== 3 skipped in 0.05s ==============================
"""
    parsed = PytestOutputParser.parse(stdout=stdout, stderr="", exit_code=0, duration=0.05)
    assert parsed.status == "skipped_only"
    assert parsed.total == 3
    assert parsed.skipped == 3
    assert parsed.passed == 0
    assert parsed.errors >= 1
    assert parsed.failures[0].error_type == "SkippedOnlyRunError"


def test_pytest_output_parser_malformed_output():
    stdout = "Random crash garbage output without any pytest summaries"
    parsed = PytestOutputParser.parse(stdout=stdout, stderr="Segmentation fault", exit_code=139, duration=0.1)
    assert parsed.status == "failed"
    assert parsed.total == 0
    assert parsed.passed == 0
    assert len(parsed.failures) >= 1

