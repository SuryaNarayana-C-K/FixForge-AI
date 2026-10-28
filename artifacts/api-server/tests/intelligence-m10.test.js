import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import app from "../src/app.js";
import { prisma, seedDatabase } from "@workspace/db";
import { RepairConfidenceService } from "../src/services/intelligence/confidence-service.js";
import { PatchQualityAnalyzer } from "../src/services/intelligence/patch-quality-service.js";
import { PatchRiskAnalyzer } from "../src/services/intelligence/patch-risk-service.js";
import { classifyFailure, extractErrorSignature, FAILURE_CATEGORIES } from "../src/services/intelligence/failure-intelligence-service.js";
import { RepairPlannerService, REPAIR_STRATEGIES } from "../src/services/intelligence/repair-planner-service.js";
import { RepairMemoryService } from "../src/services/intelligence/repair-memory-service.js";
import { RegressionIntelligenceService } from "../src/services/intelligence/regression-service.js";
import { ReportGenerator } from "../src/services/intelligence/report-generator.js";

describe("FixForge Milestone 10: Advanced Repair Intelligence & Production Readiness", () => {
  let server;
  let baseUrl;
  let adminToken;
  let developerToken;
  let viewerToken;

  before(async () => {
    await seedDatabase();

    await new Promise((resolve) => {
      server = http.createServer(app);
      server.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    const login = async (email, password) => {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      return data.token;
    };

    adminToken = await login("admin@fixforge.local", "DemoAdmin123!");
    developerToken = await login("developer@fixforge.local", "DemoDeveloper123!");
    viewerToken = await login("viewer@fixforge.local", "DemoViewer123!");
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // ==========================================
  // PART 1: REPAIR CONFIDENCE SERVICE
  // ==========================================
  describe("Part 1: Repair Confidence Engine", () => {
    it("calculates HIGH confidence for 100% verified single-attempt repair", () => {
      const result = RepairConfidenceService.calculateConfidence({
        verificationResult: { success: true, passed: 5, total: 5 },
        baselineResult: { passed: 4, total: 5 },
        attemptsCount: 1,
        regressionDetected: false,
        filesChanged: ["calculator.py"],
        linesChanged: 4,
        rootCauseCertainty: "HIGH",
        patchValid: true,
      });

      assert.ok(result.score >= 0.85, `Expected score >= 0.85, got ${result.score}`);
      assert.equal(result.level, "HIGH");
      assert.ok(Array.isArray(result.reasons));
      assert.ok(result.reasons.some((r) => r.includes("All verification tests passed")));
      assert.ok(result.reasons.some((r) => r.includes("No regressions detected")));
    });

    it("calculates LOW confidence when verification tests fail", () => {
      const result = RepairConfidenceService.calculateConfidence({
        verificationResult: { success: false, passed: 3, total: 5 },
        baselineResult: { passed: 4, total: 5 },
        attemptsCount: 3,
        regressionDetected: true,
        filesChanged: ["a.py", "b.py", "c.py"],
        linesChanged: 80,
        rootCauseCertainty: "LOW",
        patchValid: false,
      });

      assert.ok(result.score <= 0.45, `Expected score <= 0.45, got ${result.score}`);
      assert.equal(result.level, "LOW");
      assert.ok(result.reasons.some((r) => r.includes("failing")));
    });

    it("penalizes confidence when regressions occur", () => {
      const noReg = RepairConfidenceService.calculateConfidence({
        verificationResult: { success: true, passed: 5, total: 5 },
        baselineResult: { passed: 4, total: 5 },
        attemptsCount: 1,
        regressionDetected: false,
      });

      const withReg = RepairConfidenceService.calculateConfidence({
        verificationResult: { success: true, passed: 5, total: 5 },
        baselineResult: { passed: 4, total: 5 },
        attemptsCount: 1,
        regressionDetected: true,
      });

      assert.ok(noReg.score > withReg.score);
      assert.ok(withReg.reasons.some((r) => r.includes("Regression detected")));
    });
  });

  // ==========================================
  // PART 2: PATCH QUALITY ANALYZER
  // ==========================================
  describe("Part 2: Patch Quality Analyzer", () => {
    it("approves clean diff modifying single source file", () => {
      const cleanDiff = `--- a/calculator.py\n+++ b/calculator.py\n@@ -10,3 +10,4 @@\n def divide(a, b):\n+    if b == 0: raise ZeroDivisionError("Cannot divide by zero")\n     return a / b\n`;
      const quality = PatchQualityAnalyzer.analyze(cleanDiff);

      assert.equal(quality.quality, "HIGH");
      assert.equal(quality.isAcceptable, true);
      assert.equal(quality.metrics.filesChanged, 1);
      assert.equal(quality.metrics.testFilesChanged, 0);
      assert.equal(quality.metrics.protectedFilesTouched, 0);
    });

    it("rejects patch containing dangerous code patterns (eval, exec)", () => {
      const dangerousDiff = `--- a/service.py\n+++ b/service.py\n@@ -5,2 +5,3 @@\n+    eval(user_payload)\n+    import os; os.system("rm -rf /")\n`;
      const quality = PatchQualityAnalyzer.analyze(dangerousDiff);

      assert.equal(quality.isAcceptable, false);
      assert.equal(quality.quality, "REJECTED");
      assert.ok(quality.violations.length > 0);
      assert.ok(quality.violations.some((v) => v.includes("Dangerous pattern")));
    });

    it("flags patch that modifies test files or environment files", () => {
      const envDiff = `--- a/.env\n+++ b/.env\n@@ -1,2 +1,3 @@\n+SECRET_KEY=leaked\n`;
      const quality = PatchQualityAnalyzer.analyze(envDiff);

      assert.equal(quality.isAcceptable, false);
      assert.ok(quality.violations.some((v) => v.includes("Sensitive") || v.includes("protected")));
    });
  });

  // ==========================================
  // PART 3: PATCH RISK ANALYZER
  // ==========================================
  describe("Part 3: Patch Risk Analyzer", () => {
    it("scores LOW risk for minimal localized bugfix", () => {
      const risk = PatchRiskAnalyzer.analyze({
        filesChanged: ["utils.py"],
        linesAdded: 2,
        linesRemoved: 1,
        diff: `--- a/utils.py\n+++ b/utils.py\n@@ -1 +1,2 @@\n-return x\n+return x or 0\n`,
      });

      assert.equal(risk.level, "LOW");
      assert.ok(risk.riskScore < 0.35);
      assert.ok(Array.isArray(risk.reasons));
    });

    it("scores HIGH risk for multi-file blast radius touching package configs", () => {
      const risk = PatchRiskAnalyzer.analyze({
        filesChanged: ["package.json", "src/auth.js", "src/db.js", "src/server.js", "config/settings.py"],
        linesAdded: 150,
        linesRemoved: 80,
      });

      assert.equal(risk.level, "HIGH");
      assert.ok(risk.riskScore >= 0.65);
      assert.ok(risk.reasons.some((r) => r.includes("configuration") || r.includes("dependency") || r.includes("Broad blast radius")));
    });

    it("demonstrates orthogonal nature of Confidence and Risk", () => {
      // High confidence (tests pass cleanly) but High risk (broad diff)
      const confidence = RepairConfidenceService.calculateConfidence({
        verificationResult: { success: true, passed: 50, total: 50 },
        baselineResult: { passed: 48, total: 50 },
        attemptsCount: 1,
        regressionDetected: false,
      });

      const risk = PatchRiskAnalyzer.analyze({
        filesChanged: ["package.json", "index.js", "api.js"],
        linesAdded: 200,
        linesRemoved: 50,
      });

      assert.equal(confidence.level, "HIGH");
      assert.equal(risk.level, "HIGH");
    });
  });

  // ==========================================
  // PART 4 & 6: FAILURE PATTERN & ROOT CAUSE INTELLIGENCE
  // ==========================================
  describe("Part 4 & 6: Failure Pattern Intelligence", () => {
    it("deterministically classifies common failure types", () => {
      assert.equal(classifyFailure("ZeroDivisionError: division by zero"), FAILURE_CATEGORIES.DIVISION_BY_ZERO);
      assert.equal(classifyFailure("TypeError: Cannot read properties of undefined (reading 'id')"), FAILURE_CATEGORIES.NULL_REFERENCE);
      assert.equal(classifyFailure("TypeError: unsupported operand type(s) for +: 'int' and 'str'"), FAILURE_CATEGORIES.TYPE_ERROR);
      assert.equal(classifyFailure("IndexError: list index out of range"), FAILURE_CATEGORIES.INDEX_ERROR);
      assert.equal(classifyFailure("AssertionError: expected 5 to equal 10"), FAILURE_CATEGORIES.ASSERTION_FAILURE);
      assert.equal(classifyFailure("ModuleNotFoundError: No module named 'flask'"), FAILURE_CATEGORIES.IMPORT_ERROR);
      assert.equal(classifyFailure("ETIMEDOUT: Connection timed out"), FAILURE_CATEGORIES.TIMEOUT);
    });

    it("falls back to UNKNOWN when evidence is ambiguous (no hallucination)", () => {
      assert.equal(classifyFailure("some obscure unparseable string"), FAILURE_CATEGORIES.UNKNOWN);
      assert.equal(classifyFailure(""), FAILURE_CATEGORIES.UNKNOWN);
    });

    it("extracts standardized error signature for memory indexing", () => {
      const sig = extractErrorSignature("ZeroDivisionError: division by zero in calculate_rate()");
      assert.ok(sig.length > 0);
      assert.ok(!sig.includes("\n"));
    });
  });

  // ==========================================
  // PART 5: REPAIR MEMORY SERVICE (SQLITE)
  // ==========================================
  describe("Part 5: Advisory Repair Memory", () => {
    it("stores and retrieves historical repair memory advisory data", async () => {
      const entry = await RepairMemoryService.recordRepairMemory({
        language: "Python",
        framework: "pytest",
        failureCategory: "DIVISION_BY_ZERO",
        errorSignature: "ZeroDivisionError: division by zero",
        rootCauseCategory: "GUARD_CLAUSE",
        patchStrategy: "GUARD_CLAUSE",
        verificationOutcome: "verified",
        attemptCount: 1,
        confidenceScore: 0.94,
        patchRiskScore: 0.12,
        organizationId: "org_fixforge",
      });

      assert.ok(entry.id);
      assert.equal(entry.failureCategory, "DIVISION_BY_ZERO");

      const similar = await RepairMemoryService.findSimilarRepairs({
        language: "Python",
        failureCategory: "DIVISION_BY_ZERO",
        organizationId: "org_fixforge",
      });

      assert.ok(Array.isArray(similar));
      assert.ok(similar.length > 0);
      assert.equal(similar[0].language, "Python");
      assert.equal(similar[0].failureCategory, "DIVISION_BY_ZERO");
    });
  });

  // ==========================================
  // PART 8 & 10: REPAIR PLANNER & ADAPTIVE STRATEGY
  // ==========================================
  describe("Part 8 & 10: Intelligent Repair Decision & Adaptive Strategies", () => {
    it("generates structured RepairPlan prior to patch execution", async () => {
      const plan = await RepairPlannerService.createPlan({
        issue: "Division by zero on empty input array",
        analysis: { candidate_files: ["calc.py"], root_cause: "Missing divisor validation" },
        failures: [{ message: "ZeroDivisionError: division by zero" }],
        language: "Python",
        framework: "pytest",
        organizationId: "org_fixforge",
      });

      assert.ok(plan);
      assert.equal(plan.failureCategory, FAILURE_CATEGORIES.DIVISION_BY_ZERO);
      assert.equal(plan.strategy, REPAIR_STRATEGIES.GUARD_CLAUSE);
      assert.ok(["HIGH", "MEDIUM"].includes(plan.rootCauseCertainty.certainty));
      assert.ok(Array.isArray(plan.filesLikelyToChange));
      assert.ok(plan.expectedVerificationCriteria.includes("100%"));
    });

    it("adapts strategy between attempts without repetition", () => {
      const adapted = RepairPlannerService.adaptStrategy({
        previousStrategy: REPAIR_STRATEGIES.DIRECT_PATCH,
        failureText: "TypeError: Object is possibly null",
        previousAttemptsCount: 1,
      });

      assert.notEqual(adapted.newStrategy, REPAIR_STRATEGIES.DIRECT_PATCH);
      assert.equal(adapted.newStrategy, REPAIR_STRATEGIES.NULL_CHECK);
      assert.ok(adapted.reasonForChange.includes("Adapted"));
    });
  });

  // ==========================================
  // PART 11: REGRESSION INTELLIGENCE
  // ==========================================
  describe("Part 11: Regression Intelligence", () => {
    it("detects regression when passing test count regresses", () => {
      const baseline = { passed: 4, total: 5, failedTests: ["test_div_zero"] };
      const verification = { passed: 3, total: 5, failedTests: ["test_add", "test_div_zero"] };

      const reg = RegressionIntelligenceService.analyzeRegression({
        baselineResult: baseline,
        verificationResult: verification,
        filesChanged: ["calculator.py"],
      });

      assert.equal(reg.regressionDetected, true);
      assert.equal(reg.status, "REGRESSION_DETECTED");
      assert.ok(reg.newlyFailingTests.includes("test_add"));
      assert.ok(reg.explanation.includes("introduced a regression"));
    });

    it("verifies clean progression when all baseline tests pass", () => {
      const baseline = { passed: 4, total: 5, failedTests: ["test_div_zero"] };
      const verification = { passed: 5, total: 5, failedTests: [] };

      const reg = RegressionIntelligenceService.analyzeRegression({
        baselineResult: baseline,
        verificationResult: verification,
      });

      assert.equal(reg.regressionDetected, false);
      assert.equal(reg.status, "VERIFIED");
      assert.equal(reg.newlyFailingTests.length, 0);
    });
  });

  // ==========================================
  // PART 13 & 14: PRODUCTION HEALTH & DIAGNOSTICS
  // ==========================================
  describe("Part 13 & 14: Production Health and Admin Diagnostics", () => {
    it("GET /api/system/health returns system status without secret exposure", async () => {
      const res = await fetch(`${baseUrl}/api/system/health`);
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.ok(data.status === "healthy" || data.status === "degraded");
      assert.equal(data.components.api, "healthy");
      assert.equal(data.components.database, "healthy");
      assert.ok(data.components.runner);
      assert.ok(data.components.github);

      // Verify ZERO secrets exposed in response body
      const jsonStr = JSON.stringify(data);
      assert.ok(!jsonStr.includes("ghp_"));
      assert.ok(!jsonStr.includes("sk-"));
      assert.ok(!jsonStr.includes("AIzaSy"));
    });

    it("GET /api/system/diagnostics requires ADMIN role", async () => {
      // Unauthenticated
      const anonRes = await fetch(`${baseUrl}/api/system/diagnostics`);
      assert.equal(anonRes.status, 401);

      // Developer role (forbidden)
      const devRes = await fetch(`${baseUrl}/api/system/diagnostics`, {
        headers: { Authorization: `Bearer ${developerToken}` },
      });
      assert.equal(devRes.status, 403);

      // Viewer role (forbidden)
      const viewerRes = await fetch(`${baseUrl}/api/system/diagnostics`, {
        headers: { Authorization: `Bearer ${viewerToken}` },
      });
      assert.equal(viewerRes.status, 403);

      // Admin role (allowed)
      const adminRes = await fetch(`${baseUrl}/api/system/diagnostics`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.equal(adminRes.status, 200);

      const diag = await adminRes.json();
      assert.ok(diag.environment);
      assert.ok(diag.environment.nodeVersion.startsWith("v"));
      assert.ok(diag.database);
      assert.ok(Array.isArray(diag.supportedLanguages));
      assert.ok(Array.isArray(diag.supportedFrameworks));

      // Verify zero secrets returned
      const diagStr = JSON.stringify(diag);
      assert.ok(!diagStr.includes("token"));
      assert.ok(!diagStr.includes("key"));
    });
  });

  // ==========================================
  // PART 17: API ERROR RELIABILITY & SANITIZATION
  // ==========================================
  describe("Part 17: API Reliability & Sanitization", () => {
    it("returns consistent safe error schema without stack traces", async () => {
      const res = await fetch(`${baseUrl}/api/repairs/00000000-0000-0000-0000-000000000000`);
      assert.equal(res.status, 404);

      const data = await res.json();
      assert.ok(data.error);
      assert.ok(!data.stack);
    });
  });

  // ==========================================
  // PART 20: EXPORTABLE REPAIR REPORT
  // ==========================================
  describe("Part 20: Exportable Repair Report", () => {
    it("GET /api/repairs/:id/report returns Markdown report", async () => {
      // Find an existing repair
      const repair = await prisma.repairJob.findFirst();
      assert.ok(repair);

      const res = await fetch(`${baseUrl}/api/repairs/${repair.id}/report?format=markdown`, {
        headers: { Authorization: `Bearer ${developerToken}` },
      });
      assert.equal(res.status, 200);

      const text = await res.text();
      assert.ok(text.includes("# FixForge Autonomous Repair Report"));
      assert.ok(text.includes("Repair Confidence Score"));
      assert.ok(text.includes("Patch Risk Score"));
      assert.ok(text.includes("Root Cause Certainty"));
    });

    it("GET /api/repairs/:id/report returns JSON report", async () => {
      const repair = await prisma.repairJob.findFirst();
      assert.ok(repair);

      const res = await fetch(`${baseUrl}/api/repairs/${repair.id}/report?format=json`, {
        headers: { Authorization: `Bearer ${developerToken}` },
      });
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.equal(data.reportType, "FIXFORGE_REPAIR_REPORT");
      assert.ok(data.repair.id);
      assert.ok(data.repair.confidence);
      assert.ok(data.repair.risk);
    });
  });

  // ==========================================
  // PART 23: OBSERVABILITY EXTENSION
  // ==========================================
  describe("Part 23: Extended Observability Intelligence", () => {
    it("GET /api/observability/overview provides real M10 distributions", async () => {
      const res = await fetch(`${baseUrl}/api/observability/overview`, {
        headers: { Authorization: `Bearer ${developerToken}` },
      });
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.ok(data.confidenceDistribution);
      assert.ok(typeof data.confidenceDistribution.HIGH === "number");
      assert.ok(data.riskDistribution);
      assert.ok(typeof data.riskDistribution.LOW === "number");
      assert.ok(data.failureCategories);
      assert.ok(data.topFailureCategory);
      assert.ok(data.topLanguage);
    });
  });
});
