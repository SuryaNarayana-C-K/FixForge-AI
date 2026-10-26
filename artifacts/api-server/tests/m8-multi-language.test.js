import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import app from '../src/app.js';
import { prisma, seedDatabase } from '@workspace/db';
import { MetricsService } from '../src/services/observability/metrics-service.js';
import {
  generatePullRequestDescription,
  generateRepairReport,
} from '../src/services/git/report-generator.js';
import { enableTestAuthMock } from '../src/middlewares/auth.js';

describe('FixForge Milestone 8 - Multi-Language & Multi-Repository Engine Tests', () => {
  let server;
  let baseUrl;
  let metricsService;
  let testProjectId;

  before(async () => {
    enableTestAuthMock(true);
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
    enableTestAuthMock(false);
    await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
  });

  describe('1. Multi-Language Repair Creation & Persistence', () => {
    it('creates and persists a JavaScript/Jest repair job in SQLite', async () => {
      const res = await fetch(`${baseUrl}/api/repairs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: testProjectId,
          issue: 'Fix division by zero in calculator.js',
          model: 'forge-2',
          verificationLevel: 'standard',
          maxIterations: 4,
          language: 'javascript',
          framework: 'jest',
          testFramework: 'jest',
          packageManager: 'npm',
        }),
      });

      assert.equal(res.status, 201);
      const data = await res.json();
      assert.ok(data.id);
      assert.equal(data.language, 'javascript');
      assert.equal(data.testFramework, 'jest');

      // Verify directly in SQLite
      const inDb = await prisma.repairJob.findUnique({ where: { id: data.id } });
      assert.equal(inDb.language, 'javascript');
      assert.equal(inDb.framework, 'jest');
      assert.equal(inDb.testFramework, 'jest');
      assert.equal(inDb.packageManager, 'npm');
    });

    it('creates and persists a Python/pytest repair job in SQLite', async () => {
      const res = await fetch(`${baseUrl}/api/repairs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: testProjectId,
          issue: 'Fix safe division in calculator.py',
          model: 'forge-2',
          verificationLevel: 'standard',
          maxIterations: 3,
          language: 'python',
          framework: 'pytest',
          testFramework: 'pytest',
          packageManager: 'pip',
        }),
      });

      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.language, 'python');
      assert.equal(data.testFramework, 'pytest');
    });
  });

  describe('2. Multi-Language Observability & Intelligence Metrics', () => {
    it('calculates repairsByLanguage and repairsByFramework from live SQLite records', async () => {
      const overview = await metricsService.getOverviewMetrics();

      assert.ok(overview.repairsByLanguage != null);
      assert.ok(typeof overview.repairsByLanguage === 'object');
      assert.ok(overview.repairsByLanguage.javascript >= 1);
      assert.ok(overview.repairsByLanguage.python >= 1);

      assert.ok(overview.repairsByFramework != null);
      assert.ok(typeof overview.repairsByFramework === 'object');
      assert.ok(overview.repairsByFramework.jest >= 1);

      assert.ok(overview.successRateByLanguage != null);
      assert.ok(overview.averageAttemptsByLanguage != null);
      assert.ok(typeof overview.successRateByLanguage.javascript === 'number');
      assert.ok(typeof overview.averageAttemptsByLanguage.javascript === 'number');
    });

    it('returns language and framework in recent repairs query', async () => {
      const recent = await metricsService.getRecentRepairs(10);
      assert.ok(Array.isArray(recent));
      assert.ok(recent.length > 0);

      const jsRepair = recent.find((r) => r.language === 'javascript');
      assert.ok(jsRepair != null);
      assert.equal(jsRepair.language, 'javascript');
      assert.equal(jsRepair.testFramework, 'jest');
    });
  });

  describe('3. Multi-Language Pull Request & Report Generation', () => {
    it('includes language and test framework metadata in PR description', () => {
      const mockRepair = {
        id: randomUUID(),
        issue: 'Fix divide by zero',
        language: 'javascript',
        testFramework: 'jest',
        framework: 'jest',
        testsPassed: 5,
        testsTotal: 5,
        iteration: 1,
      };

      const description = generatePullRequestDescription({
        repair: mockRepair,
        project: { name: 'calculator-js', repository: 'examples/buggy-javascript-project', language: 'javascript' },
        branchName: 'fixforge/repair-js-demo',
        verification: { passed: 5, total: 5 },
      });

      assert.ok(description.includes('**Language:** `javascript`'));
      assert.ok(description.includes('**Framework:** `jest`'));
      assert.ok(description.includes('**VERIFIED**'));
    });

    it('includes language and framework in Markdown repair report', () => {
      const mockRepair = {
        id: randomUUID(),
        issue: 'Fix safe division in python project',
        language: 'python',
        testFramework: 'pytest',
        framework: 'pytest',
        testsPassed: 5,
        testsTotal: 5,
        iteration: 1,
      };

      const report = generateRepairReport({
        repair: mockRepair,
        project: { name: 'calculator-py', repository: 'examples/buggy-python-project', language: 'python' },
        branchName: 'fixforge/repair-py-demo',
        verification: { passed: 5, total: 5 },
      });

      assert.ok(report.markdown.includes('**Language:** python'));
      assert.ok(report.markdown.includes('**Framework:** pytest'));
      assert.ok(report.markdown.includes('VERIFIED'));
    });
  });
});
