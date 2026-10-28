import re
from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class FailureSignature:
    test_name: str
    file: str
    error_type: str
    message: str
    traceback: str = ""
    source_reference: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ParsedBaselineResult:
    status: str  # "passed", "failed", "error", "timeout"
    framework: str
    command: str
    exit_code: int
    duration: float
    total: int = 0
    passed: int = 0
    failed: int = 0
    skipped: int = 0
    errors: int = 0
    failures: list[FailureSignature] = field(default_factory=list)
    stdout: str = ""
    stderr: str = ""

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["failures"] = [f.to_dict() if hasattr(f, "to_dict") else f for f in self.failures]
        return d


class PytestOutputParser:
    """Parses pytest terminal output into structured test metrics and failure signatures."""

    @staticmethod
    def parse(
        stdout: str,
        stderr: str,
        exit_code: int,
        duration: float,
        command: str = "pytest",
    ) -> ParsedBaselineResult:
        full_text = f"{stdout}\n{stderr}"

        passed = 0
        failed = 0
        skipped = 0
        errors = 0

        passed_m = re.search(r"(\d+)\s+passed", full_text)
        if passed_m:
            passed = int(passed_m.group(1))

        failed_m = re.search(r"(\d+)\s+failed", full_text)
        if failed_m:
            failed = int(failed_m.group(1))

        skipped_m = re.search(r"(\d+)\s+skipped", full_text)
        if skipped_m:
            skipped = int(skipped_m.group(1))

        errors_m = re.search(r"(\d+)\s+error(?:s)?", full_text)
        if errors_m:
            errors = int(errors_m.group(1))

        total = passed + failed + skipped + errors

        if total == 0:
            collected_m = re.search(r"collected\s+(\d+)\s+item", full_text)
            if collected_m:
                total = int(collected_m.group(1))
                if exit_code == 0 and total > 0:
                    passed = total

        executed = total - skipped
        if exit_code != 0:
            if exit_code == 5 or total == 0:
                status = "failed"
            elif errors > 0:
                status = "error"
            else:
                status = "failed"
        elif total == 0 or executed <= 0 or passed <= 0:
            if total > 0 and skipped == total:
                status = "skipped_only"
            else:
                status = "failed"
        elif failed > 0:
            status = "failed"
        elif errors > 0:
            status = "error"
        else:
            status = "passed"

        failures: list[FailureSignature] = []

        failure_blocks = re.findall(
            r"_{3,}\s*([^\s_]+.*?)\s*_{3,}(.*?)(?=(?:_{3,}|\Z|={3,}))",
            full_text,
            re.DOTALL,
        )

        for raw_name, body in failure_blocks:
            test_name = raw_name.strip()
            file_path = "tests"
            if "collecting " in test_name:
                parts = test_name.split("collecting ")
                file_path = parts[1].strip()
                test_name = f"CollectionError in {file_path}"

            lines = [line.rstrip() for line in body.strip().splitlines() if line.strip()]
            error_type = "AssertionError"
            message = ""
            source_ref = None

            e_lines = [l for l in lines if l.startswith("E   ") or l.startswith("E  ")]
            if e_lines:
                e_content = e_lines[0].lstrip("E ").strip()
                if ":" in e_content:
                    err_parts = e_content.split(":", 1)
                    error_type = err_parts[0].strip()
                    message = err_parts[1].strip()
                else:
                    error_type = e_content
                    message = e_content

            ref_match = re.search(r"([\w/\\]+\.py):(\d+)(?::\s*(\w+))?", body)
            if ref_match:
                file_path = ref_match.group(1).replace("\\", "/")
                line_no = ref_match.group(2)
                source_ref = f"{file_path}:{line_no}"
                if ref_match.group(3) and error_type == "AssertionError":
                    error_type = ref_match.group(3)

            if not message and lines:
                message = lines[-1].strip()

            failures.append(
                FailureSignature(
                    test_name=test_name,
                    file=file_path,
                    error_type=error_type,
                    message=message or "Test failed without explicit message",
                    traceback=body.strip()[:2000],
                    source_reference=source_ref,
                )
            )

        if (failed > 0 or errors > 0 or exit_code != 0 or total == 0 or (total > 0 and skipped == total and passed == 0)) and not failures:
            if exit_code == 5 or total == 0:
                failures.append(
                    FailureSignature(
                        test_name="TestCollection",
                        file="pytest",
                        error_type="EmptyTestCollectionError",
                        message=f"pytest exit code {exit_code}: zero tests were collected or executed.",
                        traceback=full_text[-1000:],
                    )
                )
                errors = max(errors, 1)
            elif total > 0 and skipped == total and passed == 0:
                failures.append(
                    FailureSignature(
                        test_name="TestExecution",
                        file="pytest",
                        error_type="SkippedOnlyRunError",
                        message="All collected tests were skipped; zero tests were executed.",
                        traceback=full_text[-1000:],
                    )
                )
                errors = max(errors, 1)
            else:
                err_line_m = re.search(r"(\w+Error):\s*(.+)", full_text)
                if err_line_m:
                    failures.append(
                        FailureSignature(
                            test_name="RuntimeError",
                            file="unknown",
                            error_type=err_line_m.group(1),
                            message=err_line_m.group(2).strip(),
                            traceback=full_text[-1000:],
                        )
                    )
                else:
                    failures.append(
                        FailureSignature(
                            test_name="TestExecution",
                            file="pytest",
                            error_type="NonZeroExitCodeError",
                            message=f"pytest exited with code {exit_code}.",
                            traceback=full_text[-1000:],
                        )
                    )
                errors = max(errors, 1)

        return ParsedBaselineResult(
            status=status,
            framework="pytest",
            command=command,
            exit_code=exit_code,
            duration=duration,
            total=total,
            passed=passed,
            failed=failed,
            skipped=skipped,
            errors=errors,
            failures=failures,
            stdout=stdout[:4000],
            stderr=stderr[:4000],
        )


