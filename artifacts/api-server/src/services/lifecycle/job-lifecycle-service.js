import { randomUUID } from 'node:crypto';
import { prisma } from '@workspace/db';
import { recordRepairEvent, REPAIR_EVENT_TYPES } from '../observability/event-service.js';
import { recordAuditLog } from '../security/audit-service.js';
import { getAiServiceHeaders } from '../ai-client.js';

export const JOB_STATES = {
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  VERIFYING: 'VERIFYING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  TIMED_OUT: 'TIMED_OUT',
};

export const TERMINAL_STATES = new Set([
  JOB_STATES.SUCCEEDED,
  JOB_STATES.FAILED,
  JOB_STATES.CANCELLED,
  JOB_STATES.TIMED_OUT,
]);

export const STATE_ALIASES = {
  queued: JOB_STATES.QUEUED,
  QUEUED: JOB_STATES.QUEUED,
  analyzing: JOB_STATES.RUNNING,
  self_correcting: JOB_STATES.RUNNING,
  running: JOB_STATES.RUNNING,
  RUNNING: JOB_STATES.RUNNING,
  verifying: JOB_STATES.VERIFYING,
  testing: JOB_STATES.VERIFYING,
  VERIFYING: JOB_STATES.VERIFYING,
  verified: JOB_STATES.SUCCEEDED,
  passed: JOB_STATES.SUCCEEDED,
  succeeded: JOB_STATES.SUCCEEDED,
  SUCCEEDED: JOB_STATES.SUCCEEDED,
  approved: JOB_STATES.SUCCEEDED,
  failed: JOB_STATES.FAILED,
  error: JOB_STATES.FAILED,
  FAILED: JOB_STATES.FAILED,
  cancelled: JOB_STATES.CANCELLED,
  CANCELLED: JOB_STATES.CANCELLED,
  timeout: JOB_STATES.TIMED_OUT,
  timed_out: JOB_STATES.TIMED_OUT,
  TIMED_OUT: JOB_STATES.TIMED_OUT,
};

const VALID_TRANSITIONS = {
  [JOB_STATES.QUEUED]: new Set([JOB_STATES.RUNNING, JOB_STATES.CANCELLED]),
  [JOB_STATES.RUNNING]: new Set([
    JOB_STATES.VERIFYING,
    JOB_STATES.SUCCEEDED,
    JOB_STATES.FAILED,
    JOB_STATES.CANCELLED,
    JOB_STATES.TIMED_OUT,
  ]),
  [JOB_STATES.VERIFYING]: new Set([
    JOB_STATES.SUCCEEDED,
    JOB_STATES.FAILED,
    JOB_STATES.CANCELLED,
    JOB_STATES.TIMED_OUT,
  ]),
  [JOB_STATES.SUCCEEDED]: new Set(),
  [JOB_STATES.FAILED]: new Set(),
  [JOB_STATES.CANCELLED]: new Set(),
  [JOB_STATES.TIMED_OUT]: new Set(),
};

export class JobLifecycleService {
  constructor() {
    this.maxConcurrent = parseInt(process.env.MAX_CONCURRENT_REPAIR_JOBS || '4', 10);
    this.maxConcurrentPerUser = parseInt(process.env.MAX_CONCURRENT_PER_USER || '2', 10);
    this.maxRepairsPerHourUser = parseInt(process.env.MAX_REPAIRS_PER_USER_PER_HOUR || '50', 10);
    this.maxRepairsPerHourOrg = parseInt(process.env.MAX_REPAIRS_PER_ORG_PER_HOUR || '200', 10);
    this.activeJobs = new Map(); // repairId -> { abortController, startedAt, containerId, userId, orgId }
    this.idempotencyLocks = new Set(); // Set of currently in-flight idempotency keys
    this.stats = {
      reconciledOnStartup: 0,
      retriesAttempted: 0,
      retriesSucceeded: 0,
      quotaRejections: 0,
      deliveryFailures: 0,
    };
  }

  getConcurrencyStats() {
    return {
      activeJobs: this.activeJobs.size,
      maxConcurrent: this.maxConcurrent,
      maxConcurrentPerUser: this.maxConcurrentPerUser,
      availableSlots: Math.max(0, this.maxConcurrent - this.activeJobs.size),
    };
  }

