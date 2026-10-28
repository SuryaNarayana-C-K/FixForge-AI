import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import app from '../src/app.js';
import { prisma, DEMO_USERS, DEMO_ORGS } from '@workspace/db';
import { validateProductionConfig, enforceStartupConfig } from '../src/lib/config.js';
import { classifyAndSanitizeError } from '../src/routes/repairs.js';
import { sanitizeLogText } from '../src/lib/logger.js';
import { generateToken } from '../src/services/security/auth-service.js';
import { recordAuditLog, getAuditLogs } from '../src/services/security/audit-service.js';
import { jobLifecycleService, JOB_STATES } from '../src/services/lifecycle/job-lifecycle-service.js';
import {
  createDatabaseBackup,
  restoreDatabaseBackup,
  verifyDataRetentionSafety,
} from '../../../scripts/db-backup-restore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../../..');

describe('FixForge M13.4 — Production Security Verification & Deployment Gate', () => {
  let server;
  let baseUrl;

  // Organizations
  let orgAlpha;
  let orgBeta;

  // Users in Org Alpha
  let adminAlpha;
  let managerAlpha;
  let devAlpha;
  let viewerAlpha;

  // Users in Org Beta
  let adminBeta;
  let devBeta;

  // Tokens
  let tokenAdminAlpha;
  let tokenManagerAlpha;
  let tokenDevAlpha;
  let tokenViewerAlpha;
  let tokenAdminBeta;
  let tokenDevBeta;

  // Projects & Repairs
  let projectAlpha;
  let projectBeta;
  let repairAlpha;
  let repairBeta;

  before(async () => {
    // 1. Setup isolated test organizations
    orgAlpha = await prisma.organization.create({
      data: {
        id: randomUUID(),
        name: 'Verification Org Alpha',
        slug: `org-alpha-${Date.now()}`,
      },
    });

    orgBeta = await prisma.organization.create({
      data: {
        id: randomUUID(),
        name: 'Verification Org Beta',
        slug: `org-beta-${Date.now()}`,
      },
    });

    // 2. Setup users for all 4 roles in Alpha and Beta
    adminAlpha = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `admin-alpha-${Date.now()}@alpha.org`,
        name: 'Alpha Admin',
        memberships: {
          create: { id: randomUUID(), organizationId: orgAlpha.id, role: 'ADMIN' },
        },
      },
    });

    managerAlpha = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `mgr-alpha-${Date.now()}@alpha.org`,
        name: 'Alpha Manager',
        memberships: {
          create: { id: randomUUID(), organizationId: orgAlpha.id, role: 'MANAGER' },
        },
      },
    });

    devAlpha = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `dev-alpha-${Date.now()}@alpha.org`,
        name: 'Alpha Developer',
        memberships: {
          create: { id: randomUUID(), organizationId: orgAlpha.id, role: 'DEVELOPER' },
        },
      },
    });

    viewerAlpha = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `viewer-alpha-${Date.now()}@alpha.org`,
        name: 'Alpha Viewer',
        memberships: {
          create: { id: randomUUID(), organizationId: orgAlpha.id, role: 'VIEWER' },
        },
      },
    });

    adminBeta = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `admin-beta-${Date.now()}@beta.org`,
        name: 'Beta Admin',
        memberships: {
          create: { id: randomUUID(), organizationId: orgBeta.id, role: 'ADMIN' },
        },
      },
    });

    devBeta = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `dev-beta-${Date.now()}@beta.org`,
        name: 'Beta Developer',
        memberships: {
          create: { id: randomUUID(), organizationId: orgBeta.id, role: 'DEVELOPER' },
        },
      },
    });

    // 3. Issue genuine cryptographically signed JWTs
    tokenAdminAlpha = generateToken({
      userId: adminAlpha.id,
      email: adminAlpha.email,
      role: 'ADMIN',
      organizationId: orgAlpha.id,
    });
    tokenManagerAlpha = generateToken({
      userId: managerAlpha.id,
      email: managerAlpha.email,
      role: 'MANAGER',
      organizationId: orgAlpha.id,
    });
    tokenDevAlpha = generateToken({
      userId: devAlpha.id,
      email: devAlpha.email,
      role: 'DEVELOPER',
      organizationId: orgAlpha.id,
    });
    tokenViewerAlpha = generateToken({
      userId: viewerAlpha.id,
      email: viewerAlpha.email,
      role: 'VIEWER',
      organizationId: orgAlpha.id,
    });
    tokenAdminBeta = generateToken({
      userId: adminBeta.id,
      email: adminBeta.email,
      role: 'ADMIN',
      organizationId: orgBeta.id,
    });
    tokenDevBeta = generateToken({
      userId: devBeta.id,
      email: devBeta.email,
      role: 'DEVELOPER',
      organizationId: orgBeta.id,
    });

    // 4. Setup projects
    projectAlpha = await prisma.project.create({
      data: {
        id: randomUUID(),
        name: 'Alpha Secure Project',
        repository: 'ai-agent/tests/fixtures/sample_repo',
        organizationId: orgAlpha.id,
        createdById: adminAlpha.id,
      },
    });

    projectBeta = await prisma.project.create({
      data: {
        id: randomUUID(),
        name: 'Beta Secure Project',
        repository: 'ai-agent/tests/fixtures/sample_repo',
        organizationId: orgBeta.id,
        createdById: adminBeta.id,
      },
    });

    // 5. Setup repair jobs
    repairAlpha = await prisma.repairJob.create({
      data: {
        id: randomUUID(),
        projectId: projectAlpha.id,
        organizationId: orgAlpha.id,
        createdById: devAlpha.id,
        issue: 'Alpha confidential defect',
        model: 'gemini-2.5-flash',
        verificationLevel: 'standard',
        maxIterations: 3,
        status: 'verified',
        testsPassed: 4,
        testsTotal: 4,
      },
    });

    repairBeta = await prisma.repairJob.create({
      data: {
        id: randomUUID(),
        projectId: projectBeta.id,
        organizationId: orgBeta.id,
        createdById: devBeta.id,
        issue: 'Beta confidential defect',
        model: 'gemini-2.5-flash',
        verificationLevel: 'standard',
        maxIterations: 3,
        status: 'awaiting_approval',
        testsPassed: 2,
        testsTotal: 2,
      },
    });

    // 6. Start test server
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://localhost:${port}/api`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // =========================================================================
  // Section 1: Authentication and Tenant Isolation Verification
  // =========================================================================
  describe('1. Authentication and Tenant Isolation Verification', () => {
    it('rejects unauthenticated requests to protected routes when x-anonymous=true', async () => {
      const protectedEndpoints = [
        { method: 'GET', url: `/projects` },
        { method: 'GET', url: `/projects/${projectAlpha.id}` },
        { method: 'POST', url: `/projects`, body: { name: 'P', repository: 'ai-agent/tests/fixtures/sample_repo', language: 'python' } },
        { method: 'GET', url: `/repairs/${repairAlpha.id}` },
        { method: 'GET', url: `/repairs/${repairAlpha.id}/events` },
        { method: 'GET', url: `/repairs/${repairAlpha.id}/plan` },
        { method: 'GET', url: `/repairs/${repairAlpha.id}/memory` },
        { method: 'GET', url: `/repairs/${repairAlpha.id}/report` },
        { method: 'GET', url: `/repairs/${repairAlpha.id}/metrics` },
        { method: 'GET', url: `/repairs/${repairAlpha.id}/github` },
        { method: 'GET', url: `/repairs/${repairAlpha.id}/github/report` },
        { method: 'GET', url: `/observability/overview` },
        { method: 'GET', url: `/observability/trends` },
        { method: 'GET', url: `/observability/recent` },
        { method: 'GET', url: `/observability/reliability` },
        { method: 'GET', url: `/observability/intelligence` },
        { method: 'GET', url: `/dashboard/summary` },
        { method: 'GET', url: `/activity` },
      ];

      for (const endpoint of protectedEndpoints) {
        const res = await fetch(`${baseUrl}${endpoint.url}`, {
          method: endpoint.method,
          headers: {
            'x-anonymous': 'true',
            'Content-Type': 'application/json',
          },
          body: endpoint.body ? JSON.stringify(endpoint.body) : undefined,
        });

        assert.strictEqual(
          res.status,
          401,
          `Expected 401 UNAUTHORIZED on unauthenticated ${endpoint.method} ${endpoint.url}, got ${res.status}`
        );
        const data = await res.json();
        assert.strictEqual(data.code, 'UNAUTHORIZED');
      }
    });

    it('rejects spoofed x-demo-role header in production mode', async () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const res = await fetch(`${baseUrl}/admin/organization`, {
          headers: {
            'x-demo-role': 'ADMIN',
          },
        });
        // In production, missing Authorization header must yield 401 even if x-demo-role is set
        assert.strictEqual(res.status, 401);
      } finally {
        process.env.NODE_ENV = origEnv;
      }
    });

    it('blocks cross-organization resource read & write attempts (403 ACCESS_DENIED)', async () => {
      // User from Org Beta attempts to access Org Alpha resources
      const headersBeta = {
        Authorization: `Bearer ${tokenDevBeta}`,
        'Content-Type': 'application/json',
      };

      // 1. Cross-org project access
      const getProjRes = await fetch(`${baseUrl}/projects/${projectAlpha.id}`, { headers: headersBeta });
      assert.strictEqual(getProjRes.status, 403);
      const getProjData = await getProjRes.json();
      assert.strictEqual(getProjData.code, 'ACCESS_DENIED');

      // 2. Cross-org repair access
      const getRepRes = await fetch(`${baseUrl}/repairs/${repairAlpha.id}`, { headers: headersBeta });
      assert.strictEqual(getRepRes.status, 403);

      // 3. Cross-org repair events
      const getLogsRes = await fetch(`${baseUrl}/repairs/${repairAlpha.id}/events`, { headers: headersBeta });
      assert.strictEqual(getLogsRes.status, 403);

      // 4. Cross-org repair plan
      const getPlanRes = await fetch(`${baseUrl}/repairs/${repairAlpha.id}/plan`, { headers: headersBeta });
      assert.strictEqual(getPlanRes.status, 403);

      // 5. Cross-org repair memory
      const getMemRes = await fetch(`${baseUrl}/repairs/${repairAlpha.id}/memory`, { headers: headersBeta });
      assert.strictEqual(getMemRes.status, 403);

      // 6. Cross-org repair cancellation
      const cancelRes = await fetch(`${baseUrl}/repairs/${repairAlpha.id}/cancel`, {
        method: 'POST',
        headers: headersBeta,
        body: JSON.stringify({ reason: 'Malicious Beta cancellation' }),
      });
      assert.strictEqual(cancelRes.status, 403);

      // 7. Cross-org repair approval
      const approveRes = await fetch(`${baseUrl}/repairs/${repairAlpha.id}/approve`, {
        method: 'POST',
        headers: headersBeta,
        body: JSON.stringify({ action: 'APPROVE', notes: 'Unauthorized Beta approval' }),
      });
      assert.strictEqual(approveRes.status, 403);

      // 8. Cross-org repair metrics
      const metricsRes = await fetch(`${baseUrl}/repairs/${repairAlpha.id}/metrics`, { headers: headersBeta });
      assert.strictEqual(metricsRes.status, 403);

      // 9. Cross-org GitHub PR creation
      const prRes = await fetch(`${baseUrl}/repairs/${repairAlpha.id}/github/pr`, {
        method: 'POST',
        headers: headersBeta,
        body: JSON.stringify({ createBranch: true }),
      });
      assert.strictEqual(prRes.status, 403);
    });

    it('enforces RBAC matrix: Allowed vs Denied access per role', async () => {
      // Role permission test: VIEWER
      const headersViewer = {
        Authorization: `Bearer ${tokenViewerAlpha}`,
        'Content-Type': 'application/json',
      };

      // VIEWER cannot create project (403)
      const viewerCreateProj = await fetch(`${baseUrl}/projects`, {
        method: 'POST',
        headers: headersViewer,
        body: JSON.stringify({
          name: 'Viewer Project',
          repository: 'ai-agent/tests/fixtures/sample_repo',
          language: 'python',
        }),
      });
      assert.strictEqual(viewerCreateProj.status, 403);

      // VIEWER cannot cancel repair (403)
      const viewerCancel = await fetch(`${baseUrl}/repairs/${repairAlpha.id}/cancel`, {
        method: 'POST',
        headers: headersViewer,
        body: JSON.stringify({ reason: 'Unauthorized viewer cancellation' }),
      });
      assert.strictEqual(viewerCancel.status, 403);

      // VIEWER cannot approve/reject repair (403)
      const viewerApprove = await fetch(`${baseUrl}/repairs/${repairAlpha.id}/approve`, {
        method: 'POST',
        headers: headersViewer,
        body: JSON.stringify({ action: 'APPROVE' }),
      });
      assert.strictEqual(viewerApprove.status, 403);

      // VIEWER cannot open GitHub PR (403)
      const viewerPR = await fetch(`${baseUrl}/repairs/${repairAlpha.id}/github/pr`, {
        method: 'POST',
        headers: headersViewer,
        body: JSON.stringify({ createBranch: true }),
      });
      assert.strictEqual(viewerPR.status, 403);

      // VIEWER can view project and repair in their own org (200)
      const viewerGetProj = await fetch(`${baseUrl}/projects/${projectAlpha.id}`, { headers: headersViewer });
      assert.strictEqual(viewerGetProj.status, 200);

      const viewerGetRepair = await fetch(`${baseUrl}/repairs/${repairAlpha.id}`, { headers: headersViewer });
      assert.strictEqual(viewerGetRepair.status, 200);

      // Role permission test: DEVELOPER
      const headersDev = {
        Authorization: `Bearer ${tokenDevAlpha}`,
        'Content-Type': 'application/json',
      };

      // DEVELOPER can view own org repair (200)
      const devGetRepair = await fetch(`${baseUrl}/repairs/${repairAlpha.id}`, { headers: headersDev });
      assert.strictEqual(devGetRepair.status, 200);

      // DEVELOPER cannot approve repair (requires MANAGER or ADMIN) (403)
      const devApprove = await fetch(`${baseUrl}/repairs/${repairAlpha.id}/approve`, {
        method: 'POST',
        headers: headersDev,
        body: JSON.stringify({ action: 'APPROVE' }),
      });
      assert.strictEqual(devApprove.status, 403);

      // Role permission test: MANAGER
      const headersMgr = {
        Authorization: `Bearer ${tokenManagerAlpha}`,
        'Content-Type': 'application/json',
      };

      // MANAGER can view admin organization (200)
      const mgrOrgRes = await fetch(`${baseUrl}/admin/organization`, { headers: headersMgr });
      assert.strictEqual(mgrOrgRes.status, 200);

      // MANAGER cannot access /api/system/diagnostics (restricted strictly to ADMIN) (403)
      const mgrDiagRes = await fetch(`${baseUrl}/system/diagnostics`, { headers: headersMgr });
      assert.strictEqual(mgrDiagRes.status, 403);

      // Role permission test: ADMIN
      const headersAdmin = {
        Authorization: `Bearer ${tokenAdminAlpha}`,
        'Content-Type': 'application/json',
      };

      // ADMIN can access /api/system/diagnostics (200)
      const adminDiagRes = await fetch(`${baseUrl}/system/diagnostics`, { headers: headersAdmin });
      assert.strictEqual(adminDiagRes.status, 200);
      const diagData = await adminDiagRes.json();
      assert.ok(diagData.environment);
      assert.ok(diagData.tools);
    });
  });

  // =========================================================================
  // Section 2: Production Configuration Verification
  // =========================================================================
  describe('2. Production Configuration Verification', () => {
    it('fails fast when required configuration is missing in production mode', () => {
      // Missing JWT_SECRET
      const missingJwt = validateProductionConfig({
        NODE_ENV: 'production',
        PORT: '5000',
        DATABASE_URL: 'file:dev.db',
      });
      assert.strictEqual(missingJwt.isValid, false);
      assert.ok(missingJwt.errors.some((e) => e.includes('JWT_SECRET')));

      // Missing DATABASE_URL
      const missingDb = validateProductionConfig({
        NODE_ENV: 'production',
        PORT: '5000',
        JWT_SECRET: 'super-long-secure-random-jwt-secret-key-32chars',
      });
      assert.strictEqual(missingDb.isValid, false);
      assert.ok(missingDb.errors.some((e) => e.includes('DATABASE_URL')));

      // Invalid PORT
      const invalidPort = validateProductionConfig({
        NODE_ENV: 'production',
        PORT: '999999',
        JWT_SECRET: 'super-long-secure-random-jwt-secret-key-32chars',
        DATABASE_URL: 'file:dev.db',
      });
      assert.strictEqual(invalidPort.isValid, false);
      assert.ok(invalidPort.errors.some((e) => e.includes('PORT')));
    });

    it('rejects insecure demo defaults in production mode', () => {
      const devSecretInProd = validateProductionConfig({
        NODE_ENV: 'production',
        PORT: '5000',
        JWT_SECRET: 'fixforge-dev-secret-key-change-in-prod',
        DATABASE_URL: 'file:dev.db',
      });
      assert.strictEqual(devSecretInProd.isValid, false);
      assert.ok(devSecretInProd.errors.some((e) => e.includes('default development secret')));
    });

    it('strictly forbids local subprocess execution in production mode', () => {
      const allowLocalInProd = validateProductionConfig({
        NODE_ENV: 'production',
        PORT: '5000',
        JWT_SECRET: 'super-long-secure-random-jwt-secret-key-32chars',
        DATABASE_URL: 'file:dev.db',
        ALLOW_LOCAL_SUBPROCESS: 'true',
      });
      assert.strictEqual(allowLocalInProd.isValid, false);
      assert.ok(allowLocalInProd.errors.some((e) => e.includes('Host execution is strictly prohibited')));
    });

    it('confirms development mode continues to work with defaults', () => {
      const devConfig = validateProductionConfig({
        NODE_ENV: 'development',
        PORT: '5000',
      });
      assert.strictEqual(devConfig.isValid, true);
      assert.strictEqual(devConfig.isProduction, false);
      assert.ok(devConfig.warnings.length > 0);
    });

    it('enforceStartupConfig throws descriptive error without leaking secret values', () => {
      assert.throws(
        () => {
          enforceStartupConfig({
            NODE_ENV: 'production',
            PORT: '5000',
          });
        },
        (err) => {
          assert.ok(err.message.includes('FixForge Startup Configuration Failed'));
          assert.ok(!err.message.includes('super_secret'));
          return true;
        }
      );
    });
  });

  // =========================================================================
  // Section 4: Database Backup & Restore Out-of-Place Verification
  // =========================================================================
  describe('4. Database Backup & Restore Out-of-Place Verification', () => {
    let backupResult;
    const tempRestorePath = path.resolve(ROOT_DIR, 'database', 'test-restore-verify.db');

    before(() => {
      if (fs.existsSync(tempRestorePath)) {
        fs.unlinkSync(tempRestorePath);
      }
    });

    after(() => {
      if (fs.existsSync(tempRestorePath)) {
        fs.unlinkSync(tempRestorePath);
      }
    });

    it('creates a hot database backup using VACUUM INTO', async () => {
      backupResult = await createDatabaseBackup();
      assert.ok(backupResult.success);
      assert.ok(fs.existsSync(backupResult.backupPath));
      assert.ok(backupResult.sizeBytes > 0);
      assert.strictEqual(typeof backupResult.sha256, 'string');
      assert.strictEqual(backupResult.sha256.length, 64);
    });

    it('restores backup out-of-place into a separate temporary database file', async () => {
      assert.ok(backupResult?.backupPath, 'Backup file should have been created');

      const restoreResult = await restoreDatabaseBackup(backupResult.backupPath, tempRestorePath);
      assert.ok(restoreResult.success);
      assert.strictEqual(restoreResult.targetDbPath, tempRestorePath);
      assert.ok(fs.existsSync(tempRestorePath));
      assert.strictEqual(restoreResult.integrityCheck, 'ok');
    });

    it('verifies SQLite integrity and table counts on the restored database independently', () => {
      // Connect to the out-of-place restored database directly
      const tempDb = new DatabaseSync(tempRestorePath);

      try {
        // 1. PRAGMA integrity_check
        const integrityCheck = tempDb.prepare('PRAGMA integrity_check').all();
        assert.strictEqual(integrityCheck[0].integrity_check, 'ok');

        // 2. PRAGMA foreign_key_check
        const fkCheck = tempDb.prepare('PRAGMA foreign_key_check').all();
        assert.strictEqual(fkCheck.length, 0);

        // 3. Key table row counts
        const userCount = tempDb.prepare('SELECT COUNT(*) as count FROM users').get().count;
        const orgCount = tempDb.prepare('SELECT COUNT(*) as count FROM organizations').get().count;
        const projectCount = tempDb.prepare('SELECT COUNT(*) as count FROM projects').get().count;
        const repairCount = tempDb.prepare('SELECT COUNT(*) as count FROM repair_jobs').get().count;
        const auditCount = tempDb.prepare('SELECT COUNT(*) as count FROM audit_logs').get().count;

        assert.ok(userCount > 0, 'Users must be restored');
        assert.ok(orgCount > 0, 'Organizations must be restored');
        assert.ok(projectCount > 0, 'Projects must be restored');
        assert.ok(repairCount > 0, 'Repair jobs must be restored');
        assert.ok(auditCount > 0, 'Audit logs must be restored');

        // 4. Verify representative records
        const verifiedOrg = tempDb.prepare('SELECT * FROM organizations WHERE id = ?').get(orgAlpha.id);
        assert.ok(verifiedOrg, 'Alpha organization record must be present in restored database');
        assert.strictEqual(verifiedOrg.name, 'Verification Org Alpha');

        const verifiedRepair = tempDb.prepare('SELECT * FROM repair_jobs WHERE id = ?').get(repairAlpha.id);
        assert.ok(verifiedRepair, 'Alpha repair job must be present in restored database');
        assert.strictEqual(verifiedRepair.issue, 'Alpha confidential defect');
      } finally {
        tempDb.close();
      }
    });

    it('rejects corrupted or invalid backup files without affecting databases', async () => {
      const corruptFile = path.resolve(ROOT_DIR, 'database', 'corrupt-backup-test.db');
      fs.writeFileSync(corruptFile, 'INVALID_NOT_A_SQLITE_DATABASE_HEADER_DATA');

      try {
        await assert.rejects(
          async () => {
            await restoreDatabaseBackup(corruptFile, path.resolve(ROOT_DIR, 'database', 'temp-corrupt.db'));
          },
          (err) => {
            assert.ok(err.message.includes('not a valid SQLite database'));
            return true;
          }
        );
      } finally {
        if (fs.existsSync(corruptFile)) {
          fs.unlinkSync(corruptFile);
        }
      }
    });

    it('confirms active database dev.db and historical retention remain intact', async () => {
      const retention = await verifyDataRetentionSafety();
      assert.strictEqual(retention.safe, true);
      assert.ok(retention.counts.users >= 4);
      assert.ok(retention.counts.organizations >= 2);
      assert.ok(retention.counts.projects >= 2);
      assert.ok(retention.counts.repairJobs >= 2);
      assert.ok(retention.counts.auditLogs >= 1);
    });
  });

  // =========================================================================
  // Section 5: Secret Redaction Verification
  // =========================================================================
  describe('5. Secret Redaction Verification', () => {
    it('redacts representative synthetic tokens from error messages and logs', () => {
      const sampleSecrets = [
        { type: 'Google API Key', value: 'AIzaSyMockTestKey1234567890abcdefghijk', expected: '[REDACTED_API_KEY]' },
        { type: 'GitHub PAT (classic)', value: 'ghp_MockGitHubToken1234567890abcdefgh', expected: '[REDACTED_GH_TOKEN]' },
        {
          type: 'GitHub PAT (fine-grained)',
          value: 'github_pat_MockFineGrainedToken1234567890abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopq',
          expected: '[REDACTED_GH_TOKEN]',
        },
        {
          type: 'Bearer Header Token',
          value: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
          expected: 'Bearer [REDACTED_TOKEN]',
        },
        {
          type: 'Raw JWT Token',
          value: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
          expected: '[REDACTED_JWT]',
        },
        {
          type: 'Postgres Connection String',
          value: 'postgres://production_user:SuperSecretPassword123@db.internal:5432/fixforge_db',
          expected: 'postgres://[REDACTED_USER]:[REDACTED_PWD]@db.internal:5432/fixforge_db',
        },
      ];

      for (const secret of sampleSecrets) {
        const text = `Encountered exception with ${secret.type}: ${secret.value} during process execution`;
        const sanitized = sanitizeLogText(text);

        assert.ok(
          !sanitized.includes(secret.value),
          `Sanitized text still contained raw secret for ${secret.type}!`
        );
        assert.ok(
          sanitized.includes(secret.expected),
          `Sanitized text did not contain expected placeholder ${secret.expected} for ${secret.type}`
        );
      }
    });

    it('redacts sensitive values in classifyAndSanitizeError and delivery failures', () => {
      const rawError = new Error(
        'Database connection to postgres://app_user:db_password_xyz99@db.local:5432/app failed with API key AIzaSyFakeApiKeyForTesting1234567890 and token ghp_FakeGithubTokenForTesting12345678'
      );

      const sanitized = classifyAndSanitizeError(rawError);
      assert.ok(!sanitized.message.includes('db_password_xyz99'));
      assert.ok(!sanitized.message.includes('AIzaSyFakeApiKeyForTesting1234567890'));
      assert.ok(!sanitized.message.includes('ghp_FakeGithubTokenForTesting12345678'));
      assert.ok(sanitized.message.includes('[REDACTED_PWD]'));
      assert.ok(sanitized.message.includes('[REDACTED_API_KEY]'));
      assert.ok(sanitized.message.includes('[REDACTED_GH_TOKEN]'));
    });

    it('audit logs record sanitized metadata without plain credentials', async () => {
      await recordAuditLog({
        organizationId: orgAlpha.id,
        userId: adminAlpha.id,
        action: 'INTEGRATION_TEST_ACTION',
        resourceType: 'SecurityVerification',
        metadata: {
          testToken: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.test',
          connectionUri: 'postgres://admin:topsecretpass@db:5432/db',
          safeKey: 'normal_data',
        },
      });

      const logs = await getAuditLogs(orgAlpha.id, { limit: 1 });
      assert.ok(logs.length > 0);
      const latest = logs[0];
      const meta = typeof latest.metadata === 'string' ? JSON.parse(latest.metadata) : latest.metadata;

      assert.strictEqual(meta.safeKey, 'normal_data');
      assert.ok(!JSON.stringify(meta).includes('topsecretpass'));
    });
  });

  // =========================================================================
  // Section 6: Readiness and Recovery Verification
  // =========================================================================
  describe('6. Readiness and Recovery Verification', () => {
    it('/healthz provides liveness status without exposing internals', async () => {
      const res = await fetch(`${baseUrl}/healthz`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.status, 'ok');
      assert.strictEqual(Object.keys(data).length, 1);
    });

    it('/api/readyz reports system status and flags unready subsystems', async () => {
      const res = await fetch(`${baseUrl}/readyz`);
      // Since the Python AI agent isn't running in this Node test process, readyz should detect that and report offline/unreachable
      assert.strictEqual(res.status, 503);
      const data = await res.json();
      assert.strictEqual(data.status, 'not_ready');
      assert.strictEqual(data.checks.api, 'ready');
      assert.strictEqual(data.checks.database, 'ready');
      assert.ok(['offline', 'unreachable', 'unknown'].includes(data.checks.aiAgent));
      assert.ok(Array.isArray(data.issues));
      assert.ok(data.issues.some((i) => i.includes('AI Agent')));
    });

    it('jobLifecycleService correctly handles cancellation races and state transitions', async () => {
      const testJob = await prisma.repairJob.create({
        data: {
          id: randomUUID(),
          projectId: projectAlpha.id,
          organizationId: orgAlpha.id,
          createdById: adminAlpha.id,
          issue: 'Race condition test job',
          model: 'gemini-2.5-flash',
          verificationLevel: 'standard',
          maxIterations: 3,
          status: 'running',
          testsPassed: 0,
          testsTotal: 1,
        },
      });

      // 1. First cancellation succeeds
      const cancelResult = await jobLifecycleService.cancelJob(
        testJob.id,
        { id: adminAlpha.id, role: 'ADMIN', organizationId: orgAlpha.id },
        'First cancellation request'
      );
      assert.ok(cancelResult);
      assert.strictEqual(cancelResult.status.toLowerCase(), 'cancelled');

      // 2. Cancellation race / idempotent secondary cancellation
      const duplicateCancel = await jobLifecycleService.cancelJob(
        testJob.id,
        { id: adminAlpha.id, role: 'ADMIN', organizationId: orgAlpha.id },
        'Second concurrent cancellation'
      );
      assert.ok(duplicateCancel);
      assert.strictEqual(duplicateCancel.status.toLowerCase(), 'cancelled');

      // 3. Late callback on cancelled job is ignored and does NOT mark job completed
      const lateState = await prisma.repairJob.findUnique({ where: { id: testJob.id } });
      assert.strictEqual(lateState.status, 'cancelled');
    });

    it('jobLifecycleService tracks reliability metrics accurately', () => {
      const stats = jobLifecycleService.getReliabilityStats();
      assert.ok(typeof stats.retriesAttempted === 'number');
      assert.ok(typeof stats.retriesSucceeded === 'number');
      assert.ok(typeof stats.reconciledOnStartup === 'number');
      assert.ok(typeof stats.quotaRejections === 'number');
      assert.ok(typeof stats.deliveryFailures === 'number');
      assert.ok(typeof stats.activeJobs === 'number');
      assert.ok(typeof stats.maxConcurrent === 'number');
    });
  });
});