class UnittestOutputParser:
    """Parses standard Python unittest output."""

    @staticmethod
    def parse(
        stdout: str,
        stderr: str,
        exit_code: int,
        duration: float,
        command: str = "python -m unittest",
    ) -> ParsedBaselineResult:
        full_text = f"{stdout}\n{stderr}"

        ran_m = re.search(r"Ran\s+(\d+)\s+tests?\s+in\s+([\d\.]+)s", full_text)
        total = int(ran_m.group(1)) if ran_m else 0

        failed = 0
        errors = 0

        fail_m = re.search(r"FAILED\s*\((.*?)\)", full_text)
        if fail_m:
            details = fail_m.group(1)
            f_m = re.search(r"failures=(\d+)", details)
            if f_m:
                failed = int(f_m.group(1))
            e_m = re.search(r"errors=(\d+)", details)
            if e_m:
                errors = int(e_m.group(1))

        passed = max(0, total - failed - errors)
        executed = total
        if exit_code == 0 and total > 0 and executed > 0 and passed > 0 and failed == 0 and errors == 0:
            status = "passed"
        else:
            status = "failed"

        failures: list[FailureSignature] = []
        if failed > 0 or errors > 0:
            blocks = re.findall(
                r"={5,}\r?\n\s*([^\n]+)\r?\n(?:-{5,}\r?\n)?(.*?)(?=(?:\r?\n={5,}|\r?\n-{5,}\r?\nRan \d+ tests|\Z))",
                full_text,
                re.DOTALL,
            )
            for title, body in blocks:
                test_name = title.strip()
                ref_match = re.search(r'File "([^"]+)", line (\d+)', body)
                source_ref = f"{ref_match.group(1)}:{ref_match.group(2)}" if ref_match else None
                file_path = ref_match.group(1) if ref_match else "unknown"

                err_lines = re.findall(r"^\s*(\w+Error|\w+Exception):\s*(.*)$", body, re.MULTILINE)
                if err_lines:
                    error_type = err_lines[-1][0].strip()
                    message = err_lines[-1][1].strip()
                else:
                    error_type = "AssertionError" if "FAIL:" in title else "Error"
                    message = "Test failed"

                failures.append(
                    FailureSignature(
                        test_name=test_name,
                        file=file_path.replace("\\", "/"),
                        error_type=error_type,
                        message=message,
                        traceback=body.strip()[:2000],
                        source_reference=source_ref,
                    )
                )

        if (total == 0 or exit_code != 0 or failed > 0 or errors > 0) and not failures:
            if total == 0:
                failures.append(
                    FailureSignature(
                        test_name="TestCollection",
                        file="unittest",
                        error_type="EmptyTestCollectionError",
                        message="unittest ran 0 tests.",
                        traceback=full_text[-1000:],
                    )
                )
                errors = max(errors, 1)
            elif exit_code != 0:
                failures.append(
                    FailureSignature(
                        test_name="TestExecution",
                        file="unittest",
                        error_type="NonZeroExitCodeError",
                        message=f"unittest exited with code {exit_code}.",
                        traceback=full_text[-1000:],
                    )
                )
                errors = max(errors, 1)

        return ParsedBaselineResult(
            status=status,
            framework="unittest",
            command=command,
            exit_code=exit_code,
            duration=duration,
            total=total,
            passed=passed,
            failed=failed,
            skipped=0,
            errors=errors,
            failures=failures,
            stdout=stdout[:4000],
            stderr=stderr[:4000],
        )


