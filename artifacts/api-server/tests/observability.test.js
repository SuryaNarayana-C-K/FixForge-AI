import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import app from '../src/app.js';
import { prisma, seedDatabase } from '@workspace/db';
import {
  recordRepairEvent,
  getRepairEvents,
  sanitizeSecrets,
  REPAIR_EVENT_TYPES,
} from '../src/services/observability/event-service.js';
import { MetricsService } from '../src/services/observability/metrics-service.js';

describe('FixForge Milestone 7 - Observability & Intelligence Tests', () => {
  let server;
  let baseUrl;
  let metricsService;
  let testProjectId;

  before(async () => {
    await seedDatabase();
    metricsService = new MetricsService();

    // Start ephemeral test HTTP server
    await new Promise((resolve) => {
      server = http.createServer(app);
      server.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    const project = await prisma.project.findFirst();
    testProjectId = project?.id;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
  });

  // 1. Security / Secret Redaction Tests (Part 16)
  describe('Security & Secret Redaction', () => {
    it('redacts GitHub personal access tokens, Bearer tokens, and OpenAI API keys', () => {
      const rawMessage = 'Authenticated using Bearer secret-token-123 and ghp_ABC12345678901234567890 with sk-123456789012345678901234';
      const clean = sanitizeSecrets(rawMessage);

      assert.ok(!clean.includes('secret-token-123'));
      assert.ok(!clean.includes('ghp_ABC12345678901234567890'));
      assert.ok(!clean.includes('sk-123456789012345678901234'));
      assert.ok(clean.includes('Bearer ***REDACTED***'));
      assert.ok(clean.includes('***REDACTED_TOKEN***'));
      assert.ok(clean.includes('***REDACTED_API_KEY***'));
    });

    it('redacts sensitive keys within metadata objects recursively', () => {
      const rawMetadata = {
        githubToken: 'ghp_secrettokenvalue123456',
        apiKey: 'sk-abcdef123456789012345678',
        password: 'my-super-secret-password',
        authHeader: 'Bearer xyz',
        safeData: {
          testCount: 5,
          userSecret: 'confidential',
        },
      };

      const clean = sanitizeSecrets(rawMetadata);
      assert.equal(clean.githubToken, '***REDACTED***');
      assert.equal(clean.apiKey, '***REDACTED***');
      assert.equal(clean.password, '***REDACTED***');
      assert.equal(clean.authHeader, '***REDACTED***');
      assert.equal(clean.safeData.testCount, 5);
      assert.equal(clean.safeData.userSecret, '***REDACTED***');
    });

    it('never persists secrets into RepairEvent records in SQLite', async () => {
      const repairId = randomUUID();
      await prisma.repairJob.create({
        data: {
          id: repairId,
          projectId: testProjectId,
          issue: 'Secret test issue',
          model: 'test-model',
          verificationLevel: 'standard',
          maxIterations: 3,
          status: 'queued',
        },
      });

      const event = await recordRepairEvent({
        repairId,
        eventType: REPAIR_EVENT_TYPES.BASELINE_STARTED,
        status: 'info',
        message: 'Calling with Authorization: Bearer secret-auth-token-999',
        metadata: {
          token: 'ghp_supersecretvalue987654321',
          openAiKey: 'sk-key12345678901234567890',
        },
      });

      assert.ok(!event.message.includes('secret-auth-token-999'));
      assert.ok(!event.metadata.includes('ghp_supersecretvalue987654321'));
      assert.ok(!event.metadata.includes('sk-key12345678901234567890'));

      const retrieved = await prisma.repairEvent.findUnique({ where: { id: event.id } });
      assert.ok(!retrieved.message.includes('secret-auth-token-999'));
      assert.ok(!retrieved.metadata.includes('ghp_supersecretvalue987654321'));
    });
  });

  // 2. Event Persistence & Ordering Tests (Part 1, 2, 3)
  describe('Event Persistence & Ordering', () => {
    it('persists structured RepairEvent records with durationMs and metadata', async () => {
      const repairId = randomUUID();
      await prisma.repairJob.create({
        data: {
          id: repairId,
          projectId: testProjectId,
          issue: 'Event persistence test',
          model: 'test-model',
          verificationLevel: 'standard',
          maxIterations: 3,
          status: 'queued',
        },
      });

      const ev = await recordRepairEvent({
        repairId,
        eventType: REPAIR_EVENT_TYPES.ROOT_CAUSE_COMPLETED,
        status: 'info',
        message: 'Root cause identified: zero division bug',
        metadata: { hypothesis: 'Missing guard check on divisor', confidence: 0.95 },
        durationMs: 1450,
      });

      assert.ok(ev.id);
      assert.equal(ev.repairId, repairId);
      assert.equal(ev.eventType, REPAIR_EVENT_TYPES.ROOT_CAUSE_COMPLETED);
      assert.equal(ev.durationMs, 1450);

      const dbRecord = await prisma.repairEvent.findUnique({ where: { id: ev.id } });
      assert.ok(dbRecord);
      assert.equal(dbRecord.durationMs, 1450);
      assert.ok(dbRecord.metadata.includes('Missing guard check'));
    });

    it('returns events in chronological order', async () => {
      const repairId = randomUUID();
      await prisma.repairJob.create({
        data: {
          id: repairId,
          projectId: testProjectId,
          issue: 'Ordering test',
          model: 'test-model',
          verificationLevel: 'standard',
          maxIterations: 3,
          status: 'queued',
        },
      });

      await recordRepairEvent({
        repairId,
        eventType: REPAIR_EVENT_TYPES.REPAIR_QUEUED,
        message: 'First: queued',
      });
      await new Promise((r) => setTimeout(r, 10));

      await recordRepairEvent({
        repairId,
        eventType: REPAIR_EVENT_TYPES.REPOSITORY_DISCOVERED,
        message: 'Second: repo discovered',
      });
      await new Promise((r) => setTimeout(r, 10));

      await recordRepairEvent({
        repairId,
        eventType: REPAIR_EVENT_TYPES.BASELINE_STARTED,
        message: 'Third: baseline started',
      });

      const events = await getRepairEvents(repairId);
      assert.equal(events.length, 3);
      assert.equal(events[0].eventType, REPAIR_EVENT_TYPES.REPAIR_QUEUED);
      assert.equal(events[1].eventType, REPAIR_EVENT_TYPES.REPOSITORY_DISCOVERED);
      assert.equal(events[2].eventType, REPAIR_EVENT_TYPES.BASELINE_STARTED);
      assert.ok(new Date(events[0].createdAt).getTime() <= new Date(events[1].createdAt).getTime());
    });
  });

  // 3. Metrics Calculation & Duration Tests (Part 4, 5)
  describe('Metrics Calculation & Stage Durations', () => {
    it('calculates accurate success rates and metrics across multiple repairs', async () => {
      const metrics = await metricsService.getOverviewMetrics();

      assert.equal(typeof metrics.totalRepairs, 'number');
      assert.equal(typeof metrics.verifiedRepairs, 'number');
      assert.equal(typeof metrics.failedRepairs, 'number');
      assert.equal(typeof metrics.successRate, 'number');
      assert.equal(typeof metrics.averageRepairDuration, 'number');
      assert.equal(typeof metrics.averageAttempts, 'number');
      assert.ok(metrics.successRate >= 0 && metrics.successRate <= 100);
    });

    it('handles repairs with attempts and stage timings', async () => {
      const repairId = randomUUID();
      await prisma.repairJob.create({
        data: {
          id: repairId,
          projectId: testProjectId,
          issue: 'Duration calculation test',
          model: 'test-model',
          verificationLevel: 'standard',
          maxIterations: 3,
          status: 'verified',
          testsPassed: 5,
          testsTotal: 5,
        },
      });

      await recordRepairEvent({
        repairId,
        eventType: REPAIR_EVENT_TYPES.BASELINE_COMPLETED,
        status: 'info',
        durationMs: 1200,
      });

      await recordRepairEvent({
        repairId,
        eventType: REPAIR_EVENT_TYPES.ROOT_CAUSE_COMPLETED,
        status: 'info',
        durationMs: 800,
      });

      await recordRepairEvent({
        repairId,
        eventType: REPAIR_EVENT_TYPES.REPAIR_VERIFIED,
        status: 'success',
        durationMs: 4500,
      });

      await prisma.repairAttempt.create({
        data: {
          id: randomUUID(),
          repairJobId: repairId,
          attemptNumber: 1,
          status: 'PASSED',
          duration: 3.5,
          verificationResult: JSON.stringify({ passed: 5, total: 5, status: 'PASSED' }),
        },
      });

      const repairMetrics = await metricsService.getRepairMetrics(repairId);
      assert.ok(repairMetrics);
      assert.equal(repairMetrics.repairId, repairId);
      assert.equal(repairMetrics.status, 'verified');
      assert.equal(repairMetrics.stageDurations.baselineTestingDurationMs, 1200);
      assert.equal(repairMetrics.stageDurations.rootCauseAnalysisDurationMs, 800);
      assert.equal(repairMetrics.stageDurations.totalDurationSeconds, 4.5);
      assert.equal(repairMetrics.attempts.length, 1);
      assert.equal(repairMetrics.attempts[0].testsPassed, 5);
      assert.equal(repairMetrics.attempts[0].testsTotal, 5);
    });
  });

  // 4. Attempt Analytics Tests (Part 7)
  describe('Attempt Analytics', () => {
    it('captures full attempt details including test count, root cause, and verification', async () => {
      const repairId = randomUUID();
      await prisma.repairJob.create({
        data: {
          id: repairId,
          projectId: testProjectId,
          issue: 'Attempt analytics test',
          model: 'test-model',
          verificationLevel: 'standard',
          maxIterations: 3,
          status: 'verified',
        },
      });

      // Attempt 1: Failed
      await prisma.repairAttempt.create({
        data: {
          id: randomUUID(),
          repairJobId: repairId,
          attemptNumber: 1,
          status: 'FAILED',
          duration: 2.1,
          failureSummary: 'test_divide_by_zero_is_safe failed',
          rootCause: JSON.stringify({ hypothesis: 'ZeroDivisionError in divide()' }),
          verificationResult: JSON.stringify({ passed: 4, total: 5, failed: 1, status: 'FAILED' }),
          rollbackPerformed: true,
        },
      });

      // Attempt 2: Verified
      await prisma.repairAttempt.create({
        data: {
          id: randomUUID(),
          repairJobId: repairId,
          attemptNumber: 2,
          status: 'VERIFIED',
          duration: 1.8,
          failureSummary: null,
          rootCause: JSON.stringify({ hypothesis: 'Handled ZeroDivisionError' }),
          verificationResult: JSON.stringify({ passed: 5, total: 5, failed: 0, status: 'PASSED' }),
          rollbackPerformed: false,
        },
      });

      const metrics = await metricsService.getRepairMetrics(repairId);
      assert.equal(metrics.attempts.length, 2);

      const att1 = metrics.attempts[0];
      assert.equal(att1.attemptNumber, 1);
      assert.equal(att1.status, 'FAILED');
      assert.equal(att1.testsPassed, 4);
      assert.equal(att1.testsTotal, 5);
      assert.equal(att1.testsFailed, 1);
      assert.equal(att1.rollbackPerformed, true);
      assert.ok(att1.rootCauseSummary.includes('ZeroDivisionError'));

      const att2 = metrics.attempts[1];
      assert.equal(att2.attemptNumber, 2);
      assert.equal(att2.status, 'VERIFIED');
      assert.equal(att2.testsPassed, 5);
      assert.equal(att2.testsTotal, 5);
      assert.equal(att2.testsFailed, 0);
      assert.equal(att2.rollbackPerformed, false);
    });
  });

  // 5. Observability API Endpoints Tests (Part 6)
  describe('Observability HTTP Endpoints', () => {
    it('GET /api/observability/overview returns valid platform metrics', async () => {
      const res = await fetch(`${baseUrl}/api/observability/overview`);
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.equal(typeof data.totalRepairs, 'number');
      assert.equal(typeof data.verifiedRepairs, 'number');
      assert.equal(typeof data.failedRepairs, 'number');
      assert.equal(typeof data.successRate, 'number');
      assert.equal(typeof data.averageAttempts, 'number');
      assert.equal(typeof data.prCount, 'number');
      assert.ok(data.repairsByStatus && typeof data.repairsByStatus === 'object');
    });

    it('GET /api/observability/trends returns time-series array', async () => {
      const res = await fetch(`${baseUrl}/api/observability/trends?days=7`);
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.ok(Array.isArray(data));
      assert.equal(data.length, 7);
      assert.ok(data[0].date);
      assert.equal(typeof data[0].verified, 'number');
      assert.equal(typeof data[0].failed, 'number');
    });

    it('GET /api/observability/recent returns recent repairs with repository and tests', async () => {
      const res = await fetch(`${baseUrl}/api/observability/recent?limit=5`);
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.ok(Array.isArray(data));
      if (data.length > 0) {
        assert.ok(data[0].repairId);
        assert.ok(data[0].status);
        assert.ok('attempts' in data[0]);
      }
    });

    it('GET /api/repairs/:repairId/events returns chronological repair events', async () => {
      const repair = await prisma.repairJob.findFirst();
      if (!repair) return;

      const res = await fetch(`${baseUrl}/api/repairs/${repair.id}/events`);
      assert.equal(res.status, 200);
      const events = await res.json();
      assert.ok(Array.isArray(events));
      if (events.length > 0) {
        assert.ok(events[0].id);
        assert.ok(events[0].repairId);
        assert.ok(events[0].event || events[0].eventType);
      }
    });

    it('GET /api/repairs/:repairId/metrics returns stage durations and attempt analytics', async () => {
      const repair = await prisma.repairJob.findFirst();
      if (!repair) return;

      const res = await fetch(`${baseUrl}/api/repairs/${repair.id}/metrics`);
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.equal(data.repairId, repair.id);
      assert.ok(data.stageDurations);
      assert.ok(Array.isArray(data.attempts));
      assert.ok(data.telemetry);
    });

    it('GET /api/repairs/:repairId/metrics returns 404 for invalid repair ID', async () => {
      const res = await fetch(`${baseUrl}/api/repairs/non-existent-uuid-12345/metrics`);
      assert.equal(res.status, 404);
    });
  });
});
