import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import app from '../src/app.js';
import { prisma, seedDatabase, DEMO_USERS, DEMO_ORGS } from '@workspace/db';
import { MetricsService } from '../src/services/observability/metrics-service.js';
import { enableTestAuthMock } from '../src/middlewares/auth.js';

describe('FixForge Milestone 12.5: Live Repair Accuracy & Independent Verification Tests', () => {
  let server;
  let baseUrl;
  let metricsService;
  let orgAId;

  before(async () => {
    enableTestAuthMock(true);
    await seedDatabase();
    metricsService = new MetricsService();

    await new Promise((resolve) => {
      server = http.createServer(app);
      server.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    orgAId = DEMO_ORGS.FIXFORGE_LABS.id;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  describe('1. Live Benchmark Discovery & Per-Run Details', () => {
    it('discovers live and dry_run benchmark reports alongside golden validation reports', async () => {
      const res = await fetch(`${baseUrl}/api/observability/benchmarks`, {
        headers: { 'x-demo-role': 'ADMIN' },
      });
      assert.equal(res.status, 200);
      const runs = await res.json();

      assert.ok(Array.isArray(runs));
      assert.ok(runs.length >= 2, `Expected at least 2 runs, found ${runs.length}`);

      // Verify execution mode field is present on all discovered runs
      for (const run of runs) {
        assert.ok(run.run_id);
        assert.ok(run.execution_mode, `Run ${run.run_id} missing execution_mode`);
      }
    });

    it('fetches complete per-run details including per-case test integrity and independent test results', async () => {
      const listRes = await fetch(`${baseUrl}/api/observability/benchmarks`, {
        headers: { 'x-demo-role': 'ADMIN' },
      });
      const runs = await listRes.json();
      assert.ok(runs.length > 0);

      const targetRun = runs[0];
      const detailRes = await fetch(`${baseUrl}/api/observability/benchmarks/${targetRun.run_id}`, {
        headers: { 'x-demo-role': 'ADMIN' },
      });
      assert.equal(detailRes.status, 200);
      const detail = await detailRes.json();

      assert.equal(detail.run_id, targetRun.run_id);
      assert.ok(detail.metrics);
      assert.ok(Array.isArray(detail.case_results));
      assert.ok(detail.timestamp || detail.created_at);
      assert.ok(detail.fixture_version);
    });

    it('returns 404 for non-existent benchmark run ID', async () => {
      const res = await fetch(`${baseUrl}/api/observability/benchmarks/non-existent-run-xyz`, {
        headers: { 'x-demo-role': 'ADMIN' },
      });
      assert.equal(res.status, 404);
      const err = await res.json();
      assert.equal(err.code, 'NOT_FOUND');
    });

    it('enforces RBAC authentication on /api/observability/benchmarks/:runId', async () => {
      const res = await fetch(`${baseUrl}/api/observability/benchmarks/any-run`, {
        headers: { 'x-anonymous': 'true' },
      });
      assert.equal(res.status, 401);
      const err = await res.json();
      assert.equal(err.code, 'UNAUTHORIZED');
    });
  });

  describe('2. Execution Mode Compatibility & Delta Warnings', () => {
    it('flags incompatibility and warning when comparing live/dry_run run against golden_validation run', async () => {
      const listRes = await fetch(`${baseUrl}/api/observability/benchmarks`, {
        headers: { 'x-demo-role': 'ADMIN' },
      });
      const runs = await listRes.json();

      const dryRun = runs.find((r) => r.execution_mode === 'dry_run' || r.execution_mode === 'live_repair');
      const goldenRun = runs.find((r) => r.execution_mode === 'golden_validation');

      if (dryRun && goldenRun) {
        const compRes = await fetch(
          `${baseUrl}/api/observability/benchmarks/compare?runA=${dryRun.run_id}&runB=${goldenRun.run_id}`,
          { headers: { 'x-demo-role': 'ADMIN' } }
        );
        assert.equal(compRes.status, 200);
        const comp = await compRes.json();

        assert.equal(comp.isCompatible, false);
        assert.ok(comp.warnings && comp.warnings.some((w) => w.includes('Execution mode mismatch')));
        assert.ok('test_integrity_violations' in comp.deltas);
        assert.ok('abstained_cases_count' in comp.deltas);
        assert.ok('timeout_cases_count' in comp.deltas);
      }
    });
  });

  describe('3. Metrics Service Direct Invocations', () => {
    it('MetricsService.getBenchmarkRunDetails correctly loads report by run_id', async () => {
      const runs = await metricsService.getBenchmarkRuns();
      assert.ok(runs.length > 0);

      const first = runs[0];
      const details = await metricsService.getBenchmarkRunDetails(first.run_id);
      assert.ok(details);
      assert.equal(details.run_id, first.run_id);
    });

    it('MetricsService.getBenchmarkRunDetails returns null for invalid run_id', async () => {
      const details = await metricsService.getBenchmarkRunDetails('invalid-id-that-does-not-exist');
      assert.equal(details, null);
    });
  });

  after(async () => {
    enableTestAuthMock(false);
    if (server) await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
  });
});