class JestOutputParser:
    """Parses Jest test runner terminal output into structured test metrics and failure signatures."""

    @staticmethod
    def parse(
        stdout: str,
        stderr: str,
        exit_code: int,
        duration: float,
        command: str = "npx jest",
    ) -> ParsedBaselineResult:
        full_text = f"{stdout}\n{stderr}"

        passed = 0
        failed = 0
        skipped = 0
        errors = 0
        total = 0

        # Parse test metrics from summary line: Tests: 1 failed, 4 passed, 5 total
        m_tests = re.search(r"Tests:\s*(.*)", full_text)
        if m_tests:
            line = m_tests.group(1)
            f_m = re.search(r"(\d+)\s+failed", line)
            if f_m:
                failed = int(f_m.group(1))
            p_m = re.search(r"(\d+)\s+passed", line)
            if p_m:
                passed = int(p_m.group(1))
            s_m = re.search(r"(\d+)\s+skipped", line)
            if s_m:
                skipped = int(s_m.group(1))
            t_m = re.search(r"(\d+)\s+total", line)
            if t_m:
                total = int(t_m.group(1))

        if total == 0:
            total = passed + failed + skipped
            if total == 0 and exit_code == 0:
                # Fallback: check pass indicators
                passes = len(re.findall(r"✓\s+", full_text))
                if passes > 0:
                    passed = passes
                    total = passes

        # Duration
        m_time = re.search(r"Time:\s*([\d\.]+)\s*s", full_text)
        if m_time:
            try:
                duration = float(m_time.group(1))
            except ValueError:
                pass

        executed = total - skipped
        if exit_code == 0 and total > 0 and executed > 0 and passed > 0 and failed == 0 and errors == 0:
            status = "passed"
        elif total > 0 and skipped == total and passed == 0:
            status = "skipped_only"
        else:
            status = "failed"

        failures: list[FailureSignature] = []
        # Parse failure blocks in Jest: starting with ●
        failure_blocks = re.findall(
            r"●\s+([^\n]+)\r?\n(.*?)(?=(?:\r?\n\s*●|\r?\n\s*Test Suites:|\r?\n\s*Tests:|\Z))",
            full_text,
            re.DOTALL,
        )

        for test_title, block_body in failure_blocks:
            test_name = test_title.strip()
            # Extract file and line from stack trace
            # e.g. at Object.<anonymous> (tests/calculator.test.js:15:27) or at tests/calculator.test.js:15:27
            ref_match = re.search(r"(?:at\s+.*?\s+\(|\bat\s+)([a-zA-Z0-9_\-\.\/\\\:]+\.[a-zA-Z0-9]+):(\d+):(\d+)", block_body)
            source_ref = None
            file_path = "tests/calculator.test.js"
            if ref_match:
                raw_file = ref_match.group(1).replace("\\", "/")
                line_num = ref_match.group(2)
                source_ref = f"{raw_file}:{line_num}"
                file_path = raw_file

            # Extract failure message (e.g. Expected: 0, Received: -1)
            msg_lines: list[str] = []
            for l in block_body.splitlines()[:15]:
                stripped = l.strip()
                if stripped.startswith("Expected") or stripped.startswith("Received") or "Error:" in stripped:
                    msg_lines.append(stripped)

            msg = "\n".join(msg_lines) if msg_lines else "Assertion failed in Jest test"

            failures.append(
                FailureSignature(
                    test_name=test_name,
                    file=file_path,
                    error_type="JestAssertionError" if "expect" in block_body.lower() else "Error",
                    message=msg,
                    traceback=block_body.strip()[:2000],
                    source_reference=source_ref,
                )
            )

        if (total == 0 or exit_code != 0 or failed > 0 or errors > 0) and not failures:
            if total == 0:
                failures.append(
                    FailureSignature(
                        test_name="TestCollection",
                        file="jest",
                        error_type="EmptyTestCollectionError",
                        message="Jest executed 0 tests.",
                        traceback=full_text[-1000:],
                    )
                )
                errors = max(errors, 1)
            elif exit_code != 0:
                failures.append(
                    FailureSignature(
                        test_name="TestExecution",
                        file="jest",
                        error_type="NonZeroExitCodeError",
                        message=f"Jest exited with code {exit_code}.",
                        traceback=full_text[-1000:],
                    )
                )
                errors = max(errors, 1)

        return ParsedBaselineResult(
            status=status,
            framework="jest",
            command=command,
            exit_code=exit_code,
            duration=duration,
            total=total,
            passed=passed,
            failed=failed,
            skipped=skipped,
            errors=errors,
            failures=failures,
            stdout=stdout[:4000],
            stderr=stderr[:4000],
        )


