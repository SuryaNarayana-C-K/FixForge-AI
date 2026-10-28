import { randomUUID } from 'node:crypto';
import { prisma } from '@workspace/db';

/**
 * Supported Repair Event Types (Milestone 7)
 */
export const REPAIR_EVENT_TYPES = {
  REPAIR_QUEUED: 'REPAIR_QUEUED',
  REPOSITORY_DISCOVERED: 'REPOSITORY_DISCOVERED',
  BASELINE_STARTED: 'BASELINE_STARTED',
  BASELINE_COMPLETED: 'BASELINE_COMPLETED',
  FAILURE_DETECTED: 'FAILURE_DETECTED',
  ROOT_CAUSE_STARTED: 'ROOT_CAUSE_STARTED',
  ROOT_CAUSE_COMPLETED: 'ROOT_CAUSE_COMPLETED',
  PATCH_PLANNING_STARTED: 'PATCH_PLANNING_STARTED',
  PATCH_PLANNING_COMPLETED: 'PATCH_PLANNING_COMPLETED',
  PATCH_GENERATED: 'PATCH_GENERATED',
  PATCH_VALIDATED: 'PATCH_VALIDATED',
  PATCH_APPLIED: 'PATCH_APPLIED',
  REPAIR_ATTEMPT_STARTED: 'REPAIR_ATTEMPT_STARTED',
  REPAIR_ATTEMPT_FAILED: 'REPAIR_ATTEMPT_FAILED',
  REPAIR_ATTEMPT_SUCCEEDED: 'REPAIR_ATTEMPT_SUCCEEDED',
  VERIFICATION_STARTED: 'VERIFICATION_STARTED',
  VERIFICATION_COMPLETED: 'VERIFICATION_COMPLETED',
  REPAIR_VERIFIED: 'REPAIR_VERIFIED',
  REPAIR_FAILED: 'REPAIR_FAILED',
  REGRESSION_DETECTED: 'REGRESSION_DETECTED',
  GIT_BRANCH_CREATED: 'GIT_BRANCH_CREATED',
  GIT_COMMIT_CREATED: 'GIT_COMMIT_CREATED',
  GIT_PUSHED: 'GIT_PUSHED',
  GITHUB_PR_CREATED: 'GITHUB_PR_CREATED',
  REQUIRES_REVIEW: 'REQUIRES_REVIEW',
  // M13.1 Lifecycle & Sandbox Isolation Events
  JOB_QUEUED: 'JOB_QUEUED',
  JOB_STARTED: 'JOB_STARTED',
  JOB_VERIFYING: 'JOB_VERIFYING',
  JOB_COMPLETED: 'JOB_COMPLETED',
  JOB_FAILED: 'JOB_FAILED',
  JOB_CANCELLED: 'JOB_CANCELLED',
  JOB_TIMED_OUT: 'JOB_TIMED_OUT',
  SANDBOX_CREATED: 'SANDBOX_CREATED',
  SANDBOX_CLEANUP: 'SANDBOX_CLEANUP',
  RESOURCE_LIMIT_TERMINATED: 'RESOURCE_LIMIT_TERMINATED',
  CANCELLATION_REQUESTED: 'CANCELLATION_REQUESTED',
  CANCELLATION_ACKNOWLEDGED: 'CANCELLATION_ACKNOWLEDGED',
};

/**
 * Sanitizes sensitive secrets from messages and metadata objects.
 * Never stores or leaks tokens, keys, passwords, or Authorization headers.
 * @param {any} val
 * @returns {any}
 */
