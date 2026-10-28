import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import app from "../src/app.js";
import { prisma, seedDatabase, DEMO_USERS, DEMO_ORGS } from "@workspace/db";
import { generateToken } from "../src/services/security/auth-service.js";
import { enableTestAuthMock } from "../src/middlewares/auth.js";

describe("FixForge Milestone 15.1 — Critical Security Remediation Tests", () => {
  let server;
  let baseUrl;

  // Organizations
  let orgPrimary;
  let orgSecondary;

  // Users
  let userPrimary;
  let userSecondary;
  let userNoOrg;

  // Tokens
  let tokenPrimary;
  let tokenSecondary;
  let tokenNoOrg;

  // Resources
  let projectPrimary;
  let projectSecondary;
  let repairPrimary;
  let repairSecondary;

  before(async () => {
    // Ensure test mock auth is DISABLED for these adversarial tests
    enableTestAuthMock(false);

    await seedDatabase();

    await new Promise((resolve) => {
      server = http.createServer(app);
      server.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    // 1. Setup isolated tenant organizations
    orgPrimary = await prisma.organization.create({
      data: {
        id: randomUUID(),
        name: `Tenant Primary ${Date.now()}`,
        slug: `tenant-primary-${Date.now()}`,
      },
    });

    orgSecondary = await prisma.organization.create({
      data: {
        id: randomUUID(),
        name: `Tenant Secondary ${Date.now()}`,
        slug: `tenant-secondary-${Date.now()}`,
      },
    });

    // 2. Setup users for each organization
    userPrimary = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `primary-${Date.now()}@primary.org`,
        name: "Primary Tenant Admin",
        memberships: {
          create: { id: randomUUID(), organizationId: orgPrimary.id, role: "ADMIN" },
        },
      },
    });

    userSecondary = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `secondary-${Date.now()}@secondary.org`,
        name: "Secondary Tenant Dev",
        memberships: {
          create: { id: randomUUID(), organizationId: orgSecondary.id, role: "DEVELOPER" },
        },
      },
    });

    // User without any organization association
    userNoOrg = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `noorg-${Date.now()}@noorg.local`,
        name: "Orphaned User Without Org",
      },
    });

    // 3. Issue valid JWTs
    tokenPrimary = generateToken({
      userId: userPrimary.id,
      email: userPrimary.email,
      organizationId: orgPrimary.id,
      role: "ADMIN",
    });

    tokenSecondary = generateToken({
      userId: userSecondary.id,
      email: userSecondary.email,
      organizationId: orgSecondary.id,
      role: "DEVELOPER",
    });

    tokenNoOrg = generateToken({
      userId: userNoOrg.id,
      email: userNoOrg.email,
      organizationId: null,
      role: "DEVELOPER",
    });

    // 4. Setup scoped projects and repairs
    projectPrimary = await prisma.project.create({
      data: {
        id: randomUUID(),
        organizationId: orgPrimary.id,
        createdById: userPrimary.id,
        name: "Primary Scoped Project",
        repository: "examples/buggy-python-project",
        language: "Python",
        testFramework: "pytest",
        status: "ready",
      },
    });

    projectSecondary = await prisma.project.create({
      data: {
        id: randomUUID(),
        organizationId: orgSecondary.id,
        createdById: userSecondary.id,
        name: "Secondary Scoped Project",
        repository: "examples/buggy-python-project",
        language: "Python",
        testFramework: "pytest",
        status: "ready",
      },
    });

    repairPrimary = await prisma.repairJob.create({
      data: {
        id: randomUUID(),
        organizationId: orgPrimary.id,
        createdById: userPrimary.id,
        projectId: projectPrimary.id,
        issue: "Primary organization repair job",
        model: "default",
        verificationLevel: "standard",
        maxIterations: 3,
        status: "queued",
      },
    });

    repairSecondary = await prisma.repairJob.create({
      data: {
        id: randomUUID(),
        organizationId: orgSecondary.id,
        createdById: userSecondary.id,
        projectId: projectSecondary.id,
        issue: "Secondary organization repair job",
        model: "default",
        verificationLevel: "standard",
        maxIterations: 3,
        status: "queued",
      },
    });
  });

  after(async () => {
    enableTestAuthMock(false);
    if (server) await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
  });

  // =========================================================================
  // 1. CORS ALLOWLIST & ANTI-REFLECTION TESTS
  // =========================================================================
  describe("1. Strict CORS Allowlist Enforcement", () => {
    it("rejects unauthorized origin by omitting Access-Control-Allow-Origin header", async () => {
      const res = await fetch(`${baseUrl}/api/healthz`, {
        method: "GET",
        headers: {
          Origin: "https://malicious-attacker.com",
        },
      });

      assert.equal(res.status, 200);
      const allowOrigin = res.headers.get("access-control-allow-origin");
      assert.equal(
        allowOrigin,
        null,
        "Must NOT reflect unauthorized origin https://malicious-attacker.com",
      );
    });

    it("preflight OPTIONS request from unauthorized origin does not return allow-origin header", async () => {
      const res = await fetch(`${baseUrl}/api/repairs`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://evil.org",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "Content-Type",
        },
      });

      const allowOrigin = res.headers.get("access-control-allow-origin");
      assert.equal(allowOrigin, null, "Preflight must not allow untrusted origin");
    });

    it("permits allowed origin from allowlist with credentials enabled", async () => {
      const res = await fetch(`${baseUrl}/api/healthz`, {
        method: "GET",
        headers: {
          Origin: "http://localhost:3000",
        },
      });

      assert.equal(res.status, 200);
      assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:3000");
      assert.equal(res.headers.get("access-control-allow-credentials"), "true");
    });
  });

  // =========================================================================
  // 2. FAIL-CLOSED AUTHENTICATION & X-DEMO-ROLE SPOOFING REMOVAL
  // =========================================================================
  describe("2. Application Auth Fail-Closed & Rejection of x-demo-role", () => {
    it("unauthenticated GET /api/projects returns 401 UNAUTHORIZED", async () => {
      const res = await fetch(`${baseUrl}/api/projects`);
      assert.equal(res.status, 401);
      const body = await res.json();
      assert.equal(body.code, "UNAUTHORIZED");
    });

    it("unauthenticated GET /api/repairs returns 401 UNAUTHORIZED", async () => {
      const res = await fetch(`${baseUrl}/api/repairs`);
      assert.equal(res.status, 401);
      const body = await res.json();
      assert.equal(body.code, "UNAUTHORIZED");
    });

    it("unauthenticated request with spoofed x-demo-role: ADMIN is rejected with 401 UNAUTHORIZED", async () => {
      const res = await fetch(`${baseUrl}/api/repairs`, {
        headers: {
          "x-demo-role": "ADMIN",
        },
      });
      assert.equal(res.status, 401);
      const body = await res.json();
      assert.equal(body.code, "UNAUTHORIZED");
    });

    it("unauthenticated request with spoofed x-demo-role on POST /api/projects is rejected with 401", async () => {
      const res = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-demo-role": "ADMIN",
        },
        body: JSON.stringify({
          name: "Attacker Spoofed Project",
          repository: "examples/buggy-python-project",
          language: "Python",
        }),
      });
      assert.equal(res.status, 401);
    });

    it("unauthenticated GET /api/dashboard/summary returns 401 UNAUTHORIZED", async () => {
      const res = await fetch(`${baseUrl}/api/dashboard/summary`);
      assert.equal(res.status, 401);
    });

    it("unauthenticated GET /api/activity returns 401 UNAUTHORIZED", async () => {
      const res = await fetch(`${baseUrl}/api/activity`);
      assert.equal(res.status, 401);
    });
  });

  // =========================================================================
  // 3. FAIL-CLOSED ON MISSING TENANT ORGANIZATION ID
  // =========================================================================
  describe("3. Tenant Fail-Closed When User Lacks Organization ID", () => {
    it("authenticated user with organizationId=null receives 403 TENANT_CONTEXT_REQUIRED on GET /api/projects", async () => {
      const res = await fetch(`${baseUrl}/api/projects`, {
        headers: { Authorization: `Bearer ${tokenNoOrg}` },
      });
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.code, "TENANT_CONTEXT_REQUIRED");
    });

    it("authenticated user with organizationId=null receives 403 TENANT_CONTEXT_REQUIRED on GET /api/repairs", async () => {
      const res = await fetch(`${baseUrl}/api/repairs`, {
        headers: { Authorization: `Bearer ${tokenNoOrg}` },
      });
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.code, "TENANT_CONTEXT_REQUIRED");
    });

    it("authenticated user with organizationId=null receives 403 TENANT_CONTEXT_REQUIRED on POST /api/projects", async () => {
      const res = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenNoOrg}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Unassigned Project",
          repository: "examples/buggy-python-project",
          language: "Python",
        }),
      });
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.code, "TENANT_CONTEXT_REQUIRED");
    });

    it("authenticated user with organizationId=null receives 403 TENANT_CONTEXT_REQUIRED on POST /api/repairs", async () => {
      const res = await fetch(`${baseUrl}/api/repairs`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenNoOrg}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          projectId: projectPrimary.id,
          issue: "Unassigned repair attempt",
          model: "default",
          verificationLevel: "standard",
          maxIterations: 2,
        }),
      });
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.code, "TENANT_CONTEXT_REQUIRED");
    });

    it("authenticated user with organizationId=null receives 403 on GET /api/dashboard/summary", async () => {
      const res = await fetch(`${baseUrl}/api/dashboard/summary`, {
        headers: { Authorization: `Bearer ${tokenNoOrg}` },
      });
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.code, "TENANT_CONTEXT_REQUIRED");
    });

    it("authenticated user with organizationId=null receives 403 on GET /api/activity", async () => {
      const res = await fetch(`${baseUrl}/api/activity`, {
        headers: { Authorization: `Bearer ${tokenNoOrg}` },
      });
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.code, "TENANT_CONTEXT_REQUIRED");
    });
  });

  // =========================================================================
  // 4. CROSS-TENANT ISOLATION & IDOR PROTECTION
  // =========================================================================
  describe("4. Multi-Tenant Scoping & Negative Cross-Tenant Authorization", () => {
    it("tenant Primary only sees its own projects in GET /api/projects", async () => {
      const res = await fetch(`${baseUrl}/api/projects`, {
        headers: { Authorization: `Bearer ${tokenPrimary}` },
      });
      assert.equal(res.status, 200);
      const projects = await res.json();
      assert.ok(projects.some((p) => p.id === projectPrimary.id));
      assert.ok(!projects.some((p) => p.id === projectSecondary.id), "Must NOT leak Secondary project");
    });

    it("tenant Secondary only sees its own repairs in GET /api/repairs", async () => {
      const res = await fetch(`${baseUrl}/api/repairs`, {
        headers: { Authorization: `Bearer ${tokenSecondary}` },
      });
      assert.equal(res.status, 200);
      const repairs = await res.json();
      assert.ok(repairs.some((r) => r.id === repairSecondary.id));
      assert.ok(!repairs.some((r) => r.id === repairPrimary.id), "Must NOT leak Primary repair");
    });

    it("tenant Primary is denied cross-tenant access to GET /api/projects/:projectId for Secondary project", async () => {
      const res = await fetch(`${baseUrl}/api/projects/${projectSecondary.id}`, {
        headers: { Authorization: `Bearer ${tokenPrimary}` },
      });
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.code, "ACCESS_DENIED");
    });

    it("tenant Secondary is denied cross-tenant access to GET /api/repairs/:repairId for Primary repair", async () => {
      const res = await fetch(`${baseUrl}/api/repairs/${repairPrimary.id}`, {
        headers: { Authorization: `Bearer ${tokenSecondary}` },
      });
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.code, "ACCESS_DENIED");
    });

    it("tenant Secondary is denied cross-tenant creation of repair against Primary project", async () => {
      const res = await fetch(`${baseUrl}/api/repairs`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenSecondary}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          projectId: projectPrimary.id,
          issue: "Cross tenant repair attack attempt",
          model: "default",
          verificationLevel: "standard",
          maxIterations: 2,
        }),
      });
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.code, "ACCESS_DENIED");
    });

    it("repair job with organizationId=null strictly fails closed (403 ACCESS_DENIED) instead of granting access", async () => {
      // Create an orphaned repair with organizationId: null
      const orphanedRepair = await prisma.repairJob.create({
        data: {
          id: randomUUID(),
          organizationId: null,
          projectId: projectPrimary.id,
          issue: "Orphaned repair job with null orgId",
          model: "default",
          verificationLevel: "standard",
          maxIterations: 1,
          status: "queued",
        },
      });

      // Attempt access by tenant Primary
      const res = await fetch(`${baseUrl}/api/repairs/${orphanedRepair.id}`, {
        headers: { Authorization: `Bearer ${tokenPrimary}` },
      });
      assert.equal(res.status, 403, "Orphaned repair must fail closed with 403 ACCESS_DENIED");
      const body = await res.json();
      assert.equal(body.code, "ACCESS_DENIED");
    });
  });

  // =========================================================================
  // 5. GET HANDLERS DO NOT MUTATE DATABASE (NO SEED ON GET)
  // =========================================================================
  describe("5. Read-Only GET Endpoints Do Not Mutate Database", () => {
    it("GET /api/projects, /api/repairs, /dashboard/summary, and /activity do not re-seed or overwrite records", async () => {
      // 1. Mutate a user attribute to test if seedDatabase() overwrites it
      const customName = `Custom Admin Name ${Date.now()}`;
      await prisma.user.update({
        where: { email: DEMO_USERS.ADMIN.email },
        data: { name: customName },
      });

      // 2. Perform multiple read requests across all previously mutating endpoints
      await fetch(`${baseUrl}/api/projects`, { headers: { Authorization: `Bearer ${tokenPrimary}` } });
      await fetch(`${baseUrl}/api/repairs`, { headers: { Authorization: `Bearer ${tokenPrimary}` } });
      await fetch(`${baseUrl}/api/dashboard/summary`, { headers: { Authorization: `Bearer ${tokenPrimary}` } });
      await fetch(`${baseUrl}/api/activity`, { headers: { Authorization: `Bearer ${tokenPrimary}` } });

      // 3. Verify user name remains untouched and was NOT overwritten back to "Admin User"
      const adminUser = await prisma.user.findUnique({
        where: { email: DEMO_USERS.ADMIN.email },
      });
      assert.equal(
        adminUser.name,
        customName,
        "User record was modified by GET handler! seedDatabase() must NOT run on GET requests.",
      );
    });
  });
});