class VitestOutputParser:
    """Parses Vitest test runner output."""

    @staticmethod
    def parse(
        stdout: str,
        stderr: str,
        exit_code: int,
        duration: float,
        command: str = "npx vitest run",
    ) -> ParsedBaselineResult:
        full_text = f"{stdout}\n{stderr}"

        passed = 0
        failed = 0
        skipped = 0
        total = 0

        m_tests = re.search(r"(?:^|\n)\s*Tests\s+([^\n]*(?:failed|passed|total|\(\d+\))[^\n]*)", full_text)
        if m_tests:
            line = m_tests.group(1)
            f_m = re.search(r"(\d+)\s+failed", line)
            if f_m:
                failed = int(f_m.group(1))
            p_m = re.search(r"(\d+)\s+passed", line)
            if p_m:
                passed = int(p_m.group(1))
            s_m = re.search(r"(\d+)\s+skipped", line)
            if s_m:
                skipped = int(s_m.group(1))
            t_m = re.search(r"\((\d+)\)", line) or re.search(r"(\d+)\s+total", line)
            if t_m:
                total = int(t_m.group(1))

        if total == 0:
            total = passed + failed + skipped

        executed = total - skipped
        if exit_code == 0 and total > 0 and executed > 0 and passed > 0 and failed == 0:
            status = "passed"
        elif total > 0 and skipped == total and passed == 0:
            status = "skipped_only"
        else:
            status = "failed"

        failures: list[FailureSignature] = []
        fail_matches = re.findall(r"FAIL\s+([^\n>]+)\s*>\s*([^\n]+)\r?\n(.*?)(?=(?:\r?\nFAIL|\r?\nTest Files|\Z))", full_text, re.DOTALL)
        for file_ref, test_name, body in fail_matches:
            file_clean = file_ref.strip().replace("\\", "/")
            test_clean = test_name.strip()
            loc_m = re.search(r"([a-zA-Z0-9_\-\.\/]+):(\d+):(\d+)", body)
            source_ref = f"{loc_m.group(1)}:{loc_m.group(2)}" if loc_m else None
            failures.append(
                FailureSignature(
                    test_name=test_clean,
                    file=file_clean,
                    error_type="AssertionError",
                    message="Vitest assertion failed",
                    traceback=body.strip()[:2000],
                    source_reference=source_ref,
                )
            )

        if (total == 0 or exit_code != 0 or failed > 0) and not failures:
            if total == 0:
                failures.append(
                    FailureSignature(
                        test_name="TestCollection",
                        file="vitest",
                        error_type="EmptyTestCollectionError",
                        message="Vitest executed 0 tests.",
                        traceback=full_text[-1000:],
                    )
                )
            elif exit_code != 0:
                failures.append(
                    FailureSignature(
                        test_name="TestExecution",
                        file="vitest",
                        error_type="NonZeroExitCodeError",
                        message=f"Vitest exited with code {exit_code}.",
                        traceback=full_text[-1000:],
                    )
                )

        return ParsedBaselineResult(
            status=status,
            framework="vitest",
            command=command,
            exit_code=exit_code,
            duration=duration,
            total=total,
            passed=passed,
            failed=failed,
            skipped=skipped,
            errors=0,
            failures=failures,
            stdout=stdout[:4000],
            stderr=stderr[:4000],
        )


