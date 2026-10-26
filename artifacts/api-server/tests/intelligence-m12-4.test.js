import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import app from '../src/app.js';
import { prisma, seedDatabase, DEMO_USERS, DEMO_ORGS } from '@workspace/db';
import { MetricsService } from '../src/services/observability/metrics-service.js';

describe('FixForge Milestone 12.4: Repair Intelligence & Benchmark Comparison Tests', () => {
  let server;
  let baseUrl;
  let metricsService;
  let orgAId;
  let orgBId;
  let projectAId;
  let projectBId;

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

    orgAId = DEMO_ORGS.FIXFORGE_LABS.id;

    // Create a secondary organization for tenant isolation tests
    const secondaryOrg = await prisma.organization.upsert({
      where: { slug: 'acme-corp-m124' },
      update: {},
      create: {
        id: randomUUID(),
        name: 'Acme Corp M12.4',
        slug: 'acme-corp-m124',
      },
    });
    orgBId = secondaryOrg.id;

    // Create projects for Org A and Org B
    const projA = await prisma.project.create({
      data: {
        id: randomUUID(),
        organizationId: orgAId,
        name: 'Project Alpha',
        repository: 'fixforge/project-alpha',
        language: 'Python',
      },
    });
    projectAId = projA.id;

    const projB = await prisma.project.create({
      data: {
        id: randomUUID(),
        organizationId: orgBId,
        name: 'Project Beta',
        repository: 'acme/project-beta',
        language: 'TypeScript',
      },
    });
    projectBId = projB.id;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // =========================================================================
  // 1. Precise Metric Formulas & Verification Population
  // =========================================================================
  describe('1. Metric Formulas & Applicable Populations', () => {
    it('calculates verified repair rate on evaluated jobs only, excluding in-progress jobs from denominator', async () => {
      const uniqueSuffix = randomUUID().slice(0, 8);

      // Create 2 verified jobs
      for (let i = 0; i < 2; i++) {
        await prisma.repairJob.create({
          data: {
            id: randomUUID(),
            organizationId: orgAId,
            projectId: projectAId,
            issue: `Verified issue ${uniqueSuffix} ${i}`,
            model: 'gemini-2.5-flash',
            verificationLevel: 'standard',
            maxIterations: 3,
            status: 'verified',
            testsPassed: 5,
            testsTotal: 5,
          },
        });
      }

      // Create 1 failed job
      await prisma.repairJob.create({
        data: {
          id: randomUUID(),
          organizationId: orgAId,
          projectId: projectAId,
          issue: `Failed issue ${uniqueSuffix}`,
          model: 'gemini-2.5-flash',
          verificationLevel: 'standard',
          maxIterations: 3,
          status: 'failed',
          testsPassed: 2,
          testsTotal: 5,
        },
      });

      // Create 2 in-progress / active jobs (MUST NOT be in verified rate denominator)
      for (const st of ['queued', 'analyzing']) {
        await prisma.repairJob.create({
          data: {
            id: randomUUID(),
            organizationId: orgAId,
            projectId: projectAId,
            issue: `Active issue ${st} ${uniqueSuffix}`,
            model: 'gemini-2.5-flash',
            verificationLevel: 'standard',
            maxIterations: 3,
            status: st,
          },
        });
      }

      const res = await fetch(`${baseUrl}/api/observability/intelligence?days=1`, {
        headers: { 'x-demo-role': 'ADMIN' },
      });
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.equal(data.executionMode, 'live_repair');
      assert.equal(data.isBenchmark, false);
      assert.ok(data.sampleSizes.evaluatedJobs >= 3);
      assert.ok(data.sampleSizes.activeJobs >= 2);

      // Verified rate must equal verified / evaluated (2/3 = 66.7%)
      // If active jobs were wrongly included, it would be 2/5 = 40%
      assert.ok(data.metrics.verifiedRepairRate >= 50.0);
    });

    it('counts false VERIFIED incidents based on actual verification evidence', async () => {
      // Create a false VERIFIED job (marked verified but with testsPassed < testsTotal)
      const falseJobId = randomUUID();
      await prisma.repairJob.create({
        data: {
          id: falseJobId,
          organizationId: orgAId,
          projectId: projectAId,
          issue: 'False verified bug test',
          model: 'gemini-2.5-flash',
          verificationLevel: 'standard',
          maxIterations: 3,
          status: 'verified',
          testsPassed: 4,
          testsTotal: 5, // Failing test!
        },
      });

      const res = await fetch(`${baseUrl}/api/observability/intelligence?days=1`, {
        headers: { 'x-demo-role': 'ADMIN' },
      });
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.ok(data.metrics.falseVerifiedCount >= 1);
      assert.ok(data.metrics.falseVerifiedRate > 0);
    });

    it('computes regression rate from jobs where regressions could be evaluated', async () => {
      const regJobId = randomUUID();
      await prisma.repairJob.create({
        data: {
          id: regJobId,
          organizationId: orgAId,
          projectId: projectAId,
          issue: 'Regression test job',
          model: 'gemini-2.5-flash',
          verificationLevel: 'standard',
          maxIterations: 3,
          status: 'failed',
          testsPassed: 3,
          testsTotal: 5,
        },
      });

      await prisma.repairAttempt.create({
        data: {
          id: randomUUID(),
          repairJobId: regJobId,
          attemptNumber: 1,
          status: 'FAILED',
          verificationResult: JSON.stringify({ passed: 3, total: 5, regression_detected: true }),
        },
      });

      const res = await fetch(`${baseUrl}/api/observability/intelligence?days=1`, {
        headers: { 'x-demo-role': 'ADMIN' },
      });
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.ok(data.metrics.regressionCount >= 1);
      assert.ok(data.metrics.regressionRate > 0);
    });
  });

  // =========================================================================
  // 2. Candidate Patch Metrics & Rejections
  // =========================================================================
  describe('2. Candidate Patch Evaluation Metrics', () => {
    it('distinguishes candidates generated, evaluated, and selected with rejection reasons', async () => {
      const candJobId = randomUUID();
      await prisma.repairJob.create({
        data: {
          id: candJobId,
          organizationId: orgAId,
          projectId: projectAId,
          issue: 'Multi-candidate evaluation telemetry job',
          model: 'gemini-2.5-flash',
          verificationLevel: 'standard',
          maxIterations: 3,
          status: 'verified',
          testsPassed: 5,
          testsTotal: 5,
        },
      });

      // Emitting CANDIDATES_GENERATED event with 3 candidates
      await prisma.repairEvent.create({
        data: {
          id: randomUUID(),
          repairId: candJobId,
          eventType: 'CANDIDATES_GENERATED',
          status: 'info',
          message: 'Generated 3 candidates',
          metadata: JSON.stringify({
            candidates_count: 3,
            candidates: ['cand-1', 'cand-2', 'cand-3'],
          }),
        },
      });

      // Emitting PATCH_VALIDATED with 1 selected and 2 rejections
      await prisma.repairEvent.create({
        data: {
          id: randomUUID(),
          repairId: candJobId,
          eventType: 'PATCH_VALIDATED',
          status: 'success',
          message: 'Selected best candidate cand-3',
          metadata: JSON.stringify({
            selected_candidate_id: 'cand-3',
            rejections: [
              { candidate_id: 'cand-1', reason: 'REGRESSION_DETECTED' },
              { candidate_id: 'cand-2', reason: 'EQUIVALENT_DIFF' },
            ],
          }),
        },
      });

      const res = await fetch(`${baseUrl}/api/observability/intelligence?days=1`, {
        headers: { 'x-demo-role': 'ADMIN' },
      });
      assert.equal(res.status, 200);
      const data = await res.json();

      const cm = data.metrics.candidateMetrics;
      assert.ok(cm.candidatesGenerated >= 3);
      assert.ok(cm.candidatesEvaluated >= 3);
      assert.ok(cm.candidatesSelected >= 1);
      assert.ok(cm.candidateAcceptanceRate != null);
      assert.ok(cm.candidateRejectionRate != null);
      assert.ok(cm.candidateRejections.REGRESSION_DETECTED >= 1);
      assert.ok(cm.candidateRejections.EQUIVALENT_DIFF >= 1);
    });
  });

  // =========================================================================
  // 3. Durations, Percentiles, and Missing Telemetry
  // =========================================================================
  describe('3. Duration Percentiles & Missing Telemetry Handling', () => {
    it('computes median and p95 repair duration in seconds', async () => {
      const res = await fetch(`${baseUrl}/api/observability/intelligence?days=1`, {
        headers: { 'x-demo-role': 'ADMIN' },
      });
      assert.equal(res.status, 200);
      const data = await res.json();

      const dm = data.metrics.durationMetrics;
      assert.ok('medianDurationSeconds' in dm);
      assert.ok('p95DurationSeconds' in dm);
      assert.ok('avgDurationSeconds' in dm);
    });

    it('reports missing token and cost telemetry strictly as null, never fabricating zero', async () => {
      const res = await fetch(`${baseUrl}/api/observability/intelligence?days=1`, {
        headers: { 'x-demo-role': 'ADMIN' },
      });
      assert.equal(res.status, 200);
      const data = await res.json();

      const tm = data.metrics.telemetryMetrics;
      assert.equal(tm.tokenUsage, null, 'tokenUsage must be null when telemetry unavailable');
      assert.equal(tm.costUsd, null, 'costUsd must be null when telemetry unavailable');
    });
  });

  // =========================================================================
  // 4. Filtering by Date, Repository, Language, Status, and Mode
  // =========================================================================
  describe('4. Server-Side Filtering Capabilities', () => {
    it('filters metrics by repository', async () => {
      const res = await fetch(`${baseUrl}/api/observability/intelligence?repository=project-alpha`, {
        headers: { 'x-demo-role': 'ADMIN' },
      });
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.ok(data.metrics.totalRepairs >= 1);
      for (const repo of data.metrics.repositoryBreakdown) {
        assert.ok(repo.repository.includes('project-alpha'));
      }
    });

    it('handles empty datasets gracefully without division-by-zero or crashing', async () => {
      const res = await fetch(`${baseUrl}/api/observability/intelligence?repository=non-existent-repo-999999`, {
        headers: { 'x-demo-role': 'ADMIN' },
      });
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.equal(data.metrics.totalRepairs, 0);
      assert.equal(data.metrics.verifiedRepairRate, null);
      assert.equal(data.metrics.falseVerifiedCount, 0);
      assert.equal(data.metrics.regressionRate, 0.0);
      assert.equal(data.metrics.durationMetrics.medianDurationSeconds, null);
      assert.equal(data.metrics.durationMetrics.p95DurationSeconds, null);
      assert.equal(data.metrics.candidateMetrics.candidateAcceptanceRate, null);
    });

    it('returns time-series intelligence trends', async () => {
      const res = await fetch(`${baseUrl}/api/observability/intelligence/trends?days=7`, {
        headers: { 'x-demo-role': 'ADMIN' },
      });
      assert.equal(res.status, 200);
      const trends = await res.json();

      assert.ok(Array.isArray(trends));
      assert.ok(trends.length >= 7);
      assert.ok('verified' in trends[0]);
      assert.ok('candidatesEvaluated' in trends[0]);
    });
  });

  // =========================================================================
  // 5. Tenant Isolation & RBAC
  // =========================================================================
  describe('5. Tenant Isolation & Security RBAC', () => {
    it('enforces organization isolation and prevents cross-tenant data leakage', async () => {
      // Create a repair job for Org B
      await prisma.repairJob.create({
        data: {
          id: randomUUID(),
          organizationId: orgBId,
          projectId: projectBId,
          issue: 'Tenant B secret bug',
          model: 'gemini-2.5-flash',
          verificationLevel: 'standard',
          maxIterations: 3,
          status: 'verified',
        },
      });

      // Query as Org A
      const resOrgA = await fetch(`${baseUrl}/api/observability/intelligence?days=1`, {
        headers: { 'x-demo-role': 'ADMIN' }, // Belongs to FixForge Labs (Org A)
      });
      assert.equal(resOrgA.status, 200);
      const dataA = await resOrgA.json();

      // Ensure no Org B repositories appear in Org A's telemetry
      for (const repo of dataA.metrics.repositoryBreakdown) {
        assert.ok(!repo.repository.includes('acme/project-beta'), 'Cross-tenant leak detected!');
      }
    });

    it('rejects unauthenticated anonymous requests with 401 UNAUTHORIZED', async () => {
      const res = await fetch(`${baseUrl}/api/observability/intelligence`, {
        headers: { 'x-anonymous': 'true' },
      });
      assert.equal(res.status, 401);
      const err = await res.json();
      assert.equal(err.code, 'UNAUTHORIZED');
    });
  });

  // =========================================================================
  // 6. Benchmark Run Discovery & Side-by-Side Comparison
  // =========================================================================
  describe('6. Benchmark Comparison Engine', () => {
    it('discovers persisted benchmark reports from benchmarks/reports', async () => {
      const res = await fetch(`${baseUrl}/api/observability/benchmarks`, {
        headers: { 'x-demo-role': 'ADMIN' },
      });
      assert.equal(res.status, 200);
      const runs = await res.json();

      assert.ok(Array.isArray(runs));
      assert.ok(runs.length >= 2, `Expected at least 2 benchmark runs, found ${runs.length}`);
      assert.ok(runs.some((r) => r.execution_mode === 'golden_validation'));
      assert.ok(runs.some((r) => r.metrics?.repair_success_rate != null));
    });

    it('compares two compatible benchmark runs with precise delta calculations', async () => {
      const listRes = await fetch(`${baseUrl}/api/observability/benchmarks`, {
        headers: { 'x-demo-role': 'ADMIN' },
      });
      const runs = await listRes.json();
      assert.ok(runs.length >= 2);

      const runA = runs[1].run_id;
      const runB = runs[0].run_id;

      const compRes = await fetch(`${baseUrl}/api/observability/benchmarks/compare?runA=${runA}&runB=${runB}`, {
        headers: { 'x-demo-role': 'ADMIN' },
      });
      assert.equal(compRes.status, 200);
      const comp = await compRes.json();

      assert.equal(comp.runA.run_id, runA);
      assert.equal(comp.runB.run_id, runB);
      assert.ok('isCompatible' in comp);
      assert.ok('deltas' in comp);
      assert.ok('repair_success_rate' in comp.deltas);
      assert.ok('total_candidates_evaluated' in comp.deltas);
      assert.ok(Array.isArray(comp.caseComparisons));
    });

    it('returns 400 when comparison parameters are missing', async () => {
      const res = await fetch(`${baseUrl}/api/observability/benchmarks/compare?runA=run-1`, {
        headers: { 'x-demo-role': 'ADMIN' },
      });
      assert.equal(res.status, 400);
    });

    it('returns 404 when comparing non-existent benchmark run ID', async () => {
      const res = await fetch(`${baseUrl}/api/observability/benchmarks/compare?runA=non-existent-1&runB=non-existent-2`, {
        headers: { 'x-demo-role': 'ADMIN' },
      });
      assert.equal(res.status, 404);
    });
  });

  // =========================================================================
  // 7. Live Repair vs Golden-Validation Separation
  // =========================================================================
  describe('7. Benchmark Fixture & Live Repair Separation', () => {
    it('clearly distinguishes golden-validation runs from live repair runs', async () => {
      // Live mode query
      const liveRes = await fetch(`${baseUrl}/api/observability/intelligence?executionMode=live_repair`, {
        headers: { 'x-demo-role': 'ADMIN' },
      });
      const liveData = await liveRes.json();
      assert.equal(liveData.executionMode, 'live_repair');
      assert.equal(liveData.isBenchmark, false);

      // Golden validation query
      const benchRes = await fetch(`${baseUrl}/api/observability/intelligence?executionMode=golden_validation`, {
        headers: { 'x-demo-role': 'ADMIN' },
      });
      const benchData = await benchRes.json();
      assert.equal(benchData.executionMode, 'golden_validation');
      assert.equal(benchData.isBenchmark, true);
      assert.ok(benchData.note.includes('Golden-validation benchmark run'));
    });
  });
});
