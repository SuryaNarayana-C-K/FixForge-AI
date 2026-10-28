import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import app from "../src/app.js";
import { prisma, seedDatabase, DEMO_USERS, DEMO_ORGS } from "@workspace/db";
import { resetRateLimits } from "../src/middlewares/security.js";

describe("FixForge Milestone 9: Enterprise Security + Governance + RBAC", () => {
  let server;
  let baseUrl;

  let adminToken;
  let managerToken;
  let developerToken;
  let viewerToken;
  let acmeDevToken;

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

    // Obtain tokens for all seeded demo users
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
    managerToken = await login("manager@fixforge.local", "DemoManager123!");
    developerToken = await login("developer@fixforge.local", "DemoDeveloper123!");
    viewerToken = await login("viewer@fixforge.local", "DemoViewer123!");
    acmeDevToken = await login("acme-dev@acme.local", "AcmeDev123!");
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
  });

  beforeEach(() => {
    resetRateLimits();
  });

  // =========================================================================
  // 1. AUTHENTICATION TESTS
  // =========================================================================
  describe("1. Authentication (Register, Login, Me, Logout)", () => {
    it("POST /api/auth/register creates user and organization with ADMIN role", async () => {
      const randomEmail = `newuser_${Date.now()}@example.com`;
      const res = await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: randomEmail,
          password: "SecurePassword123!",
          name: "Alice Founder",
          organizationName: `Apex Labs ${Date.now()}`,
        }),
      });

      assert.equal(res.status, 201);
      const data = await res.json();
      assert.ok(data.token);
      assert.equal(data.user.email, randomEmail);
      assert.equal(data.user.role, "ADMIN");
      assert.equal(data.user.passwordHash, undefined, "Password hash must NEVER be returned");
      assert.ok(data.organization.id);
    });

    it("POST /api/auth/register rejects weak password (< 8 chars)", async () => {
      const res = await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: `weak_${Date.now()}@example.com`,
          password: "short",
          name: "Weak Pass User",
        }),
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.code, "WEAK_PASSWORD");
    });

    it("POST /api/auth/login with invalid password returns 401 generic error", async () => {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "admin@fixforge.local",
          password: "WrongPassword999!",
        }),
      });

      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.error, "Invalid email or password.");
    });

    it("POST /api/auth/login with unknown email returns generic error (no account enumeration)", async () => {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "does_not_exist@fixforge.local",
          password: "AnyPassword123!",
        }),
      });

      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.error, "Invalid email or password.");
    });

    it("GET /api/auth/me returns authenticated identity and organization", async () => {
      const res = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${developerToken}` },
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.user.email, "developer@fixforge.local");
      assert.equal(data.organization.slug, "fixforge-labs");
      assert.equal(data.organization.role, "DEVELOPER");
      assert.equal(data.user.passwordHash, undefined);
    });

    it("POST /api/auth/logout succeeds and clears session", async () => {
      const res = await fetch(`${baseUrl}/api/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${developerToken}` },
      });
      assert.equal(res.status, 200);
    });
  });

  // =========================================================================
  // 2. RBAC & PERMISSION ENFORCEMENT
  // =========================================================================
  describe("2. RBAC Permissions (ADMIN, MANAGER, DEVELOPER, VIEWER)", () => {
    it("ADMIN can access organization governance, policy, and members", async () => {
      const res = await fetch(`${baseUrl}/api/admin/organization`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.slug, "fixforge-labs");
    });

    it("DEVELOPER is denied access to admin governance endpoints (403 ACCESS_DENIED)", async () => {
      const res = await fetch(`${baseUrl}/api/admin/organization`, {
        headers: { Authorization: `Bearer ${developerToken}` },
      });
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.code, "ACCESS_DENIED");
    });

    it("VIEWER cannot create projects (403 ACCESS_DENIED)", async () => {
      const res = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${viewerToken}`,
        },
        body: JSON.stringify({
          name: "Viewer Illegal Project",
          repository: "examples/buggy-python-project",
          language: "Python",
        }),
      });
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.code, "ACCESS_DENIED");
    });

    it("VIEWER cannot create repair jobs (403 ACCESS_DENIED)", async () => {
      const projectsRes = await fetch(`${baseUrl}/api/projects`, {
        headers: { Authorization: `Bearer ${viewerToken}` },
      });
      const projects = await projectsRes.json();
      const projId = projects[0].id;

      const res = await fetch(`${baseUrl}/api/repairs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${viewerToken}`,
        },
        body: JSON.stringify({
          projectId: projId,
          issue: "Viewer unauthorized repair attempt",
          model: "OpenAI-compatible / default",
          verificationLevel: "standard",
          maxIterations: 3,
        }),
      });

      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.code, "ACCESS_DENIED");
    });

    it("DEVELOPER can create repair jobs", async () => {
      const projectsRes = await fetch(`${baseUrl}/api/projects`, {
        headers: { Authorization: `Bearer ${developerToken}` },
      });
      const projects = await projectsRes.json();
      const projId = projects[0].id;

      const res = await fetch(`${baseUrl}/api/repairs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${developerToken}`,
        },
        body: JSON.stringify({
          projectId: projId,
          issue: "Developer authorized repair",
          model: "OpenAI-compatible / default",
          verificationLevel: "standard",
          maxIterations: 3,
        }),
      });

      assert.equal(res.status, 201);
      const repair = await res.json();
      assert.ok(repair.id);
      assert.equal(repair.status, "queued");
    });
  });

  // =========================================================================
  // 3. ORGANIZATION ISOLATION & IDOR PREVENTION
  // =========================================================================
  describe("3. Multi-Tenant Organization Isolation & IDOR Protection", () => {
    it("Acme Corp user cannot access FixForge Labs project (403 ACCESS_DENIED)", async () => {
      // FixForge Labs project
      const ffProject = await prisma.project.findFirst({
        where: { organizationId: DEMO_ORGS.FIXFORGE_LABS.id },
      });

      const res = await fetch(`${baseUrl}/api/projects/${ffProject.id}`, {
        headers: { Authorization: `Bearer ${acmeDevToken}` },
      });

      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.code, "ACCESS_DENIED");
    });

    it("FixForge Labs user cannot access Acme Corp project (403 ACCESS_DENIED)", async () => {
      // Acme project
      const acmeProject = await prisma.project.findFirst({
        where: { organizationId: DEMO_ORGS.ACME_CORP.id },
      });

      const res = await fetch(`${baseUrl}/api/projects/${acmeProject.id}`, {
        headers: { Authorization: `Bearer ${developerToken}` },
      });

      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.code, "ACCESS_DENIED");
    });

    it("IDOR: Organization A user cannot view Organization B repair details (403 ACCESS_DENIED)", async () => {
      const acmeRepair = await prisma.repairJob.findFirst({
        where: { organizationId: DEMO_ORGS.ACME_CORP.id },
      });

      const res = await fetch(`${baseUrl}/api/repairs/${acmeRepair.id}`, {
        headers: { Authorization: `Bearer ${developerToken}` },
      });

      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.code, "ACCESS_DENIED");
    });

    it("User cannot create repair targeting a project in another organization (403 ACCESS_DENIED)", async () => {
      const acmeProject = await prisma.project.findFirst({
        where: { organizationId: DEMO_ORGS.ACME_CORP.id },
      });

      const res = await fetch(`${baseUrl}/api/repairs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${developerToken}`,
        },
        body: JSON.stringify({
          projectId: acmeProject.id,
          issue: "Attempted cross-org repair",
          model: "OpenAI-compatible / default",
          verificationLevel: "standard",
          maxIterations: 3,
        }),
      });

      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.code, "ACCESS_DENIED");
    });

    it("Observability Overview is isolated per organization", async () => {
      const ffRes = await fetch(`${baseUrl}/api/observability/overview`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const ffMetrics = await ffRes.json();

      const acmeRes = await fetch(`${baseUrl}/api/observability/overview`, {
        headers: { Authorization: `Bearer ${acmeDevToken}` },
      });
      const acmeMetrics = await acmeRes.json();

      // Acme repairs are strictly separate from FixForge Labs repairs
      assert.notEqual(ffMetrics.totalRepairs, acmeMetrics.totalRepairs);
      assert.ok(ffMetrics.totalRepairs >= 1);
    });
  });

  // =========================================================================
  // 4. HUMAN APPROVAL GATE & POLICY ENGINE
  // =========================================================================
  describe("4. Approval Policy Engine & Human Approval Gates", () => {
    let testRepairId;

    before(async () => {
      // Create a verified repair for approval workflow testing
      const proj = await prisma.project.findFirst({
        where: { organizationId: DEMO_ORGS.FIXFORGE_LABS.id },
      });

      const repair = await prisma.repairJob.create({
        data: {
          projectId: proj.id,
          organizationId: DEMO_ORGS.FIXFORGE_LABS.id,
          issue: "Human approval workflow testing",
          model: "OpenAI-compatible / default",
          verificationLevel: "standard",
          maxIterations: 3,
          status: "verified",
          testsPassed: 10,
          testsTotal: 10,
          approvalStatus: "NONE",
        },
      });
      testRepairId = repair.id;
    });

    it("PR creation is blocked when approval policy requires human approval (403 APPROVAL_REQUIRED)", async () => {
      const res = await fetch(`${baseUrl}/api/repairs/${testRepairId}/github/pr`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${developerToken}`,
        },
        body: JSON.stringify({ createPullRequest: true }),
      });

      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.code, "APPROVAL_REQUIRED");
      assert.equal(data.approvalStatus, "PENDING");
    });

    it("DEVELOPER cannot approve a repair (403 ACCESS_DENIED)", async () => {
      const res = await fetch(`${baseUrl}/api/repairs/${testRepairId}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${developerToken}`,
        },
        body: JSON.stringify({ notes: "Developer illegal approval" }),
      });

      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.code, "ACCESS_DENIED");
    });

    it("MANAGER can approve a verified repair", async () => {
      const res = await fetch(`${baseUrl}/api/repairs/${testRepairId}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${managerToken}`,
        },
        body: JSON.stringify({ notes: "Manager approved repair for PR deployment" }),
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.approvalStatus, "APPROVED");
      assert.ok(data.approvedBy);
    });

    it("Approved repair is now authorized for GitHub PR workflow", async () => {
      const res = await fetch(`${baseUrl}/api/repairs/${testRepairId}/github/pr`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${developerToken}`,
        },
        body: JSON.stringify({ createPullRequest: true }),
      });

      // The human approval gate passes (code is not APPROVAL_REQUIRED)
      const data = await res.json();
      assert.notEqual(data.code, "APPROVAL_REQUIRED");
    });

    it("Unverified repair cannot be approved (400 UNVERIFIED_REPAIR_BLOCKED)", async () => {
      const proj = await prisma.project.findFirst({
        where: { organizationId: DEMO_ORGS.FIXFORGE_LABS.id },
      });

      const unverified = await prisma.repairJob.create({
        data: {
          projectId: proj.id,
          organizationId: DEMO_ORGS.FIXFORGE_LABS.id,
          issue: "Broken unverified repair",
          model: "default",
          verificationLevel: "standard",
          maxIterations: 3,
          status: "failed",
          testsPassed: 2,
          testsTotal: 10,
        },
      });

      const res = await fetch(`${baseUrl}/api/repairs/${unverified.id}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ notes: "Should fail" }),
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.code, "UNVERIFIED_REPAIR_BLOCKED");
    });
  });

  // =========================================================================
  // 5. GITHUB & POLICY PERMISSION ENFORCEMENT
  // =========================================================================
  describe("5. GitHub Permissions & Policy Controls", () => {
    it("VIEWER is blocked from creating GitHub PR (403 ACCESS_DENIED)", async () => {
      const repair = await prisma.repairJob.findFirst({
        where: { organizationId: DEMO_ORGS.FIXFORGE_LABS.id, status: "approved" },
      });

      const res = await fetch(`${baseUrl}/api/repairs/${repair.id}/github/pr`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${viewerToken}`,
        },
      });

      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.code, "ACCESS_DENIED");
    });

    it("Policy with allowGitHubPR = false blocks PR operations (403 POLICY_DISABLED_PR)", async () => {
      // Disable allowGitHubPR
      await fetch(`${baseUrl}/api/admin/policy`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ allowGitHubPR: false }),
      });

      const repair = await prisma.repairJob.findFirst({
        where: { organizationId: DEMO_ORGS.FIXFORGE_LABS.id, status: "approved" },
      });

      const res = await fetch(`${baseUrl}/api/repairs/${repair.id}/github/pr`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
      });

      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.code, "POLICY_DISABLED_PR");

      // Restore policy
      await fetch(`${baseUrl}/api/admin/policy`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ allowGitHubPR: true }),
      });
    });
  });

  // =========================================================================
  // 6. AUDIT LOGGING & SECURITY MONITORING
  // =========================================================================
  describe("6. Audit Logging & Security Event Monitoring", () => {
    it("Security overview returns aggregated statistics and events (ADMIN/MANAGER only)", async () => {
      const res = await fetch(`${baseUrl}/api/security/overview`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      assert.equal(res.status, 200);
      const overview = await res.json();
      assert.equal(typeof overview.failedLogins, "number");
      assert.equal(typeof overview.accessDenied, "number");
      assert.ok(Array.isArray(overview.recentSecurityEvents));
    });

    it("DEVELOPER is denied access to security overview (403 ACCESS_DENIED)", async () => {
      const res = await fetch(`${baseUrl}/api/security/overview`, {
        headers: { Authorization: `Bearer ${developerToken}` },
      });
      assert.equal(res.status, 403);
    });

    it("AuditLog entries sanitize secrets, passwords, and tokens", async () => {
      const logs = await prisma.auditLog.findMany({
        take: 20,
        orderBy: { createdAt: "desc" },
      });

      for (const log of logs) {
        assert.ok(!log.metadata.includes("DemoAdmin123!"), "Password must not be in audit metadata");
        assert.ok(!log.metadata.includes("SecurePassword123!"), "Password must not be in audit metadata");
        assert.ok(!log.metadata.includes("Bearer "), "Tokens must not be in audit metadata");
      }
    });
  });

  // =========================================================================
  // 7. RATE LIMITING
  // =========================================================================
  describe("7. Rate Limiting", () => {
    it("Triggers 429 RATE_LIMIT_EXCEEDED when login attempts exceed threshold", async () => {
      resetRateLimits();
      const ip = "127.0.0.1";

      let lastRes;
      // Login limit is configured at 10 requests per minute
      for (let i = 0; i < 12; i++) {
        lastRes = await fetch(`${baseUrl}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
          body: JSON.stringify({ email: "rate_test@fixforge.local", password: "bad" }),
        });
      }

      assert.equal(lastRes.status, 429);
      const data = await lastRes.json();
      assert.equal(data.code, "RATE_LIMIT_EXCEEDED");
      assert.ok(lastRes.headers.get("retry-after"));
      resetRateLimits();
    });
  });

  // =========================================================================
  // 8. INPUT VALIDATION & SECURITY HEADERS
  // =========================================================================
  describe("8. Input Validation & HTTP Security Headers", () => {
    it("Rejects path traversal in repository input (400 PATH_TRAVERSAL_DETECTED)", async () => {
      const res = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          name: "Malicious Project",
          repository: "../../etc/passwd",
          language: "Python",
        }),
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.code, "PATH_TRAVERSAL_DETECTED");
    });

    it("Rejects shell injection metacharacters in repository name (400 INJECTION_ATTEMPT_DETECTED)", async () => {
      const res = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          name: "Project; rm -rf /",
          repository: "examples/buggy-python-project",
          language: "Python",
        }),
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.code, "INJECTION_ATTEMPT_DETECTED");
    });

    it("Rejects malformed UUID identifier in route parameter (400 INVALID_IDENTIFIER)", async () => {
      const res = await fetch(`${baseUrl}/api/repairs/invalid-non-uuid-format`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.code, "INVALID_IDENTIFIER");
    });

    it("Applies strict HTTP security headers (nosniff, DENY, Referrer-Policy, CSP)", async () => {
      const res = await fetch(`${baseUrl}/api/healthz`);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.equal(res.headers.get("x-frame-options"), "DENY");
      assert.equal(res.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
      assert.ok(res.headers.get("content-security-policy")?.includes("default-src 'self'"));
    });
  });

  // =========================================================================
  // 9. ADMIN SAFEGUARDS & USER MANAGEMENT
  // =========================================================================
  describe("9. User Management & Admin Safeguards", () => {
    it("Admin can add a new member with specified role", async () => {
      const newEmail = `member_${Date.now()}@fixforge.local`;
      const res = await fetch(`${baseUrl}/api/admin/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          email: newEmail,
          name: "New Team Member",
          role: "DEVELOPER",
        }),
      });

      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.email, newEmail);
      assert.equal(data.role, "DEVELOPER");
    });

    it("Admin cannot remove the final administrator (400 LAST_ADMIN_PROTECTED)", async () => {
      const membersRes = await fetch(`${baseUrl}/api/admin/members`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const members = await membersRes.json();
      const adminMember = members.find((m) => m.role === "ADMIN");

      const res = await fetch(`${baseUrl}/api/admin/members/${adminMember.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.code, "LAST_ADMIN_PROTECTED");
    });
  });
});
