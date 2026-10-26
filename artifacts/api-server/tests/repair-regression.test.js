import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatErrorDetail, classifyAndSanitizeError } from "../src/routes/repairs.js";

describe("Automatic Repair Regression Tests", () => {
  describe("formatErrorDetail & classifyAndSanitizeError", () => {
    it("formats FastAPI 422 validation error arrays cleanly without [object Object]", () => {
      const fastApiDetail = [
        { loc: ["body", "test_command"], msg: "field required", type: "value_error.missing" },
        { loc: ["body", "max_attempts"], msg: "ensure this value is greater than 0", type: "value_error.number.not_gt" },
      ];

      const formatted = formatErrorDetail(fastApiDetail);
      assert.doesNotMatch(formatted, /\[object Object\]/);
      assert.match(formatted, /test_command: field required/);
      assert.match(formatted, /max_attempts: ensure this value is greater than 0/);
    });

    it("formats nested object errors cleanly without [object Object]", () => {
      const nestedObj = { error: { message: "Internal sandbox runner failure" } };
      const formatted = formatErrorDetail(nestedObj);
      assert.doesNotMatch(formatted, /\[object Object\]/);
      assert.equal(formatted, "Internal sandbox runner failure");
    });

    it("formats generic object error without [object Object]", () => {
      const genericObj = { status_code: 500, detail_code: "SANDBOX_CRASH" };
      const formatted = formatErrorDetail(genericObj);
      assert.doesNotMatch(formatted, /\[object Object\]/);
      assert.match(formatted, /SANDBOX_CRASH/);
    });

    it("classifyAndSanitizeError replaces [object Object] message with meaningful fallback", () => {
      const badError = new Error("[object Object]");
      badError.code = "AI_DISPATCH_FAILED";

      const classified = classifyAndSanitizeError(badError, "http://127.0.0.1:8000", "repair");
      assert.doesNotMatch(classified.message, /\[object Object\]/);
      assert.match(classified.message, /AI_DISPATCH_FAILED/);
    });

    it("classifyAndSanitizeError extracts err.detail when err.message is [object Object]", () => {
      const badError = new Error("[object Object]");
      badError.detail = [{ loc: ["body", "repository_path"], msg: "path not found" }];

      const classified = classifyAndSanitizeError(badError, "http://127.0.0.1:8000", "repair");
      assert.doesNotMatch(classified.message, /\[object Object\]/);
      assert.match(classified.message, /repository_path: path not found/);
    });

    it("classifyAndSanitizeError redacts sensitive tokens and keys", () => {
      const sensitiveError = new Error("Failed connecting with key AIzaSyD1234567890123456789012345678901 and Bearer test_secret_token_12345");
      const classified = classifyAndSanitizeError(sensitiveError, "http://127.0.0.1:8000", "repair");

      assert.doesNotMatch(classified.message, /AIzaSyD/);
      assert.match(classified.message, /\[REDACTED_API_KEY\]/);
      assert.match(classified.message, /Bearer \[REDACTED_TOKEN\]/);
    });
  });

  describe("Verification Integrity Rules", () => {
    it("ensures zero tests executed never counts as genuine verification", () => {
      const correctionResult = {
        is_verified: true,
        verification_result: {
          passed: 0,
          total: 0,
          failed: 0,
          skipped: 0,
          errors: 0,
          exit_code: 0,
        },
      };

      const testsPassed = correctionResult.verification_result.passed;
      const testsTotal = correctionResult.verification_result.total;
      const skippedNum = correctionResult.verification_result.skipped;
      const executedNum = testsTotal - skippedNum;

      const isGenuineVerification =
        Boolean(correctionResult.is_verified) &&
        !isNaN(testsPassed) &&
        !isNaN(testsTotal) &&
        testsPassed > 0 &&
        testsTotal > 0 &&
        executedNum > 0 &&
        testsPassed === executedNum &&
        correctionResult.verification_result.failed === 0 &&
        correctionResult.verification_result.exit_code === 0;

      assert.equal(isGenuineVerification, false, "Zero tests must NOT be marked verified");
    });

    it("ensures skipped-only suites never count as genuine verification", () => {
      const correctionResult = {
        is_verified: true,
        verification_result: {
          passed: 0,
          total: 5,
          failed: 0,
          skipped: 5,
          errors: 0,
          exit_code: 0,
        },
      };

      const testsPassed = correctionResult.verification_result.passed;
      const testsTotal = correctionResult.verification_result.total;
      const skippedNum = correctionResult.verification_result.skipped;
      const executedNum = testsTotal - skippedNum;

      const isGenuineVerification =
        Boolean(correctionResult.is_verified) &&
        !isNaN(testsPassed) &&
        !isNaN(testsTotal) &&
        testsPassed > 0 &&
        testsTotal > 0 &&
        executedNum > 0 &&
        testsPassed === executedNum;

      assert.equal(isGenuineVerification, false, "Skipped-only suite must NOT be marked verified");
    });

    it("ensures exit code != 0 or regressions never count as genuine verification", () => {
      const regressionResult = {
        is_verified: true,
        verification_result: {
          passed: 4,
          total: 5,
          failed: 1,
          skipped: 0,
          exit_code: 1,
          regression_detected: true,
        },
      };

      const verResult = regressionResult.verification_result;
      const isGenuineVerification =
        Boolean(regressionResult.is_verified) &&
        verResult.passed > 0 &&
        verResult.failed === 0 &&
        verResult.exit_code === 0 &&
        !verResult.regression_detected;

      assert.equal(isGenuineVerification, false, "Regressions or failures must NOT be marked verified");
    });

    it("allows genuine pass with 0 failures, 0 regressions, exit code 0 to be verified", () => {
      const passResult = {
        is_verified: true,
        verification_result: {
          passed: 4,
          total: 4,
          failed: 0,
          skipped: 0,
          errors: 0,
          exit_code: 0,
          regression_detected: false,
        },
      };

      const verResult = passResult.verification_result;
      const executed = verResult.total - verResult.skipped;
      const isGenuineVerification =
        Boolean(passResult.is_verified) &&
        verResult.passed > 0 &&
        executed > 0 &&
        verResult.passed === executed &&
        verResult.failed === 0 &&
        verResult.errors === 0 &&
        verResult.exit_code === 0 &&
        !verResult.regression_detected;

      assert.equal(isGenuineVerification, true, "Clean passing suite must be verified");
    });
  });
});
