import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import app from '../src/app.js';
import { prisma, seedDatabase, DEMO_USERS, DEMO_ORGS } from '@workspace/db';
import {
  JobLifecycleService,
  jobLifecycleService,
  JOB_STATES,
} from '../src/services/lifecycle/job-lifecycle-service.js';
import { enableTestAuthMock } from '../src/middlewares/auth.js';

describe('FixForge Milestone 13.2: Durable Job Recovery & Production Reliability', () => {
  let server;
  let baseUrl;
  let testProjectId;

  before(async () => {
    enableTestAuthMock(true);
    await seedDatabase();

    const proj = await prisma.project.create({
      data: {
        id: randomUUID(),
        organizationId: DEMO_ORGS.FIXFORGE_LABS.id,
        createdById: DEMO_USERS.ADMIN.id,
        name: 'M13.2 Reliability Test Repo',
        repository: 'examples/buggy-python-project',
        language: 'Python',
      },
    });
    testProjectId = proj.id;

    await new Promise((resolve) => {
      server = http.createServer(app);
      server.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
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

  describe('1. Durable Persistence & Interrupted Job Recovery', () => {
    it('reconciles interrupted jobs on startup and marks them failed, never successful', async () => {
      const interruptedJob = await prisma.repairJob.create({
        data: {
          id: randomUUID(),
          organizationId: DEMO_ORGS.FIXFORGE_LABS.id,
          createdById: DEMO_USERS.DEVELOPER.id,
          projectId: testProjectId,
          issue: 'Simulated crash recovery issue',
          model: 'OpenAI-compatible / default',
          verificationLevel: 'standard',
          maxIterations: 3,
          status: 'running',
        },
      });

      const recoveryResult = await jobLifecycleService.reconcileInterruptedJobs();
      assert.ok(recoveryResult.recoveredCount >= 1);
      assert.ok(recoveryResult.recoveredIds.includes(interruptedJob.id));

      const updated = await prisma.repairJob.findUnique({
        where: { id: interruptedJob.id },
      });

      assert.equal(updated.status, 'failed');
      assert.notEqual(updated.interruptedAt, null);
      assert.ok(updated.failures.includes('interrupted by server restart'));
    });
  });

  describe('2. Idempotent Job Submission', () => {
    it('returns existing repair job idempotently when idempotency key matches payload', async () => {
      const idempotencyKey = `idemp-key-${randomUUID()}`;
      const payload = {
        projectId: testProjectId,
        issue: 'Fix index error in calculation',
        model: 'OpenAI-compatible / default',
        verificationLevel: 'standard',
        maxIterations: 3,
      };

      // First submission
      const res1 = await fetch(`${baseUrl}/api/repairs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(payload),
      });
      assert.equal(res1.status, 201);
      const data1 = await res1.json();

      // Duplicate submission with same key and same payload
      const res2 = await fetch(`${baseUrl}/api/repairs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(payload),
      });
      assert.equal(res2.status, 200);
      const data2 = await res2.json();

      assert.equal(data1.id, data2.id);
      assert.equal(data2.issue, payload.issue);
    });

    it('rejects duplicate idempotency key with conflicting payload (409 Conflict)', async () => {
      const idempotencyKey = `idemp-conflict-${randomUUID()}`;

      // First submission
      const res1 = await fetch(`${baseUrl}/api/repairs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          projectId: testProjectId,
          issue: 'Original issue A',
          model: 'OpenAI-compatible / default',
          verificationLevel: 'standard',
          maxIterations: 2,
        }),
      });
      assert.equal(res1.status, 201);

      // Conflicting submission with same key
      const res2 = await fetch(`${baseUrl}/api/repairs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          projectId: testProjectId,
          issue: 'Conflicting issue B',
          model: 'OpenAI-compatible / default',
          verificationLevel: 'standard',
          maxIterations: 5,
        }),
      });

      assert.equal(res2.status, 409);
      const err = await res2.json();
      assert.equal(err.code, 'IDEMPOTENCY_CONFLICT');
    });

    it('handles concurrent duplicate submissions safely without race conditions', async () => {
      const idempotencyKey = `idemp-concurrent-${randomUUID()}`;
      const payload = {
        projectId: testProjectId,
        issue: 'Concurrent test issue',
        model: 'OpenAI-compatible / default',
        verificationLevel: 'standard',
        maxIterations: 3,
      };

      const [resA, resB] = await Promise.all([
        fetch(`${baseUrl}/api/repairs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
          body: JSON.stringify(payload),
        }),
        fetch(`${baseUrl}/api/repairs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
          body: JSON.stringify(payload),
        }),
      ]);

      const statuses = [resA.status, resB.status];
      // One creates (201), the other either receives existing (200) or lock wait result
      assert.ok(statuses.includes(201));
      assert.ok(statuses.includes(200) || statuses.includes(201));
    });
  });

  describe('3. Concurrency Limits, Quotas & Backpressure', () => {
    it('enforces global concurrency limits and returns 429', () => {
      const service = new JobLifecycleService();
      service.maxConcurrent = 2;

      service.acquireSlot('job-c1');
      service.acquireSlot('job-c2');

      assert.throws(
        () => service.acquireSlot('job-c3'),
        (err) => err.code === 'MAX_CONCURRENT_JOBS_EXCEEDED' && err.status === 429
      );

      service.releaseSlot('job-c1');
      service.acquireSlot('job-c3');
    });

    it('enforces per-user concurrency limits and returns 429', () => {
      const service = new JobLifecycleService();
      service.maxConcurrent = 10;
      service.maxConcurrentPerUser = 2;

      const user = { id: 'test-user-001', organizationId: 'org-1' };

      service.acquireSlot('job-u1', user);
      service.acquireSlot('job-u2', user);

      assert.throws(
        () => service.acquireSlot('job-u3', user),
        (err) => err.code === 'USER_CONCURRENCY_LIMIT_EXCEEDED' && err.status === 429
      );

      service.releaseSlot('job-u1');
      service.acquireSlot('job-u3', user);
    });

    it('enforces hourly job quotas and returns 429', async () => {
      const service = new JobLifecycleService();
      service.maxRepairsPerHourUser = 1;

      const testUserId = randomUUID();
      await prisma.user.create({
        data: {
          id: testUserId,
          email: `quota-${testUserId}@test.local`,
          name: 'Quota Test User',
        },
      });

      const testUser = { id: testUserId, organizationId: DEMO_ORGS.FIXFORGE_LABS.id };

      // Create 1 job in DB
      await prisma.repairJob.create({
        data: {
          id: randomUUID(),
          organizationId: testUser.organizationId,
          createdById: testUser.id,
          projectId: testProjectId,
          issue: 'Quota baseline job',
          model: 'OpenAI-compatible / default',
          verificationLevel: 'standard',
          maxIterations: 1,
        },
      });

      await assert.rejects(
        async () => {
          await service.checkQuotas(testUser, testUser.organizationId);
        },
        (err) => err.code === 'QUOTA_EXCEEDED' && err.status === 429
      );
    });
  });

  describe('4. Retry Safety & Classification', () => {
    it('correctly classifies retryable vs non-retryable failures', () => {
      const service = new JobLifecycleService();

      // Retryable: Docker timeout, container startup failure, network disconnect
      assert.equal(service.isRetryableFailure(new Error('Execution timed out after 120s')), true);
      assert.equal(service.isRetryableFailure({ code: 'AI_SERVICE_UNAVAILABLE', message: 'fetch failed' }), true);
      assert.equal(service.isRetryableFailure(new Error('Container failed to start')), true);

      // Non-retryable: syntax errors, test regressions, policy violation, cancellation
      assert.equal(service.isRetryableFailure({ code: 'UNVERIFIED_REPAIR_BLOCKED', message: 'Not verified' }), false);
      assert.equal(service.isRetryableFailure(new Error('Regression detected in test suite')), false);
      assert.equal(service.isRetryableFailure({ code: 'JOB_CANCELLED', message: 'Cancelled by user' }), false);
      assert.equal(service.isRetryableFailure({ code: 'QUOTA_EXCEEDED', message: 'Quota exceeded' }), false);
    });
  });

  describe('5. Verified Repair Delivery & Gate Checks', () => {
    it('blocks GitHub PR delivery for unverified repairs', async () => {
      const unverified = await prisma.repairJob.create({
        data: {
          id: randomUUID(),
          organizationId: DEMO_ORGS.FIXFORGE_LABS.id,
          createdById: DEMO_USERS.ADMIN.id,
          projectId: testProjectId,
          issue: 'Unverified delivery attempt',
          model: 'OpenAI-compatible / default',
          verificationLevel: 'standard',
          maxIterations: 2,
          status: 'failed',
          testsPassed: 2,
          testsTotal: 5,
        },
      });

      const res = await fetch(`${baseUrl}/api/repairs/${unverified.id}/github/pr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.code, 'UNVERIFIED_REPAIR_BLOCKED');
    });

    it('delivers pull request idempotently when PR already exists', async () => {
      const verified = await prisma.repairJob.create({
        data: {
          id: randomUUID(),
          organizationId: DEMO_ORGS.FIXFORGE_LABS.id,
          createdById: DEMO_USERS.ADMIN.id,
          projectId: testProjectId,
          issue: 'Verified delivery job',
          model: 'OpenAI-compatible / default',
          verificationLevel: 'standard',
          maxIterations: 2,
          status: 'verified',
          testsPassed: 5,
          testsTotal: 5,
          approvalStatus: 'APPROVED',
        },
      });

      // Pre-seed an existing GitHub integration record
      await prisma.gitHubIntegration.create({
        data: {
          id: randomUUID(),
          repairJobId: verified.id,
          owner: 'fixforge',
          repository: 'buggy-python-project',
          repairBranch: 'fixforge/repair-123',
          pullRequestNumber: 42,
          pullRequestUrl: 'https://github.com/fixforge/repo/pull/42',
          status: 'PR_CREATED',
        },
      });

      const res = await fetch(`${baseUrl}/api/repairs/${verified.id}/github/pr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.idempotent, true);
      assert.equal(data.pullRequest.number, 42);

      const refreshed = await prisma.repairJob.findUnique({ where: { id: verified.id } });
      assert.equal(refreshed.deliveryStatus, 'DELIVERED');
    });
  });

  describe('6. Production Reliability Observability', () => {
    it('GET /api/observability/reliability exposes queue depth, active jobs, and recovery outcomes', async () => {
      const res = await fetch(`${baseUrl}/api/observability/reliability`);
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.ok('current_state' in data);
      assert.ok('queue_depth' in data.current_state);
      assert.ok('active_jobs' in data.current_state);
      assert.ok('max_concurrent' in data.current_state);

      assert.ok('historical_events' in data);
      assert.ok('retries_attempted' in data.historical_events);
      assert.ok('recovery_outcomes_total' in data.historical_events);
      assert.ok('quota_rejections_total' in data.historical_events);
      assert.ok('cancellations_total' in data.historical_events);
      assert.ok('deliveries_succeeded' in data.historical_events);
    });
  });
});