class JUnitOutputParser:
    """Parses JUnit test output (Maven/Gradle)."""

    @staticmethod
    def parse(
        stdout: str,
        stderr: str,
        exit_code: int,
        duration: float,
        command: str = "mvn test",
    ) -> ParsedBaselineResult:
        full_text = f"{stdout}\n{stderr}"

        passed = 0
        failed = 0
        errors = 0
        skipped = 0
        total = 0

        m_run = re.search(r"Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)", full_text)
        if m_run:
            total = int(m_run.group(1))
            failed = int(m_run.group(2))
            errors = int(m_run.group(3))
            skipped = int(m_run.group(4))
            passed = max(0, total - failed - errors - skipped)

        executed = total - skipped
        if exit_code == 0 and total > 0 and executed > 0 and passed > 0 and failed == 0 and errors == 0:
            status = "passed"
        elif total > 0 and skipped == total and passed == 0:
            status = "skipped_only"
        else:
            status = "failed"

        failures: list[FailureSignature] = []
        # Pattern 1: [ERROR] testDivideByZero(com.example.CalculatorTest)  Time elapsed: ... <<< FAILURE!
        m_surefire = re.findall(r"\[ERROR\]\s+([a-zA-Z0-9_]+)\(([a-zA-Z0-9_\.]+)\)[^<\n]*<<<\s*FAILURE!", full_text)
        for method_name, class_name in m_surefire:
            failures.append(
                FailureSignature(
                    test_name=f"{class_name}.{method_name}",
                    file="src/test/java/" + class_name.replace(".", "/") + ".java",
                    error_type="AssertionError",
                    message="JUnit test assertion failure",
                    traceback=full_text[full_text.find(method_name):full_text.find(method_name) + 400],
                    source_reference=f"{class_name}:{method_name}",
                )
            )

        # Pattern 2: [ERROR] target:line msg
        fail_lines = re.findall(r"\[ERROR\]\s+([a-zA-Z0-9_\.]+):(\d+)\s*(.*)", full_text)
        for test_target, line_num, msg in fail_lines:
            failures.append(
                FailureSignature(
                    test_name=test_target,
                    file="src/test/java/" + test_target.split(".")[0] + ".java",
                    error_type="AssertionError",
                    message=msg.strip() or "JUnit test assertion failure",
                    traceback=f"Line {line_num}: {msg}",
                    source_reference=f"{test_target}:{line_num}",
                )
            )

        if (total == 0 or exit_code != 0 or failed > 0 or errors > 0) and not failures:
            if total == 0:
                failures.append(
                    FailureSignature(
                        test_name="TestCollection",
                        file="junit",
                        error_type="EmptyTestCollectionError",
                        message="JUnit executed 0 tests.",
                        traceback=full_text[-1000:],
                    )
                )
                errors = max(errors, 1)
            elif exit_code != 0:
                failures.append(
                    FailureSignature(
                        test_name="TestExecution",
                        file="junit",
                        error_type="NonZeroExitCodeError",
                        message=f"JUnit test execution failed with exit code {exit_code}.",
                        traceback=full_text[-1000:],
                    )
                )
                errors = max(errors, 1)

        return ParsedBaselineResult(
            status=status,
            framework="junit",
            command=command,
            exit_code=exit_code,
            duration=duration,
            total=total,
            passed=passed,
            failed=failed,
            skipped=skipped,
            errors=errors,
            failures=failures,
            stdout=stdout[:4000],
            stderr=stderr[:4000],
        )


