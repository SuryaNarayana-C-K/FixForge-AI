import { randomUUID } from "node:crypto";
import { prisma } from "@workspace/db";
import { logger, sanitizeLogText } from "../../lib/logger.js";

const SENSITIVE_KEYS = new Set([
  "password",
  "passwordhash",
  "token",
  "secret",
  "github_token",
  "githubtoken",
  "authorization",
  "cookie",
  "apikey",
  "api_key",
  "gemini_api_key",
  "gemini_key",
  "llm_api_key",
]);

export function sanitizeMetadata(data) {
  if (!data) return {};
  if (typeof data !== "object") return { value: String(data) };

  const sanitized = {};
  for (const [key, val] of Object.entries(data)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lowerKey)) {
      sanitized[key] = "[REDACTED]";
    } else if (typeof val === "string") {
      sanitized[key] = sanitizeLogText(val);
    } else if (typeof val === "object" && val !== null) {
      sanitized[key] = sanitizeMetadata(val);
    } else {
      sanitized[key] = val;
    }
  }
  return sanitized;
}

export async function recordAuditLog({
  organizationId = null,
  userId = null,
  action,
  resourceType = null,
  resourceId = null,
  metadata = {},
  repairId = null,
}) {
  try {
    const sanitized = sanitizeMetadata(metadata);
    const log = await prisma.auditLog.create({
      data: {
        id: randomUUID(),
        organizationId,
        userId,
        action,
        event: action || "SECURITY_EVENT",
        resourceType,
        resourceId,
        repairId,
        metadata: JSON.stringify(sanitized),
      },
    });
    logger.info(
      { action, organizationId, userId, resourceType, resourceId },
      "Audit log recorded",
    );
    return log;
  } catch (err) {
    logger.error({ err, action }, "Failed to write audit log");
    return null;
  }
}

export async function getAuditLogs({
  organizationId,
  userId = null,
  action = null,
  limit = 50,
  offset = 0,
}) {
  const where = {};
  if (organizationId) where.organizationId = organizationId;
  if (userId) where.userId = userId;
  if (action) where.action = action;

  return prisma.auditLog.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: Math.min(Number(limit) || 50, 100),
    skip: Number(offset) || 0,
    include: {
      user: {
        select: { id: true, name: true, email: true },
      },
    },
  });
}

export async function getSecurityOverview(organizationId) {
  const where = organizationId ? { organizationId } : {};

  const [failedLogins, accessDenied, rateLimitEvents, policyViolations, recentEvents] =
    await Promise.all([
      prisma.auditLog.count({
        where: { ...where, action: "USER_LOGIN_FAILED" },
      }),
      prisma.auditLog.count({
        where: { ...where, action: "ACCESS_DENIED" },
      }),
      prisma.auditLog.count({
        where: { ...where, action: "RATE_LIMIT_TRIGGERED" },
      }),
      prisma.auditLog.count({
        where: { ...where, action: "POLICY_VIOLATION" },
      }),
      prisma.auditLog.findMany({
        where: {
          ...where,
          action: {
            in: [
              "USER_LOGIN_FAILED",
              "ACCESS_DENIED",
              "RATE_LIMIT_TRIGGERED",
              "POLICY_VIOLATION",
              "REPAIR_APPROVED",
              "REPAIR_REJECTED",
              "GITHUB_PR_REQUESTED",
              "GITHUB_PR_CREATED",
              "POLICY_CHANGED",
              "ROLE_CHANGED",
            ],
          },
        },
        orderBy: { createdAt: "desc" },
        take: 10,
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
      }),
    ]);

  return {
    failedLogins,
    accessDenied,
    rateLimitEvents,
    policyViolations,
    recentSecurityEvents: recentEvents.map((e) => ({
      id: e.id,
      timestamp: e.createdAt,
      action: e.action,
      resourceType: e.resourceType,
      resourceId: e.resourceId,
      user: e.user ? e.user.email : null,
      metadata: (() => {
        try {
          return JSON.parse(e.metadata);
        } catch {
          return {};
        }
      })(),
    })),
  };
}
