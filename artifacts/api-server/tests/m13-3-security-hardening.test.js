import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import app from '../src/app.js';
import { prisma, DEMO_USERS, DEMO_ORGS } from '@workspace/db';
import { validateProductionConfig } from '../src/lib/config.js';
import { classifyAndSanitizeError } from '../src/routes/repairs.js';
import { sanitizeLogText } from '../src/lib/logger.js';
import { createDatabaseBackup, verifyDataRetentionSafety } from '../../../scripts/db-backup-restore.js';
import { enableTestAuthMock } from '../src/middlewares/auth.js';

describe('M13.3 Production Deployment Readiness & Security Hardening', () => {
  let server;
  let baseUrl;
  let orgA;
  let orgB;
  let userOrgA;
  let userOrgB;
  let viewerOrgA;
  let projectOrgA;
  let projectOrgB;
  let repairOrgA;
  let repairOrgB;

  before(async () => {
    enableTestAuthMock(true);
    // 1. Setup isolated test organizations and users
    orgA = await prisma.organization.create({
      data: {
        id: randomUUID(),
        name: 'M13-3 Tenant A Inc',
        slug: `tenant-a-${Date.now()}`,
      },
    });

    orgB = await prisma.organization.create({
      data: {
        id: randomUUID(),
        name: 'M13-3 Tenant B Corp',
        slug: `tenant-b-${Date.now()}`,
      },
    });

    userOrgA = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `alice-${Date.now()}@tenanta.com`,
        name: 'Alice Developer A',
        memberships: {
          create: {
            id: randomUUID(),
            organizationId: orgA.id,
            role: 'DEVELOPER',
          },
        },
      },
    });

    userOrgB = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `bob-${Date.now()}@tenantb.com`,
        name: 'Bob Developer B',
        memberships: {
          create: {
            id: randomUUID(),
            organizationId: orgB.id,
            role: 'DEVELOPER',
          },
        },
      },
    });

    viewerOrgA = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `victor-viewer-${Date.now()}@tenanta.com`,
        name: 'Victor Viewer A',
        memberships: {
          create: {
            id: randomUUID(),
            organizationId: orgA.id,
            role: 'VIEWER',
          },
        },
      },
    });

    // 2. Setup projects
    projectOrgA = await prisma.project.create({
      data: {
        id: randomUUID(),
        name: 'Project Alpha Org A',
        repository: 'ai-agent/tests/fixtures/sample_repo',
        organizationId: orgA.id,
        createdById: userOrgA.id,
      },
    });

    projectOrgB = await prisma.project.create({
      data: {
        id: randomUUID(),
        name: 'Project Beta Org B',
        repository: 'ai-agent/tests/fixtures/sample_repo',
        organizationId: orgB.id,
        createdById: userOrgB.id,
      },
    });

    // 3. Setup repair jobs
    repairOrgA = await prisma.repairJob.create({
      data: {
        id: randomUUID(),
        projectId: projectOrgA.id,
        organizationId: orgA.id,
        createdById: userOrgA.id,
        issue: 'Tenant A security issue',
        model: 'gemini-2.5-flash',
        verificationLevel: 'SANDBOX_VERIFIED',
        maxIterations: 3,
        status: 'pending',
        testsPassed: 0,
        testsTotal: 1,
      },
    });

    repairOrgB = await prisma.repairJob.create({
      data: {
        id: randomUUID(),
        projectId: projectOrgB.id,
        organizationId: orgB.id,
        createdById: userOrgB.id,
        issue: 'Tenant B private issue',
        model: 'gemini-2.5-flash',
        verificationLevel: 'SANDBOX_VERIFIED',
        maxIterations: 3,
        status: 'pending',
        testsPassed: 0,
        testsTotal: 1,
      },
    });

    // 4. Start HTTP test server
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://localhost:${port}/api`;
        resolve();
      });
    });
  });

  after(async () => {
    enableTestAuthMock(false);
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  describe('1. Production Configuration & Fail-Safe Validation', () => {
    it('validates development configuration with warnings but succeeds', () => {
      const result = validateProductionConfig({
        NODE_ENV: 'development',
        PORT: '5000',
      });
      assert.strictEqual(result.isValid, true);
      assert.strictEqual(result.isProduction, false);
      assert.ok(result.warnings.length > 0);
    });

    it('rejects missing JWT_SECRET in production mode', () => {
      const result = validateProductionConfig({
        NODE_ENV: 'production',
        PORT: '5000',
        DATABASE_URL: 'file:dev.db',
      });
      assert.strictEqual(result.isValid, false);
      assert.ok(result.errors.some((e) => e.includes('JWT_SECRET')));
    });

    it('rejects short or default JWT_SECRET in production mode', () => {
      const defaultSecretResult = validateProductionConfig({
        NODE_ENV: 'production',
        PORT: '5000',
        JWT_SECRET: 'fixforge-dev-secret-key-change-in-prod',
        DATABASE_URL: 'file:dev.db',
      });
      assert.strictEqual(defaultSecretResult.isValid, false);
      assert.ok(defaultSecretResult.errors.some((e) => e.includes('default development secret')));

      const shortSecretResult = validateProductionConfig({
        NODE_ENV: 'production',
        PORT: '5000',
        JWT_SECRET: 'short-secret-123',
        DATABASE_URL: 'file:dev.db',
      });
      assert.strictEqual(shortSecretResult.isValid, false);
      assert.ok(shortSecretResult.errors.some((e) => e.includes('at least 32 characters')));
    });

    it('rejects ALLOW_LOCAL_SUBPROCESS in production mode', () => {
      const result = validateProductionConfig({
        NODE_ENV: 'production',
        PORT: '5000',
        JWT_SECRET: 'a-sufficiently-long-production-jwt-secret-key-32',
        DATABASE_URL: 'file:dev.db',
        ALLOW_LOCAL_SUBPROCESS: 'true',
      });
      assert.strictEqual(result.isValid, false);
      assert.ok(result.errors.some((e) => e.includes('ALLOW_LOCAL_SUBPROCESS is set to \'true\'')));
    });

    it('passes validation when all production requirements are satisfied', () => {
      const result = validateProductionConfig({
        NODE_ENV: 'production',
        PORT: '5000',
        JWT_SECRET: 'super-secure-production-cryptographic-key-1234567890',
        DATABASE_URL: 'file:../../../database/dev.db',
      });
      assert.strictEqual(result.isValid, true);
      assert.strictEqual(result.errors.length, 0);
    });
  });

  describe('2. Secret Redaction & Token Safety', () => {
    it('redacts Gemini API keys, GitHub tokens, and connection strings from errors', () => {
      const rawError = new Error(
        'Failed: AIzaSyD1234567890abcdefghijklmnopqrstuvw failed with ghp_123456789012345678901234567890123456 ' +
        'connected to postgres://postgres:supersecretpassword@localhost:5432/fixforge'
      );

      const sanitized = classifyAndSanitizeError(rawError);
      assert.ok(!sanitized.message.includes('AIzaSyD1234567890abcdefghijklmnopqrstuvw'));
      assert.ok(!sanitized.message.includes('ghp_123456789012345678901234567890123456'));
      assert.ok(!sanitized.message.includes('supersecretpassword'));
      assert.ok(sanitized.message.includes('[REDACTED_API_KEY]'));
      assert.ok(sanitized.message.includes('[REDACTED_GH_TOKEN]'));
      assert.ok(sanitized.message.includes('[REDACTED_PWD]'));
    });

    it('sanitizeLogText cleans Bearer tokens and connection strings', () => {
      const text = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-IDN incorporated into log';
      const cleaned = sanitizeLogText(text);
      assert.ok(!cleaned.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'));
      assert.ok(cleaned.includes('Bearer [REDACTED_TOKEN]'));
    });
  });

  describe('3. Multi-Tenant Isolation & Negative Authorization Tests', () => {
    it('rejects cross-organization access to GET /repairs/:repairId', async () => {
      // User B tries to view repair belonging to User A / Org A
      const resp = await fetch(`${baseUrl}/repairs/${repairOrgA.id}`, {
        headers: {
          'x-anonymous': 'false',
        },
      });

      // Using demo user belonging to FIXFORGE_LABS, repairOrgA belongs to orgA -> 403
      assert.strictEqual(resp.status, 403);
      const data = await resp.json();
      assert.strictEqual(data.code, 'ACCESS_DENIED');
      assert.ok(data.error.includes('repair belongs to another organization'));
    });

    it('rejects cross-organization execution on POST /repairs/:repairId/repair', async () => {
      const resp = await fetch(`${baseUrl}/repairs/${repairOrgA.id}/repair`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      assert.strictEqual(resp.status, 403);
      const data = await resp.json();
      assert.strictEqual(data.code, 'ACCESS_DENIED');
    });

    it('rejects cross-organization cancellation on POST /repairs/:repairId/cancel', async () => {
      const resp = await fetch(`${baseUrl}/repairs/${repairOrgA.id}/cancel`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ reason: 'Malicious cancellation attempt' }),
      });

      assert.strictEqual(resp.status, 403);
      const data = await resp.json();
      assert.strictEqual(data.code, 'ACCESS_DENIED');
    });

    it('rejects VIEWER role from cancelling a repair', async () => {
      // Simulate viewer user cancelling their own organization's repair
      const { jobLifecycleService } = await import('../src/services/lifecycle/job-lifecycle-service.js');
      
      await assert.rejects(
        async () => {
          await jobLifecycleService.cancelJob(
            repairOrgA.id,
            { id: viewerOrgA.id, role: 'VIEWER', organizationId: orgA.id },
            'Viewer attempt'
          );
        },
        (err) => {
          assert.strictEqual(err.code, 'ACCESS_DENIED');
          assert.strictEqual(err.status, 403);
          return true;
        }
      );
    });

    it('rejects unauthenticated requests when x-anonymous=true', async () => {
      const resp = await fetch(`${baseUrl}/repairs/${repairOrgA.id}`, {
        headers: {
          'x-anonymous': 'true',
        },
      });

      assert.strictEqual(resp.status, 401);
      const data = await resp.json();
      assert.strictEqual(data.code, 'UNAUTHORIZED');
    });

    it('rejects unauthenticated requests on POST /repairs when x-anonymous=true', async () => {
      const resp = await fetch(`${baseUrl}/repairs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-anonymous': 'true',
        },
        body: JSON.stringify({
          projectId: projectOrgA.id,
          issue: 'Anonymous repair creation attempt',
        }),
      });

      assert.strictEqual(resp.status, 401);
      const data = await resp.json();
      assert.strictEqual(data.code, 'UNAUTHORIZED');
    });

    it('rejects cross-organization GitHub PR creation', async () => {
      const resp = await fetch(`${baseUrl}/repairs/${repairOrgA.id}/github/pr`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      assert.strictEqual(resp.status, 403);
      const data = await resp.json();
      assert.strictEqual(data.code, 'ACCESS_DENIED');
    });
  });

  describe('4. Database Backup, Restore & Data Retention Safety', () => {
    it('generates consistent SQLite hot backup via VACUUM INTO with valid header', async () => {
      const backupResult = await createDatabaseBackup();
      assert.strictEqual(backupResult.success, true);
      assert.ok(backupResult.backupPath.endsWith('.db'));
      assert.ok(backupResult.sizeBytes > 0);
      assert.strictEqual(typeof backupResult.sha256, 'string');
      assert.strictEqual(backupResult.sha256.length, 64);
    });

    it('verifies that schema updates do not silently discard job history or audit events', async () => {
      const retention = await verifyDataRetentionSafety();
      assert.strictEqual(retention.safe, true);
      assert.ok(retention.counts.repairJobs > 0);
      assert.ok(retention.counts.activityEvents > 0);
      assert.ok(retention.counts.auditLogs > 0);
    });
  });

  describe('5. Operational Health & Readiness Probes', () => {
    it('GET /api/healthz returns 200 ok for liveness probe', async () => {
      const resp = await fetch(`${baseUrl}/healthz`);
      assert.strictEqual(resp.status, 200);
      const data = await resp.json();
      assert.strictEqual(data.status, 'ok');
    });

    it('GET /api/readyz reports readiness checks without leaking sensitive information', async () => {
      const resp = await fetch(`${baseUrl}/readyz`);
      assert.ok(resp.status === 200 || resp.status === 503);
      const data = await resp.json();
      assert.ok(data.checks);
      assert.strictEqual(data.checks.api, 'ready');
      assert.strictEqual(data.checks.database, 'ready');
      // Ensure no passwords, URLs, or secrets in response
      const rawText = JSON.stringify(data);
      assert.ok(!rawText.includes('password'));
      assert.ok(!rawText.includes('JWT_SECRET'));
    });
  });
});