class NodeTestOutputParser:
    """Parses Node.js native test runner (node --test) output."""

    @staticmethod
    def parse(
        stdout: str,
        stderr: str,
        exit_code: int,
        duration: float,
        command: str = "node --test",
    ) -> ParsedBaselineResult:
        full_text = f"{stdout}\n{stderr}"
        total = 0
        passed = 0
        failed = 0
        skipped = 0
        errors = 0

        m_tests = re.search(r"ℹ tests\s+(\d+)", full_text)
        if m_tests:
            total = int(m_tests.group(1))
        m_pass = re.search(r"ℹ pass\s+(\d+)", full_text)
        if m_pass:
            passed = int(m_pass.group(1))
        m_fail = re.search(r"ℹ fail\s+(\d+)", full_text)
        if m_fail:
            failed = int(m_fail.group(1))
        m_skip = re.search(r"ℹ skipped\s+(\d+)", full_text)
        if m_skip:
            skipped = int(m_skip.group(1))

        if total == 0:
            passes = len(re.findall(r"^[ \t]*[✔\u2714]\s+", full_text, re.MULTILINE))
            fails = len(re.findall(r"^[ \t]*[✖\u2716]\s+", full_text, re.MULTILINE))
            passed = passes
            failed = fails
            total = passes + fails

        executed = total - skipped
        if exit_code == 0 and total > 0 and executed > 0 and passed > 0 and failed == 0 and errors == 0:
            status = "passed"
        elif total > 0 and skipped == total and passed == 0:
            status = "skipped_only"
        else:
            status = "failed"

        failures: list[FailureSignature] = []
        fail_matches = re.findall(r"^[ \t]*[✖\u2716]\s+([^\n]+)", full_text, re.MULTILINE)

        # Extract file locations from "test at <file>:<line>:<col>"
        test_loc_matches = re.findall(r"test at ([^\r\n:]+):(\d+)(?::\d+)?", full_text)
        file_loc_map: dict[str, str] = {}
        if test_loc_matches:
            for f_loc, line_no in test_loc_matches:
                clean_f = f_loc.strip().replace("\\", "/")
                file_loc_map[clean_f] = line_no

        # Extract stack trace file locations e.g. "at ... (file:///...)" or "at ... (path/file.js:12:34)"
        trace_file_matches = re.findall(
            r"(?:file:///|(?:\(|at\s+))([a-zA-Z]:[/\\][^\):\r\n]+|\.?[a-zA-Z0-9_\-\.\/\\]+\.(?:js|mjs|cjs|ts|tsx)):(\d+)",
            full_text,
            re.IGNORECASE,
        )

        seen_fail_names: set[str] = set()
        for idx, f_name in enumerate(fail_matches):
            clean_name = re.sub(r"\s*\(\d+[\.\d]*ms\)", "", f_name).strip()
            if not clean_name or clean_name.lower().startswith("failing tests"):
                continue
            if clean_name in seen_fail_names:
                continue
            seen_fail_names.add(clean_name)

            detected_file = "tests"
            source_ref = None

            if test_loc_matches and len(failures) < len(test_loc_matches):
                f_path, l_num = test_loc_matches[len(failures)]
                detected_file = f_path.strip().replace("\\", "/")
                source_ref = f"{detected_file}:{l_num}"
            elif trace_file_matches:
                for tf_path, tf_line in trace_file_matches:
                    tf_clean = tf_path.strip().replace("\\", "/")
                    if "node:" not in tf_clean and "node_modules" not in tf_clean:
                        detected_file = tf_clean
                        source_ref = f"{detected_file}:{tf_line}"
                        break

            failures.append(
                FailureSignature(
                    test_name=clean_name,
                    file=detected_file,
                    error_type="AssertionError",
                    message=f"Node test failed: {clean_name}",
                    traceback=full_text[-1500:],
                    source_reference=source_ref,
                )
            )

        if (total == 0 or exit_code != 0 or failed > 0) and not failures:
            failures.append(
                FailureSignature(
                    test_name="TestExecution",
                    file="node",
                    error_type="NonZeroExitCodeError",
                    message=f"Node test execution exited with code {exit_code}",
                    traceback=full_text[-1000:],
                )
            )
            errors = max(errors, 1)

        return ParsedBaselineResult(
            status=status,
            framework="node_test",
            command=command,
            exit_code=exit_code,
            duration=duration,
            total=total,
            passed=passed,
            failed=failed,
            skipped=skipped,
            errors=errors,
            failures=failures,
            stdout=stdout[:4000],
            stderr=stderr[:4000],
        )


def get_test_parser(framework: str):
    """Retrieve the output parser corresponding to the specified framework."""
    fw = framework.lower().strip() if framework else "pytest"
    if fw == "unittest":
        return UnittestOutputParser
    if fw in ("node_test", "node", "node:test"):
        return NodeTestOutputParser
    if fw in ("jest", "javascript", "js"):
        return JestOutputParser
    if fw == "vitest":
        return VitestOutputParser
    if fw in ("junit", "java", "maven", "gradle"):
        return JUnitOutputParser
    return PytestOutputParser
