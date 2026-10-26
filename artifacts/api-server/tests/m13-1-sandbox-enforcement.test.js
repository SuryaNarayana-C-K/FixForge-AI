import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import app from '../src/app.js';
import { prisma, seedDatabase } from '@workspace/db';
import {
  JobLifecycleService,
  JOB_STATES,
} from '../src/services/lifecycle/job-lifecycle-service.js';

describe('FixForge Milestone 13.1: Docker Sandbox Enforcement & Job Lifecycle Reliability', () => {
  let server;
  let baseUrl;
  let testProjectId;

  before(async () => {
    await seedDatabase();

    // Create a dedicated test project
    const proj = await prisma.project.create({
      data: {
        id: randomUUID(),
        name: 'M13.1 Lifecycle Test Repo',
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
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  describe('1. Job Lifecycle State Machine & Transition Rules', () => {
    it('validates legal transitions QUEUED -> RUNNING -> VERIFYING -> SUCCEEDED', () => {
      const service = new JobLifecycleService();

      assert.equal(service.validateTransition(JOB_STATES.QUEUED, JOB_STATES.RUNNING), true);
      assert.equal(service.validateTransition(JOB_STATES.RUNNING, JOB_STATES.VERIFYING), true);
      assert.equal(service.validateTransition(JOB_STATES.VERIFYING, JOB_STATES.SUCCEEDED), true);
    });

    it('rejects illegal transitions (QUEUED -> SUCCEEDED, SUCCEEDED -> RUNNING)', () => {
      const service = new JobLifecycleService();

      assert.throws(
        () => service.validateTransition(JOB_STATES.QUEUED, JOB_STATES.SUCCEEDED),
        /Invalid state transition/
      );

      assert.throws(
        () => service.validateTransition(JOB_STATES.SUCCEEDED, JOB_STATES.RUNNING),
        /Cannot transition from terminal state/
      );
    });

    it('locks terminal CANCELLED and TIMED_OUT states against late success callbacks', () => {
      const service = new JobLifecycleService();

      // Late success callback after CANCELLED must be rejected
      assert.throws(
        () => service.validateTransition(JOB_STATES.CANCELLED, JOB_STATES.SUCCEEDED),
        /Cannot transition from terminal state CANCELLED to SUCCEEDED: late update ignored/
      );

      // Late success callback after TIMED_OUT must be rejected
      assert.throws(
        () => service.validateTransition(JOB_STATES.TIMED_OUT, JOB_STATES.SUCCEEDED),
        /Cannot transition from terminal state TIMED_OUT to SUCCEEDED: late update ignored/
      );
    });

    it('normalizes legacy and lowercase statuses to canonical states', () => {
      const service = new JobLifecycleService();

      assert.equal(service.canonicalState('queued'), JOB_STATES.QUEUED);
      assert.equal(service.canonicalState('self_correcting'), JOB_STATES.RUNNING);
      assert.equal(service.canonicalState('running'), JOB_STATES.RUNNING);
      assert.equal(service.canonicalState('testing'), JOB_STATES.VERIFYING);
      assert.equal(service.canonicalState('verified'), JOB_STATES.SUCCEEDED);
      assert.equal(service.canonicalState('cancelled'), JOB_STATES.CANCELLED);
      assert.equal(service.canonicalState('timeout'), JOB_STATES.TIMED_OUT);
    });
  });

  describe('2. Concurrency Limits & Duplicate Execution Guard', () => {
    it('enforces maximum concurrent repair job capacity', () => {
      const service = new JobLifecycleService();
      service.maxConcurrent = 2;

      service.acquireSlot('job-slot-1');
      service.acquireSlot('job-slot-2');

      const stats = service.getConcurrencyStats();
      assert.equal(stats.activeJobs, 2);
      assert.equal(stats.availableSlots, 0);

      // 3rd attempt exceeds capacity
      assert.throws(
        () => service.acquireSlot('job-slot-3'),
        /Maximum concurrent repair capacity reached/
      );

      // Release slot frees capacity
      service.releaseSlot('job-slot-1');
      assert.equal(service.getConcurrencyStats().availableSlots, 1);
      service.acquireSlot('job-slot-3');
      assert.equal(service.getConcurrencyStats().activeJobs, 2);
    });

    it('prevents duplicate execution of the same active job', () => {
      const service = new JobLifecycleService();

      service.acquireSlot('job-dup-test');

      assert.throws(
        () => service.acquireSlot('job-dup-test'),
        /already running/
      );

      service.releaseSlot('job-dup-test');
    });
  });

  describe('3. Job Cancellation API & Idempotency', () => {
    it('cancels a repair job and transitions status to cancelled', async () => {
      // 1. Create a repair job
      const createRes = await fetch(`${baseUrl}/api/repairs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-demo-role': 'ADMIN' },
        body: JSON.stringify({
          projectId: testProjectId,
          issue: 'Fix division by zero bug',
          model: 'gemini-2.0-flash',
          verificationLevel: 'standard',
          maxIterations: 3,
        }),
      });
      assert.equal(createRes.status, 201);
      const repair = await createRes.json();

      // 2. Cancel the job via POST /api/repairs/:repairId/cancel
      const cancelRes = await fetch(`${baseUrl}/api/repairs/${repair.id}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-demo-role': 'ADMIN' },
        body: JSON.stringify({ reason: 'Operator requested cancellation' }),
      });
      assert.equal(cancelRes.status, 200);
      const cancelData = await cancelRes.json();
      assert.equal(cancelData.success, true);
      assert.equal(cancelData.status, 'cancelled');
      assert.equal(cancelData.idempotent, false);

      // 3. Verify in database
      const dbRecord = await prisma.repairJob.findUnique({ where: { id: repair.id } });
      assert.equal(dbRecord.status, 'cancelled');

      // 4. Repeated cancel is idempotent
      const cancelRes2 = await fetch(`${baseUrl}/api/repairs/${repair.id}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-demo-role': 'ADMIN' },
      });
      assert.equal(cancelRes2.status, 200);
      const cancelData2 = await cancelRes2.json();
      assert.equal(cancelData2.success, true);
      assert.equal(cancelData2.idempotent, true);
    });

    it('queries lifecycle status via GET /api/repairs/:repairId/lifecycle', async () => {
      const createRes = await fetch(`${baseUrl}/api/repairs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-demo-role': 'ADMIN' },
        body: JSON.stringify({
          projectId: testProjectId,
          issue: 'Test lifecycle query',
          model: 'gemini-2.0-flash',
          verificationLevel: 'standard',
          maxIterations: 3,
        }),
      });
      const repair = await createRes.json();

      const lifeRes = await fetch(`${baseUrl}/api/repairs/${repair.id}/lifecycle`, {
        headers: { 'x-demo-role': 'ADMIN' },
      });
      assert.equal(lifeRes.status, 200);
      const lifeData = await lifeRes.json();
      assert.equal(lifeData.repairId, repair.id);
      assert.equal(lifeData.canonicalState, 'QUEUED');
      assert.equal(lifeData.active, false);
    });

    it('queries operational concurrency stats via GET /api/repairs/stats/concurrency', async () => {
      const statsRes = await fetch(`${baseUrl}/api/repairs/stats/concurrency`, {
        headers: { 'x-demo-role': 'ADMIN' },
      });
      assert.equal(statsRes.status, 200);
      const stats = await statsRes.json();
      assert.ok('activeJobs' in stats);
      assert.ok('maxConcurrent' in stats);
      assert.ok('availableSlots' in stats);
      assert.ok(stats.maxConcurrent >= 1);
    });
  });
});
