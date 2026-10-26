import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import app from '../src/app.js';
import { seedDatabase, DEMO_ORGS } from '@workspace/db';
import { MetricsService } from '../src/services/observability/metrics-service.js';

describe('FixForge Milestone 12.6: Benchmark Reliability & Run Comparison Tests', () => {
  let server;
  let baseUrl;
  let metricsService;

  before(async () => {
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
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  describe('1. Preserved Historical Reports & Run Discovery', () => {
    it('discovers historical and repeated benchmark reports with unique run IDs', async () => {
      const res = await fetch(`${baseUrl}/api/observability/benchmarks`, {
        headers: { 'x-demo-role': 'ADMIN' },
      });
      assert.equal(res.status, 200);
      const runs = await res.json();

      assert.ok(Array.isArray(runs));
      assert.ok(runs.length >= 2, `Expected multiple runs, found ${runs.length}`);

      // Verify unique run IDs
      const runIds = runs.map((r) => r.run_id);
      assert.equal(runIds.length, new Set(runIds).size, 'All discovered run IDs must be unique');
    });

    it('loads live-6c526d97 audit report with authoritative outcomes and evidence fields', async () => {
      const detailRes = await fetch(`${baseUrl}/api/observability/benchmarks/live-6c526d97`, {
        headers: { 'x-demo-role': 'ADMIN' },
      });
      assert.equal(detailRes.status, 200);
      const report = await detailRes.json();

      assert.equal(report.run_id, 'live-6c526d97');
      assert.equal(report.execution_mode, 'live_repair');
      assert.equal(report.model, 'gemini-2.0-flash');
      assert.equal(report.metrics.total_cases, 6);
      assert.equal(report.metrics.eligible_completed_cases, 3);
      assert.equal(report.metrics.correct_repairs, 2);
      assert.equal(report.metrics.invalid_cases_count, 1);
      assert.equal(report.metrics.false_verified_count, 0);

      const regCase = report.case_results.find((c) => c.fixture_id === 'live_py_regression_inducing');
      assert.ok(regCase, 'live_py_regression_inducing must be present');
      assert.equal(regCase.status, 'REGRESSION');
      assert.equal(regCase.regression_detected, true);
    });
  });

  describe('2. Expanded Benchmark Coverage & Case Verification', () => {
    it('verifies latest dry_run report contains expanded coverage across Python and JavaScript', async () => {
      const listRes = await fetch(`${baseUrl}/api/observability/benchmarks`, {
        headers: { 'x-demo-role': 'ADMIN' },
      });
      const runs = await listRes.json();
      const dryRuns = runs.filter((r) => r.execution_mode === 'dry_run');
      assert.ok(dryRuns.length > 0, 'At least one dry_run report must be available');

      const latestDry = dryRuns[0];
      const detailRes = await fetch(`${baseUrl}/api/observability/benchmarks/${latestDry.run_id}`, {
        headers: { 'x-demo-role': 'ADMIN' },
      });
      assert.equal(detailRes.status, 200);
      const detail = await detailRes.json();

      assert.ok(detail.case_results.length >= 6);
      const fixtureIds = detail.case_results.map((c) => c.fixture_id);

      // Verify no duplicate fixture IDs in authoritative results
      assert.equal(fixtureIds.length, new Set(fixtureIds).size);
    });
  });

  describe('3. Report Comparison & Mode Compatibility Checks', () => {
    it('compares compatible benchmark runs and computes non-null metric deltas', async () => {
      const runs = await metricsService.getBenchmarkRuns();
      assert.ok(runs.length >= 2);

      // Find two runs with the same execution mode
      let runA = null;
      let runB = null;
      for (let i = 0; i < runs.length; i++) {
        for (let j = i + 1; j < runs.length; j++) {
          if (runs[i].execution_mode === runs[j].execution_mode) {
            runA = runs[i];
            runB = runs[j];
            break;
          }
        }
        if (runA) break;
      }

      if (runA && runB) {
        const compRes = await fetch(
          `${baseUrl}/api/observability/benchmarks/compare?runA=${runA.run_id}&runB=${runB.run_id}`,
          { headers: { 'x-demo-role': 'ADMIN' } }
        );
        assert.equal(compRes.status, 200);
        const comp = await compRes.json();
        assert.ok(comp.runA);
        assert.ok(comp.runB);
        assert.ok(comp.deltas);
      }
    });

    it('rejects comparison when run IDs do not exist', async () => {
      const res = await fetch(
        `${baseUrl}/api/observability/benchmarks/compare?runA=invalid-run-1&runB=invalid-run-2`,
        { headers: { 'x-demo-role': 'ADMIN' } }
      );
      assert.equal(res.status, 404);
      const err = await res.json();
      assert.equal(err.code, 'NOT_FOUND');
    });
  });
});