  getReliabilityStats() {
    return {
      ...this.stats,
      activeJobs: this.activeJobs.size,
      maxConcurrent: this.maxConcurrent,
      maxConcurrentPerUser: this.maxConcurrentPerUser,
      concurrencyStats: this.getConcurrencyStats(),
    };
  }

  canonicalState(raw) {
    if (!raw) return JOB_STATES.QUEUED;
    return STATE_ALIASES[raw] || JOB_STATES.FAILED;
  }

  validateTransition(fromState, toState) {
    const fromCan = this.canonicalState(fromState);
    const toCan = this.canonicalState(toState);

    // If same state, idempotent
    if (fromCan === toCan) return true;

    // Guard: Terminal states CANNOT be overwritten by late callbacks (e.g. SUCCEEDED after CANCELLED)
    if (TERMINAL_STATES.has(fromCan)) {
      const err = new Error(`Cannot transition from terminal state ${fromCan} to ${toCan}: late update ignored.`);
      err.code = 'TERMINAL_STATE_LOCKED';
      err.status = 409;
      throw err;
    }

    const allowed = VALID_TRANSITIONS[fromCan] || new Set();
    if (!allowed.has(toCan)) {
      const err = new Error(`Invalid state transition: cannot move from ${fromCan} to ${toCan}.`);
      err.code = 'INVALID_STATE_TRANSITION';
      err.status = 400;
      throw err;
    }

    return true;
  }

  async acquireIdempotencyLock(key) {
    if (!key) return;
    if (this.idempotencyLocks.has(key)) {
      const err = new Error(`A request with idempotency key '${key}' is currently being processed.`);
      err.code = 'IDEMPOTENCY_IN_FLIGHT';
      err.status = 409;
      throw err;
    }
    this.idempotencyLocks.add(key);
  }

  releaseIdempotencyLock(key) {
    if (key) {
      this.idempotencyLocks.delete(key);
    }
  }

  async checkQuotas(user = null, orgId = null) {
    const oneHourAgo = new Date(Date.now() - 3600 * 1000);

    // 1. Per-user hourly quota
    if (user?.id) {
      const userJobCount = await prisma.repairJob.count({
        where: {
          createdById: user.id,
          createdAt: { gte: oneHourAgo },
        },
      });

      if (userJobCount >= this.maxRepairsPerHourUser) {
        this.stats.quotaRejections += 1;
        const err = new Error(
          `User repair quota exceeded: maximum ${this.maxRepairsPerHourUser} jobs per hour. Current: ${userJobCount}.`
        );
        err.code = 'QUOTA_EXCEEDED';
        err.status = 429;
        throw err;
      }
    }

    // 2. Per-organization hourly quota
    const effectiveOrgId = orgId || user?.organizationId;
    if (effectiveOrgId) {
      const orgJobCount = await prisma.repairJob.count({
        where: {
          organizationId: effectiveOrgId,
          createdAt: { gte: oneHourAgo },
        },
      });

      if (orgJobCount >= this.maxRepairsPerHourOrg) {
        this.stats.quotaRejections += 1;
        const err = new Error(
          `Organization repair quota exceeded: maximum ${this.maxRepairsPerHourOrg} jobs per hour. Current: ${orgJobCount}.`
        );
        err.code = 'QUOTA_EXCEEDED';
        err.status = 429;
        throw err;
      }
    }
  }

  acquireSlot(repairId, user = null, orgId = null) {
    if (this.activeJobs.has(repairId)) {
      const err = new Error(`Repair job '${repairId}' is already running.`);
      err.code = 'JOB_ALREADY_RUNNING';
      err.status = 409;
      throw err;
    }

    // 1. Global concurrency limit
    if (this.activeJobs.size >= this.maxConcurrent) {
      this.stats.quotaRejections += 1;
      const err = new Error(
        `Maximum concurrent repair capacity reached (${this.maxConcurrent} active). Please retry later.`
      );
      err.code = 'MAX_CONCURRENT_JOBS_EXCEEDED';
      err.status = 429;
      throw err;
    }

    // 2. Per-user concurrency limit
    const userId = user?.id || null;
    if (userId) {
      let userActive = 0;
      for (const item of this.activeJobs.values()) {
        if (item.userId === userId) {
          userActive += 1;
        }
      }

      if (userActive >= this.maxConcurrentPerUser) {
        this.stats.quotaRejections += 1;
        const err = new Error(
          `User concurrency limit exceeded: you already have ${userActive} repair(s) executing (limit: ${this.maxConcurrentPerUser}).`
        );
        err.code = 'USER_CONCURRENCY_LIMIT_EXCEEDED';
        err.status = 429;
        throw err;
      }
    }

    const abortController = new AbortController();
    this.activeJobs.set(repairId, {
      abortController,
      startedAt: new Date().toISOString(),
      containerId: null,
      userId,
      orgId: orgId || user?.organizationId || null,
    });

    return abortController;
  }

