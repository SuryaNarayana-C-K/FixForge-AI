import { Router } from 'express';
import { prisma } from '@workspace/db';
import { MetricsService } from '../services/observability/metrics-service.js';
import { getRepairEvents } from '../services/observability/event-service.js';
import { jobLifecycleService } from '../services/lifecycle/job-lifecycle-service.js';

const router = Router();
const metricsService = new MetricsService();

function checkObservabilityAuth(req, res) {
  const isProduction =
    process.env.NODE_ENV === 'production' || process.env.FIXFORGE_ENV === 'production';
  if ((isProduction || req.headers['x-anonymous'] === 'true' || req.isAnonymous) && (!req.user || req.isAnonymous)) {
    res.status(401).json({ error: 'Authentication required to access observability metrics.', code: 'UNAUTHORIZED' });
    return false;
  }
  return true;
}

/**
 * GET /api/observability/overview
 * Returns platform-level repair statistics and health metrics.
 */
router.get('/observability/overview', async (req, res) => {
  if (!checkObservabilityAuth(req, res)) return;
  try {
    const orgId = req.user?.organizationId;
    const overview = await metricsService.getOverviewMetrics(orgId);
    res.json(overview);
  } catch (err) {
    res.status(500).json({ error: `Failed to calculate overview metrics: ${err.message}` });
  }
});

router.get('/observability/trends', async (req, res) => {
  if (!checkObservabilityAuth(req, res)) return;
  try {
    const days = req.query.days ? parseInt(req.query.days, 10) : 7;
    const orgId = req.user?.organizationId;
    const trends = await metricsService.getTrends(days, orgId);
    res.json(trends);
  } catch (err) {
    res.status(500).json({ error: `Failed to calculate trend metrics: ${err.message}` });
  }
});

router.get('/observability/recent', async (req, res) => {
  if (!checkObservabilityAuth(req, res)) return;
  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 10;
    const orgId = req.user?.organizationId;
    const recent = await metricsService.getRecentRepairs(limit, orgId);
    res.json(recent);
  } catch (err) {
    res.status(500).json({ error: `Failed to fetch recent repairs: ${err.message}` });
  }
});

router.get('/repairs/:repairId/metrics', async (req, res) => {
  if (!checkObservabilityAuth(req, res)) return;
  const { repairId } = req.params;
  try {
    const repair = await prisma.repairJob.findUnique({
      where: { id: repairId },
      include: { project: true },
    });
    if (!repair) {
      res.status(404).json({ error: 'Repair job not found', code: 'NOT_FOUND' });
      return;
    }

    const repairOrg = repair.organizationId || repair.project?.organizationId;
    if (req.user?.organizationId && repairOrg && req.user.organizationId !== repairOrg) {
      res.status(403).json({ error: 'Access denied: repair belongs to another organization.', code: 'ACCESS_DENIED' });
      return;
    }

    const orgId = req.user?.organizationId;
    const metrics = await metricsService.getRepairMetrics(repairId, orgId);
    if (!metrics) {
      res.status(404).json({ error: 'Repair job not found' });
      return;
    }
    res.json(metrics);
  } catch (err) {
    res.status(500).json({ error: `Failed to fetch repair metrics: ${err.message}` });
  }
});

/**
 * GET /api/observability/intelligence
 * M12.4: Primary repair intelligence summary endpoint with filters and server-side aggregation.
 */
router.get('/observability/intelligence', async (req, res) => {
  if (!checkObservabilityAuth(req, res)) return;
  try {
    const orgId = req.user?.organizationId;
    const filters = {
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      days: req.query.days ? parseInt(req.query.days, 10) : 30,
      repository: req.query.repository,
      language: req.query.language,
      status: req.query.status,
      executionMode: req.query.executionMode || 'live_repair',
      model: req.query.model,
    };
    const metrics = await metricsService.getIntelligenceMetrics(filters, orgId);
    res.json(metrics);
  } catch (err) {
    res.status(500).json({ error: `Failed to calculate intelligence metrics: ${err.message}` });
  }
});

/**
 * GET /api/observability/intelligence/trends
 * M12.4: Time-series repair trends with candidate and duration breakdown.
 */
router.get('/observability/intelligence/trends', async (req, res) => {
  if (!checkObservabilityAuth(req, res)) return;
  try {
    const orgId = req.user?.organizationId;
    const filters = {
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      days: req.query.days ? parseInt(req.query.days, 10) : 30,
      repository: req.query.repository,
      language: req.query.language,
      status: req.query.status,
      executionMode: req.query.executionMode || 'live_repair',
      model: req.query.model,
    };
    const trends = await metricsService.getIntelligenceTrends(filters, orgId);
    res.json(trends);
  } catch (err) {
    res.status(500).json({ error: `Failed to calculate intelligence trends: ${err.message}` });
  }
});