export function sanitizeSecrets(val) {
  if (val == null) return val;
  if (typeof val === 'string') {
    let sanitized = val;
    // Redact Bearer tokens
    sanitized = sanitized.replace(/Bearer\s+[A-Za-z0-9_.-]+/gi, 'Bearer ***REDACTED***');
    // Redact GitHub personal access tokens
    sanitized = sanitized.replace(/gh[pousr]_[A-Za-z0-9_]{16,}/gi, '***REDACTED_TOKEN***');
    // Redact OpenAI / generic api keys
    sanitized = sanitized.replace(/sk-[A-Za-z0-9_-]{20,}/gi, '***REDACTED_API_KEY***');
    // Redact Google / Gemini api keys
    sanitized = sanitized.replace(/AIza[0-9A-Za-z_-]{35}/g, '***REDACTED_API_KEY***');
    // Redact password / token key values in JSON/strings
    sanitized = sanitized.replace(/(["']?(?:password|token|secret|apiKey|authorization)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, '$1***REDACTED***');
    // If GITHUB_TOKEN is set in env, ensure it is redacted specifically
    if (process.env.GITHUB_TOKEN) {
      sanitized = sanitized.replaceAll(process.env.GITHUB_TOKEN, '***REDACTED_TOKEN***');
    }
    // If GEMINI_API_KEY is set in env, ensure it is redacted specifically
    if (process.env.GEMINI_API_KEY) {
      sanitized = sanitized.replaceAll(process.env.GEMINI_API_KEY, '***REDACTED_API_KEY***');
    }
    return sanitized;
  }

  if (Array.isArray(val)) {
    return val.map(sanitizeSecrets);
  }

  if (typeof val === 'object') {
    const cleanObj = {};
    for (const [k, v] of Object.entries(val)) {
      const lowerKey = k.toLowerCase();
      if (
        lowerKey.includes('token') ||
        lowerKey.includes('secret') ||
        lowerKey.includes('password') ||
        lowerKey.includes('auth') ||
        lowerKey.includes('apikey')
      ) {
        cleanObj[k] = '***REDACTED***';
      } else {
        cleanObj[k] = sanitizeSecrets(v);
      }
    }
    return cleanObj;
  }

  return val;
}

/**
 * Record a structured repair event into SQLite and sync with ActivityEvent.
 * @param {object} params
 * @param {string} params.repairId
 * @param {string} params.eventType
 * @param {string} [params.status='info'] - 'info' | 'success' | 'warning' | 'error'
 * @param {string} params.message
 * @param {object|string} [params.metadata]
 * @param {number} [params.durationMs]
 * @returns {Promise<object>} The created RepairEvent record
 */
export async function recordRepairEvent({
  repairId,
  eventType,
  status = 'info',
  message,
  metadata = {},
  durationMs = null,
}) {
  if (!repairId) {
    throw new Error('repairId is required to record a repair event');
  }
  if (!eventType) {
    throw new Error('eventType is required to record a repair event');
  }

  const cleanMessage = sanitizeSecrets(message || eventType);
  const cleanMetadata = sanitizeSecrets(metadata);
  const metadataString = typeof cleanMetadata === 'string' ? cleanMetadata : JSON.stringify(cleanMetadata || {});

  const eventId = randomUUID();
  const validDuration = durationMs != null && !isNaN(Number(durationMs)) ? Number(durationMs) : null;

  // 1. Persist to new RepairEvent model
  const repairEvent = await prisma.repairEvent.create({
    data: {
      id: eventId,
      repairId,
      eventType,
      status,
      message: cleanMessage,
      metadata: metadataString,
      durationMs: validDuration,
    },
  });

  // 2. Also record in ActivityEvent for backward compatibility with M1-M6 event streams
  try {
    await prisma.activityEvent.create({
      data: {
        id: randomUUID(),
        repairId,
        event: eventType,
        status,
        message: cleanMessage,
      },
    });
  } catch {}

  return repairEvent;
}

/**
 * Retrieve chronological repair events for a repair job.
 * @param {string} repairId
 * @param {object} [options]
 * @returns {Promise<Array<object>>}
 */
export async function getRepairEvents(repairId, options = {}) {
  const events = await prisma.repairEvent.findMany({
    where: { repairId },
    orderBy: { createdAt: 'asc' },
    take: options.limit ? Number(options.limit) : undefined,
  });

  // If no RepairEvent entries exist yet (e.g. older repair jobs from M1-M5),
  // fallback to ActivityEvent entries so history is never lost.
  if (events.length === 0) {
    const activityEvents = await prisma.activityEvent.findMany({
      where: { repairId },
      orderBy: { createdAt: 'asc' },
      take: options.limit ? Number(options.limit) : undefined,
    });

    return activityEvents.map((a) => ({
      id: a.id,
      repairId: a.repairId,
      eventType: a.event,
      event: a.event,
      status: a.status,
      message: a.message,
      metadata: {},
      durationMs: null,
      createdAt: a.createdAt instanceof Date ? a.createdAt.toISOString() : a.createdAt,
    }));
  }

  return events.map((e) => {
    let parsedMeta = {};
    try {
      parsedMeta = e.metadata ? JSON.parse(e.metadata) : {};
    } catch {
      parsedMeta = {};
    }

    return {
      id: e.id,
      repairId: e.repairId,
      eventType: e.eventType,
      event: e.eventType, // alias for backwards compatibility
      status: e.status,
      message: e.message,
      metadata: parsedMeta,
      durationMs: e.durationMs != null ? Number(e.durationMs) : null,
      createdAt: e.createdAt instanceof Date ? e.createdAt.toISOString() : e.createdAt,
    };
  });
}