  releaseSlot(repairId) {
    this.activeJobs.delete(repairId);
  }

  isRetryableFailure(err) {
    if (!err) return false;
    const msg = (err.message || String(err)).toLowerCase();
    const code = (err.code || '').toUpperCase();

    // Transient infra failures that are safe to retry
    const isTimeout = msg.includes('timed out') || code === 'TIMEOUT' || code === 'SANDBOX_TIMEOUT';
    const isContainerStartup = msg.includes('container') && (msg.includes('startup') || msg.includes('failed to start'));
    const isNetworkDrop =
      code === 'AI_SERVICE_UNAVAILABLE' ||
      code === 'ECONNREFUSED' ||
      code === 'ECONNRESET' ||
      msg.includes('fetch failed') ||
      msg.includes('econnrefused');

    // Non-retryable failures: deliberate test failures, regressions, syntax errors, cancellation, policy rejections
    const isNonRetryable =
      code === 'INVALID_STATE_TRANSITION' ||
      code === 'TERMINAL_STATE_LOCKED' ||
      code === 'JOB_CANCELLED' ||
      code === 'UNVERIFIED_REPAIR_BLOCKED' ||
      code === 'POLICY_VIOLATION' ||
      code === 'ACCESS_DENIED' ||
      code === 'QUOTA_EXCEEDED' ||
      code === 'IDEMPOTENCY_CONFLICT' ||
      msg.includes('cancelled by user') ||
      msg.includes('regression detected') ||
      msg.includes('unverified');

    if (isNonRetryable) return false;
    return isTimeout || isContainerStartup || isNetworkDrop;
  }