/**
 * GET /api/observability/benchmarks
 * M12.4: Discover all available benchmark runs.
 */
router.get('/observability/benchmarks', async (req, res) => {
  if (!checkObservabilityAuth(req, res)) return;
  try {
    const runs = await metricsService.getBenchmarkRuns();
    res.json(runs);
  } catch (err) {
    res.status(500).json({ error: `Failed to fetch benchmark runs: ${err.message}` });
  }
});

/**
 * GET /api/observability/benchmarks/compare
 * M12.4: Side-by-side benchmark comparison with compatibility checks and deltas.
 */
router.get('/observability/benchmarks/compare', async (req, res) => {
  if (!checkObservabilityAuth(req, res)) return;
  try {
    const { runA, runB } = req.query;
    if (!runA || !runB) {
      res.status(400).json({ error: 'Both runA and runB query parameters are required for comparison.' });
      return;
    }
    const comparison = await metricsService.compareBenchmarkRuns(runA, runB);
    res.json(comparison);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message, code: status === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR' });
  }
});
/**
 * GET /api/observability/benchmarks/:runId
 * M12.5: Retrieve detailed benchmark report for a specific run including per-case evidence.
 */
router.get('/observability/benchmarks/:runId', async (req, res) => {
  if (!checkObservabilityAuth(req, res)) return;
  try {
    const { runId } = req.params;
    const report = await metricsService.getBenchmarkRunDetails(runId);
    if (!report) {
      res.status(404).json({ error: `Benchmark run not found: ${runId}`, code: 'NOT_FOUND' });
      return;
    }
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: `Failed to fetch benchmark run details: ${err.message}` });
  }
});

/**
 * GET /api/observability/reliability
 * FixForge M13.2: Production reliability metrics including queue depth, active concurrency,
 * recovery outcomes, retries, quota rejections, cancellations, timeouts, and delivery tracking.
 */
router.get('/observability/reliability', async (req, res) => {
  if (!checkObservabilityAuth(req, res)) return;
  try {
    const orgId = req.user?.organizationId;
    const whereOrg = orgId ? { organizationId: orgId } : {};

    // 1. Current real-time states
    const queueDepth = await prisma.repairJob.count({
      where: { ...whereOrg, status: 'queued' },
    });

    const concurrency = jobLifecycleService.getConcurrencyStats();
    const reliability = jobLifecycleService.getReliabilityStats();

    // 2. Historical durable events & tallies
    const cancellationsTotal = await prisma.repairJob.count({
      where: { ...whereOrg, status: 'cancelled' },
    });

    const timeoutsTotal = await prisma.sandboxRun.count({
      where: {
        timedOut: true,
        ...(orgId ? { repairJob: { organizationId: orgId } } : {}),
      },
    });

    const recoveryOutcomesTotal = await prisma.repairJob.count({
      where: {
        ...whereOrg,
        interruptedAt: { not: null },
      },
    });

    const retriedJobsTotal = await prisma.repairJob.count({
      where: {
        ...whereOrg,
        retryCount: { gt: 0 },
      },
    });

    const deliveriesSucceeded = await prisma.repairJob.count({
      where: {
        ...whereOrg,
        deliveryStatus: 'DELIVERED',
      },
    });

    const deliveryFailures = await prisma.repairJob.count({
      where: {
        ...whereOrg,
        deliveryStatus: 'FAILED',
      },
    });

    res.json({
      current_state: {
        queue_depth: queueDepth,
        active_jobs: concurrency.activeJobs,
        max_concurrent: concurrency.maxConcurrent,
        max_concurrent_per_user: concurrency.maxConcurrentPerUser,
        available_slots: concurrency.availableSlots,
      },
      historical_events: {
        retries_attempted: reliability.retriesAttempted,
        retries_succeeded: reliability.retriesSucceeded,
        retried_jobs_total: retriedJobsTotal,
        recovery_outcomes_total: Math.max(reliability.reconciledOnStartup, recoveryOutcomesTotal),
        reconciled_on_startup: reliability.reconciledOnStartup,
        quota_rejections_total: reliability.quotaRejections,
        cancellations_total: cancellationsTotal,
        timeouts_total: timeoutsTotal,
        deliveries_succeeded: deliveriesSucceeded,
        delivery_failures_total: Math.max(reliability.deliveryFailures, deliveryFailures),
      },
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: `Failed to calculate reliability metrics: ${err.message}` });
  }
});

export default router;