  async reconcileInterruptedJobs() {
    // 1. Query all repair jobs in active non-terminal execution states
    const interruptedJobs = await prisma.repairJob.findMany({
      where: {
        status: { in: ['running', 'self_correcting', 'verifying', 'analyzing', 'testing'] },
      },
      include: { project: true },
    });

    const now = new Date();
    const recoveredIds = [];

    for (const job of interruptedJobs) {
      await prisma.repairJob.update({
        where: { id: job.id },
        data: {
          status: 'failed',
          interruptedAt: now,
          failures: 'Execution interrupted by server restart. Partially executed jobs are never marked successful.',
        },
      });

      await prisma.activityEvent.create({
        data: {
          id: randomUUID(),
          repairId: job.id,
          event: 'repair.interrupted',
          status: 'warning',
          message: 'Repair execution interrupted by server restart; safely marked as failed.',
        },
      });

      await recordRepairEvent({
        repairId: job.id,
        eventType: REPAIR_EVENT_TYPES.JOB_FAILED,
        status: 'warning',
        message: 'Execution interrupted by server restart. Partially executed jobs are never marked successful.',
        metadata: { interruptedAt: now.toISOString(), previousStatus: job.status },
      });

      const orgId = job.organizationId || job.project?.organizationId;
      await recordAuditLog({
        organizationId: orgId,
        userId: job.createdById || null,
        action: 'REPAIR_INTERRUPTED',
        resourceType: 'RepairJob',
        resourceId: job.id,
        repairId: job.id,
        metadata: {
          previousStatus: job.status,
          reason: 'Server restart recovery reconciliation',
        },
      });

      recoveredIds.push(job.id);
    }

    // 2. Dispatch container orphan reconciliation to AI Agent service
    const aiServiceUrl = process.env.AI_SERVICE_URL ?? 'http://localhost:8000';
    let cleanedContainers = [];
    try {
      const resp = await fetch(`${aiServiceUrl}/agent/reconcile`, {
        method: 'POST',
        headers: getAiServiceHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        const data = await resp.json();
        cleanedContainers = data.cleaned_containers || [];
      }
    } catch {
      // Best-effort remote container cleanup
    }

    this.activeJobs.clear();
    this.stats.reconciledOnStartup += recoveredIds.length;

    return {
      recoveredCount: recoveredIds.length,
      recoveredIds,
      cleanedContainers,
    };
  }

  async cancelJob(repairId, user = null, reason = 'Cancelled by user request') {
    const existing = await prisma.repairJob.findUnique({
      where: { id: repairId },
      include: { project: true },
    });

    if (!existing) {
      const err = new Error(`Repair job '${repairId}' not found.`);
      err.code = 'NOT_FOUND';
      err.status = 404;
      throw err;
    }

    // Tenant and RBAC authorization check
    if (user) {
      if (user.role === 'VIEWER') {
        const err = new Error('Access denied: viewer role is not authorized to cancel repair jobs.');
        err.code = 'ACCESS_DENIED';
        err.status = 403;
        throw err;
      }
      const existingOrg = existing.organizationId || existing.project?.organizationId;
      if (user.organizationId && existingOrg && user.organizationId !== existingOrg) {
        const err = new Error('Access denied: repair belongs to another organization.');
        err.code = 'ACCESS_DENIED';
        err.status = 403;
        throw err;
      }
    }

    const currentCan = this.canonicalState(existing.status);

    // Idempotent: already cancelled
    if (currentCan === JOB_STATES.CANCELLED) {
      return {
        success: true,
        repairId,
        status: 'cancelled',
        message: 'Repair job is already cancelled.',
        idempotent: true,
      };
    }

    // Do not cancel completed repairs
    if (currentCan === JOB_STATES.SUCCEEDED) {
      const err = new Error(`Cannot cancel repair job: already completed with state ${currentCan}.`);
      err.code = 'JOB_ALREADY_COMPLETED';
      err.status = 400;
      throw err;
    }

    // 1. Record cancellation requested event
    await recordRepairEvent({
      repairId,
      eventType: REPAIR_EVENT_TYPES.CANCELLATION_REQUESTED,
      status: 'warning',
      message: `Cancellation requested: ${reason}`,
      metadata: { requestedBy: user?.email || 'user', reason },
    });

    // 2. Abort local active execution if running
    const active = this.activeJobs.get(repairId);
    if (active) {
      try {
        active.abortController.abort(new Error(reason));
      } catch {}
      this.activeJobs.delete(repairId);
    }

    // 3. Dispatch cancellation to Python AI Agent service
    const aiServiceUrl = process.env.AI_SERVICE_URL ?? 'http://localhost:8000';
    try {
      await fetch(`${aiServiceUrl}/agent/cancel`, {
        method: 'POST',
        headers: getAiServiceHeaders(),
        body: JSON.stringify({ job_id: repairId, reason }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Best-effort remote signal
    }

    // 4. Guaranteed DB update to cancelled
    const updated = await prisma.repairJob.update({
      where: { id: repairId },
      data: { status: 'cancelled' },
    });

    // 5. Activity Event and Observability Events
    await prisma.activityEvent.create({
      data: {
        id: randomUUID(),
        repairId,
        event: 'repair.cancelled',
        status: 'warning',
        message: `Repair job cancelled: ${reason}.`,
      },
    });

    await recordRepairEvent({
      repairId,
      eventType: REPAIR_EVENT_TYPES.CANCELLATION_ACKNOWLEDGED,
      status: 'info',
      message: 'Cancellation acknowledged and running sandbox containers terminated.',
    });

    await recordRepairEvent({
      repairId,
      eventType: REPAIR_EVENT_TYPES.JOB_CANCELLED,
      status: 'warning',
      message: `Repair job CANCELLED: ${reason}.`,
    });

    // 6. Security Audit Log
    const orgId = user?.organizationId || existing.organizationId || existing.project?.organizationId;
    await recordAuditLog({
      organizationId: orgId,
      userId: user?.id || null,
      action: 'REPAIR_CANCELLED',
      resourceType: 'RepairJob',
      resourceId: repairId,
      repairId,
      metadata: { reason, cancelledBy: user?.email || 'user' },
    });

    return {
      success: true,
      repairId,
      status: updated.status,
      message: 'Repair job successfully cancelled.',
      idempotent: false,
    };
  }
}

export const jobLifecycleService = new JobLifecycleService();
