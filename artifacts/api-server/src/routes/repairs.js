import { Router } from "express";
import { randomUUID } from "node:crypto";
import {
  CreateRepairBody,
  CreateRepairResponse,
  GetRepairParams,
  GetRepairResponse,
  ListRepairsResponse,
} from "@workspace/api-zod";
import { prisma, seedDatabase, DEMO_ORGS, DEMO_USERS } from "@workspace/db";
import {
  recordRepairEvent,
  REPAIR_EVENT_TYPES,
  getRepairEvents,
} from "../services/observability/event-service.js";
import { hasPermission } from "../middlewares/auth.js";
import { recordAuditLog } from "../services/security/audit-service.js";
import { classifyFailure, extractErrorSignature, FAILURE_CATEGORIES } from "../services/intelligence/failure-intelligence-service.js";
import { PatchQualityAnalyzer } from "../services/intelligence/patch-quality-service.js";
import { PatchRiskAnalyzer } from "../services/intelligence/patch-risk-service.js";
import { RepairConfidenceService } from "../services/intelligence/confidence-service.js";
import { RepairMemoryService } from "../services/intelligence/repair-memory-service.js";
import { RepairPlannerService, REPAIR_STRATEGIES } from "../services/intelligence/repair-planner-service.js";
import { RegressionIntelligenceService } from "../services/intelligence/regression-service.js";
import { ReportGenerator } from "../services/intelligence/report-generator.js";
import { resolveRepositoryWorkspace } from "../services/git/repository-resolver.js";
import { jobLifecycleService, JOB_STATES } from "../services/lifecycle/job-lifecycle-service.js";
import { getAiServiceHeaders } from "../services/ai-client.js";

async function getResolvedRepoWorkspace(repair) {
  const rawPath = repair.project?.repository;
  if (!rawPath) {
    const err = new Error("No repository associated with this repair job's project");
    err.status = 400;
    throw err;
  }
  const resolved = await resolveRepositoryWorkspace(rawPath);
  if (repair.project?.id) {
    try {
      const updateData = {};
      if (
        repair.project.repository &&
        (repair.project.repository.startsWith("http://") ||
          repair.project.repository.startsWith("https://") ||
          repair.project.repository.startsWith("git@") ||
          repair.project.repository.startsWith("github.com"))
      ) {
        updateData.repository = resolved.relativePath;
      }
      if (!repair.project.githubOwner || !repair.project.githubRepo) {
        updateData.githubOwner = repair.project.githubOwner || resolved.owner;
        updateData.githubRepo = repair.project.githubRepo || resolved.repo;
      }
      if (Object.keys(updateData).length > 0) {
        await prisma.project.update({
          where: { id: repair.project.id },
          data: updateData,
        });
      }
    } catch {}
  }
  return resolved;
}

const router = Router();

export function formatErrorDetail(detail, fallback = "Unknown error") {
  if (!detail) return fallback;
  if (typeof detail === "string") {
    const trimmed = detail.trim();
    if (trimmed && trimmed !== "[object Object]") return trimmed;
    return fallback;
  }
  if (Array.isArray(detail)) {
    const formatted = detail
      .map((item) => {
        if (!item) return "";
        if (typeof item === "string") return item;
        const loc = Array.isArray(item.loc) ? item.loc.filter((p) => p !== "body").join(".") : "";
        const msg = item.msg || item.message || (typeof item === "object" ? JSON.stringify(item) : String(item));
        return loc ? `${loc}: ${msg}` : msg;
      })
      .filter(Boolean)
      .join("; ");
    if (formatted) return formatted;
  }
  if (typeof detail === "object") {
    if (typeof detail.message === "string" && detail.message !== "[object Object]") return detail.message;
    if (typeof detail.detail === "string" && detail.detail !== "[object Object]") return detail.detail;
    if (typeof detail.error === "string" && detail.error !== "[object Object]") return detail.error;
    if (detail.error && typeof detail.error === "object") {
      const inner = formatErrorDetail(detail.error, "");
      if (inner) return inner;
    }
    if (detail.detail && typeof detail.detail === "object") {
      const inner = formatErrorDetail(detail.detail, "");
      if (inner) return inner;
    }
    try {
      const json = JSON.stringify(detail);
      if (json && json !== "{}") return json;
    } catch (_) {}
  }
  return fallback;
}

export function classifyAndSanitizeError(err, aiServiceUrl = "http://localhost:8000", context = "repair") {
  let rawMessage = "";
  if (err?.message && err.message !== "[object Object]") {
    rawMessage = err.message;
  } else if (err?.detail) {
    rawMessage = formatErrorDetail(err.detail);
  } else if (err?.error) {
    rawMessage = formatErrorDetail(err.error);
  } else if (err && typeof err === "object") {
    rawMessage = formatErrorDetail(err, "An unexpected internal error occurred.");
  } else {
    rawMessage = String(err || "An unexpected error occurred.");
  }

  if (rawMessage === "[object Object]" || rawMessage.includes("[object Object]")) {
    rawMessage = err?.code ? `Operation failed with error code ${err.code}` : "Operation failed due to an unhandled error.";
  }

  let code = err?.code || "AUTONOMOUS_REPAIR_FAILED";
  let status = typeof err?.status === "number" ? err.status : 502;

  // Redact potential API keys, GitHub tokens, Bearer tokens, connection strings
  rawMessage = rawMessage
    .replace(/AIza[0-9A-Za-z_-]{30,40}/g, "[REDACTED_API_KEY]")
    .replace(/ghp_[0-9A-Za-z]{30,40}/g, "[REDACTED_GH_TOKEN]")
    .replace(/github_pat_[0-9A-Za-z_]{70,90}/g, "[REDACTED_GH_TOKEN]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED_TOKEN]")
    .replace(/eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, "[REDACTED_JWT]")
    .replace(/(postgres|mysql|sqlite|mongodb)(\+srv)?:\/\/[^:]+:[^@]+@/gi, "$1://[REDACTED_USER]:[REDACTED_PWD]@");

  if (process.env.GEMINI_API_KEY) {
    rawMessage = rawMessage.split(process.env.GEMINI_API_KEY).join("[REDACTED_API_KEY]");
  }
  if (process.env.GITHUB_TOKEN) {
    rawMessage = rawMessage.split(process.env.GITHUB_TOKEN).join("[REDACTED_GH_TOKEN]");
  }

  const isNetworkFailure =
    rawMessage.includes("fetch failed") ||
    err?.cause?.code === "ECONNREFUSED" ||
    err?.cause?.code === "ENOTFOUND" ||
    rawMessage.includes("ECONNREFUSED") ||
    rawMessage.includes("connect ECONNREFUSED");

  const prefix = context === "analyze" ? "AI service error: " : "Autonomous repair failed: ";

  if (isNetworkFailure) {
    code = "AI_SERVICE_UNAVAILABLE";
    rawMessage = `${prefix}AI_SERVICE_UNAVAILABLE: Python AI Agent service is unreachable at ${aiServiceUrl}. Please ensure the FastAPI service is running on port 8000.`;
    status = 502;
  } else if (rawMessage.includes("LLM_CONFIGURATION_ERROR") || code === "LLM_CONFIGURATION_ERROR") {
    code = "LLM_CONFIGURATION_ERROR";
    if (!rawMessage.startsWith(prefix)) rawMessage = `${prefix}${rawMessage}`;
    status = 400;
  } else if (rawMessage.includes("LLM_AUTHENTICATION_ERROR") || code === "LLM_AUTHENTICATION_ERROR") {
    code = "LLM_AUTHENTICATION_ERROR";
    if (!rawMessage.startsWith(prefix)) rawMessage = `${prefix}${rawMessage}`;
    status = 401;
  } else if (rawMessage.includes("LLM_REQUEST_FAILED") || code === "LLM_REQUEST_FAILED") {
    code = "LLM_REQUEST_FAILED";
    if (!rawMessage.startsWith(prefix)) rawMessage = `${prefix}${rawMessage}`;
    status = 502;
  } else if (rawMessage.includes("PATCH_GENERATION_FAILED") || code === "PATCH_GENERATION_FAILED") {
    code = "PATCH_GENERATION_FAILED";
    if (!rawMessage.startsWith(prefix)) rawMessage = `${prefix}${rawMessage}`;
    status = 422;
  } else {
    if (!rawMessage.startsWith(prefix)) rawMessage = `${prefix}${rawMessage}`;
  }

  return { code, message: rawMessage, status };
}

export async function assertRepairAccess(repair, req, res, requiredPermission = "repair:view") {
  if (!repair) {
    res.status(404).json({ error: "Repair job not found", code: "NOT_FOUND" });
    return false;
  }

  // 1. Require authentication
  if (!req.user || req.isAnonymous) {
    res.status(401).json({
      error: "Authentication required to access repair resources.",
      code: "UNAUTHORIZED",
    });
    return false;
  }

  // 2. Tenant organization check: fail closed if user lacks organizationId
  const userOrg = req.user.organizationId;
  if (!userOrg) {
    res.status(403).json({
      error: "Tenant identity required: user account is not associated with an organization.",
      code: "TENANT_CONTEXT_REQUIRED",
    });
    return false;
  }

  // 3. Role permission check
  if (requiredPermission && !hasPermission(req.user.role, requiredPermission)) {
    await recordAuditLog({
      organizationId: userOrg,
      userId: req.user.id,
      action: "ACCESS_DENIED",
      resourceType: "RepairJob",
      resourceId: repair.id,
      repairId: repair.id,
      metadata: {
        reason: `Role '${req.user.role}' lacks '${requiredPermission}' permission`,
        userRole: req.user.role,
        requiredPermission,
      },
    });
    res.status(403).json({
      error: `Access denied: requires '${requiredPermission}' permission.`,
      code: "ACCESS_DENIED",
    });
    return false;
  }

  // 4. Organization isolation check: fail closed if repair.organizationId is missing or does not match userOrg
  const repairOrg = repair.organizationId;
  const projectOrg = repair.project?.organizationId;
  if (!repairOrg || repairOrg !== userOrg || (projectOrg && projectOrg !== userOrg)) {
    await recordAuditLog({
      organizationId: userOrg,
      userId: req.user.id,
      action: "ACCESS_DENIED",
      resourceType: "RepairJob",
      resourceId: repair.id,
      repairId: repair.id,
      metadata: {
        reason: "Cross-organization repair access attempt or unassigned tenant",
        userOrg,
        repairOrg: repairOrg || null,
        projectOrg: projectOrg || null,
      },
    });
    res.status(403).json({
      error: "Access denied: repair belongs to another organization.",
      code: "ACCESS_DENIED",
    });
    return false;
  }

  return true;
}

const safeJsonParse = (val) => {
  if (!val) return null;
  if (typeof val === "object") return val;
  try {
    return JSON.parse(val);
  } catch {
    return null;
  }
};

const toRepair = (r) => ({
  id: r.id,
  projectId: r.projectId,
  language: r.language || null,
  framework: r.framework || null,
  testFramework: r.testFramework || null,
  packageManager: r.packageManager || null,
  issue: r.issue,
  model: r.model,
  verificationLevel: r.verificationLevel,
  maxIterations: Number(r.maxIterations),
  status: r.status,
  iteration: Number(r.iteration),
  testsPassed: Number(r.testsPassed),
  testsTotal: Number(r.testsTotal),
  testCommand: r.testCommand || null,
  analysis: safeJsonParse(r.analysis),
  baselineResult: safeJsonParse(r.baselineResult),
  failures: safeJsonParse(r.failures) || [],
  sandboxRuns: Array.isArray(r.sandboxRuns) ? r.sandboxRuns : [],
  patches: Array.isArray(r.patches)
    ? r.patches.map((p) => ({
        id: p.id,
        repairJobId: p.repairJobId,
        attemptNumber: Number(p.attemptNumber),
        diff: p.diff,
        filesChanged: safeJsonParse(p.filesChanged) || [],
        linesAdded: Number(p.linesAdded),
        linesRemoved: Number(p.linesRemoved),
        rootCause: safeJsonParse(p.rootCause),
        patchPlan: safeJsonParse(p.patchPlan),
        validationResult: safeJsonParse(p.validationResult),
        applicationResult: safeJsonParse(p.applicationResult),
        status: p.status,
        createdAt: p.createdAt instanceof Date ? p.createdAt.toISOString() : p.createdAt,
      }))
    : [],
  attempts: Array.isArray(r.attempts)
    ? r.attempts.map((a) => ({
        id: a.id,
        repairJobId: a.repairJobId,
        attemptNumber: Number(a.attemptNumber),
        status: a.status,
        failureSummary: a.failureSummary,
        rootCause: safeJsonParse(a.rootCause),
        rootCauseConfidence: a.rootCauseConfidence != null ? Number(a.rootCauseConfidence) : null,
        patchId: a.patchId,
        testRunId: a.testRunId,
        sandboxRunId: a.sandboxRunId,
        startedAt: a.startedAt instanceof Date ? a.startedAt.toISOString() : a.startedAt,
        completedAt: a.completedAt instanceof Date ? a.completedAt.toISOString() : a.completedAt,
        duration: a.duration != null ? Number(a.duration) : null,
        rollbackPerformed: Boolean(a.rollbackPerformed),
        verificationResult: safeJsonParse(a.verificationResult),
        patchDiff: a.patchDiff,
        patchHash: a.patchHash,
        error: a.error,
        createdAt: a.createdAt instanceof Date ? a.createdAt.toISOString() : a.createdAt,
      }))
    : [],
  confidenceScore: r.confidenceScore != null ? Number(r.confidenceScore) : null,
  confidenceLevel: r.confidenceLevel || null,
  confidenceReasons: safeJsonParse(r.confidenceReasons) || [],
  patchRiskScore: r.patchRiskScore != null ? Number(r.patchRiskScore) : null,
  patchRiskLevel: r.patchRiskLevel || null,
  patchRiskReasons: safeJsonParse(r.patchRiskReasons) || [],
  patchQuality: safeJsonParse(r.patchQuality),
  failureCategory: r.failureCategory || 'UNKNOWN',
  repairStrategy: r.repairStrategy || 'UNKNOWN',
  rootCauseCertainty: r.rootCauseCertainty || 'MEDIUM',
  repairPlan: safeJsonParse(r.repairPlan),
  coverage: r.coverage != null ? Number(r.coverage) : null,
  createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
  updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : r.updatedAt,
});

router.get("/repairs", async (req, res) => {
  if (!req.user || req.isAnonymous) {
    res.status(401).json({ error: "Authentication required.", code: "UNAUTHORIZED" });
    return;
  }

  const orgId = req.user.organizationId;
  if (!orgId) {
    res.status(403).json({
      error: "Tenant identity required: user account is not associated with an organization.",
      code: "TENANT_CONTEXT_REQUIRED",
    });
    return;
  }

  const repairs = await prisma.repairJob.findMany({
    where: { organizationId: orgId },
    orderBy: { updatedAt: "desc" },
    include: {
      sandboxRuns: { orderBy: { createdAt: "asc" } },
      patches: { orderBy: { createdAt: "desc" } },
      attempts: { orderBy: { attemptNumber: "asc" } },
    },
  });
  res.json(ListRepairsResponse.parse(repairs.map(toRepair)));
});

router.post("/repairs", async (req, res) => {
  if (!req.user || req.isAnonymous) {
    res.status(401).json({ error: "Authentication required to create repairs.", code: "UNAUTHORIZED" });
    return;
  }

  const orgId = req.user.organizationId;
  if (!orgId) {
    res.status(403).json({
      error: "Tenant identity required: user account is not associated with an organization.",
      code: "TENANT_CONTEXT_REQUIRED",
    });
    return;
  }

  if (!hasPermission(req.user.role, "repair:create")) {
    await recordAuditLog({
      organizationId: orgId,
      userId: req.user.id,
      action: "ACCESS_DENIED",
      resourceType: "RepairJob",
      metadata: { reason: "Role not authorized to create repair", role: req.user.role },
    });
    res.status(403).json({
      error: "Access denied: insufficient permissions to create repair.",
      code: "ACCESS_DENIED",
    });
    return;
  }

  const parsed = CreateRepairBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const project = await prisma.project.findUnique({
    where: { id: parsed.data.projectId },
  });
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  // Cross-organization validation: fail closed if project org is null or mismatched
  if (!project.organizationId || project.organizationId !== orgId) {
    await recordAuditLog({
      organizationId: orgId,
      userId: req.user.id,
      action: "ACCESS_DENIED",
      resourceType: "Project",
      resourceId: project.id,
      metadata: { reason: "Cross-organization repair creation rejected" },
    });
    res.status(403).json({
      error: "Access denied: project belongs to another organization.",
      code: "ACCESS_DENIED",
    });
    return;
  }

  const id = randomUUID();
  const idempotencyKey = req.headers["idempotency-key"] || req.body?.idempotencyKey || null;

  if (idempotencyKey) {
    try {
      await jobLifecycleService.acquireIdempotencyLock(idempotencyKey);
    } catch (lockErr) {
      res.status(lockErr.status || 409).json({ error: lockErr.message, code: lockErr.code });
      return;
    }
  }

  try {
    // Quota enforcement
    try {
      await jobLifecycleService.checkQuotas(req.user, orgId);
    } catch (quotaErr) {
      res.status(quotaErr.status || 429).json({ error: quotaErr.message, code: quotaErr.code });
      return;
    }

    // Idempotency lookup
    if (idempotencyKey) {
      const existingJob = await prisma.repairJob.findFirst({
        where: {
          idempotencyKey,
          organizationId: orgId,
        },
      });

      if (existingJob) {
        const matches =
          existingJob.projectId === parsed.data.projectId &&
          existingJob.issue === parsed.data.issue &&
          existingJob.model === parsed.data.model &&
          existingJob.verificationLevel === parsed.data.verificationLevel &&
          existingJob.maxIterations === parsed.data.maxIterations;

        if (matches) {
          // Idempotent success: return existing record
          res.status(200).json(CreateRepairResponse.parse(toRepair(existingJob)));
          return;
        } else {
          res.status(409).json({
            error: `Idempotency key '${idempotencyKey}' was already used with a conflicting payload.`,
            code: "IDEMPOTENCY_CONFLICT",
          });
          return;
        }
      }
    }

    const created = await prisma.repairJob.create({
      data: {
        id,
        organizationId: orgId,
        createdById: req.user?.id || null,
        projectId: parsed.data.projectId,
        issue: parsed.data.issue,
        model: parsed.data.model,
        verificationLevel: parsed.data.verificationLevel,
        maxIterations: parsed.data.maxIterations,
        status: "queued",
        language: req.body?.language || null,
        framework: req.body?.framework || null,
        testFramework: req.body?.testFramework || null,
        packageManager: req.body?.packageManager || null,
        idempotencyKey: idempotencyKey || null,
      },
    });

    await recordAuditLog({
      organizationId: orgId,
      userId: req.user?.id || null,
      action: "REPAIR_CREATED",
      resourceType: "RepairJob",
      resourceId: id,
      repairId: id,
      metadata: { issue: created.issue, model: created.model, idempotencyKey },
    });

    await prisma.activityEvent.create({
      data: {
        id: randomUUID(),
        repairId: id,
        event: "agent.started",
        status: "info",
        message: "Repair job queued.",
      },
    });

    await recordRepairEvent({
      repairId: id,
      eventType: REPAIR_EVENT_TYPES.REPAIR_QUEUED,
      status: "info",
      message: "Repair job queued.",
      metadata: {
        projectId: parsed.data.projectId,
        issue: parsed.data.issue,
        model: parsed.data.model,
        maxIterations: parsed.data.maxIterations,
        idempotencyKey,
      },
    });

    res.status(201).json(CreateRepairResponse.parse(toRepair(created)));
  } finally {
    if (idempotencyKey) {
      jobLifecycleService.releaseIdempotencyLock(idempotencyKey);
    }
  }
});

router.get("/repairs/:repairId", async (req, res) => {
  const parsed = GetRepairParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message, code: "INVALID_IDENTIFIER" });
    return;
  }

  const repair = await prisma.repairJob.findUnique({
    where: { id: parsed.data.repairId },
    include: {
      project: true,
      sandboxRuns: { orderBy: { createdAt: "asc" } },
      patches: { orderBy: { createdAt: "desc" } },
      attempts: { orderBy: { attemptNumber: "asc" } },
    },
  });

  if (!(await assertRepairAccess(repair, req, res, "repair:view"))) return;

  res.json(GetRepairResponse.parse(toRepair(repair)));
});

/**
 * POST /api/repairs/:repairId/approve
 * Human approval gate (ADMIN, MANAGER only)
 */
router.post("/repairs/:repairId/approve", async (req, res) => {
  const repair = await prisma.repairJob.findUnique({
    where: { id: req.params.repairId },
    include: { project: true },
  });

  if (!(await assertRepairAccess(repair, req, res, "repair:approve"))) return;

  const repairOrg = repair.organizationId || repair.project?.organizationId;

  // Verify that repair is actually verified with passing tests
  const isVerified =
    (repair.status === "verified" ||
      repair.status === "awaiting_approval" ||
      repair.status === "approved" ||
      repair.verificationLevel === "VERIFIED") &&
    repair.testsPassed > 0 &&
    repair.testsPassed === repair.testsTotal;

  if (!isVerified) {
    res.status(400).json({
      error: "Cannot approve unverified repair. All tests must pass before approval.",
      code: "UNVERIFIED_REPAIR_BLOCKED",
    });
    return;
  }

  const updated = await prisma.repairJob.update({
    where: { id: req.params.repairId },
    data: {
      approvalStatus: "APPROVED",
      approvedBy: req.user?.id || DEMO_USERS.ADMIN.id,
      approvedAt: new Date(),
      approvalNotes: req.body?.notes || "Approved for pull request submission",
      status: "approved",
    },
  });

  await recordAuditLog({
    organizationId: req.user?.organizationId || repairOrg,
    userId: req.user?.id || null,
    action: "REPAIR_APPROVED",
    resourceType: "RepairJob",
    resourceId: repair.id,
    repairId: repair.id,
    metadata: { approvedBy: req.user?.email || "admin", notes: req.body?.notes },
  });

  res.json({
    success: true,
    repairId: updated.id,
    approvalStatus: updated.approvalStatus,
    approvedBy: updated.approvedBy,
    approvedAt: updated.approvedAt,
    notes: updated.approvalNotes,
  });
});

/**
 * POST /api/repairs/:repairId/reject
 * Human rejection gate (ADMIN, MANAGER only)
 */
router.post("/repairs/:repairId/reject", async (req, res) => {
  const repair = await prisma.repairJob.findUnique({
    where: { id: req.params.repairId },
    include: { project: true },
  });

  if (!(await assertRepairAccess(repair, req, res, "repair:reject"))) return;

  const repairOrg = repair.organizationId || repair.project?.organizationId;
  if (req.user?.organizationId && repairOrg && repairOrg !== req.user.organizationId) {
    res.status(403).json({
      error: "Access denied: repair belongs to another organization.",
      code: "ACCESS_DENIED",
    });
    return;
  }

  const updated = await prisma.repairJob.update({
    where: { id: req.params.repairId },
    data: {
      approvalStatus: "REJECTED",
      approvalNotes: req.body?.reason || "Rejected by reviewer",
      status: "rejected",
    },
  });

  await recordAuditLog({
    organizationId: req.user?.organizationId || repairOrg,
    userId: req.user?.id || null,
    action: "REPAIR_REJECTED",
    resourceType: "RepairJob",
    resourceId: repair.id,
    repairId: repair.id,
    metadata: { rejectedBy: req.user?.email, reason: req.body?.reason },
  });

  res.json({
    success: true,
    repairId: updated.id,
    approvalStatus: updated.approvalStatus,
    reason: updated.approvalNotes,
  });
});

router.get("/repairs/:repairId/sandbox/runs", async (req, res) => {
  const parsed = GetRepairParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const repair = await prisma.repairJob.findUnique({
    where: { id: parsed.data.repairId },
    include: { project: true },
  });
  if (!(await assertRepairAccess(repair, req, res, "repair:view"))) return;

  const runs = await prisma.sandboxRun.findMany({
    where: { repairJobId: parsed.data.repairId },
    orderBy: { createdAt: "asc" },
  });

  res.json(runs);
});

router.post("/repairs/:repairId/sandbox/run", async (req, res) => {
  const parsed = GetRepairParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const repair = await prisma.repairJob.findUnique({
    where: { id: parsed.data.repairId },
    include: { project: true },
  });

  if (!(await assertRepairAccess(repair, req, res, "repair:run"))) return;

  let repoPath;
  try {
    const ws = await getResolvedRepoWorkspace(repair);
    repoPath = ws.relativePath;
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
    return;
  }

  const command = req.body?.command || repair.testCommand || "pytest";
  const aiServiceUrl = process.env.AI_SERVICE_URL ?? "http://localhost:8000";

  let runResult;
  try {
    const resp = await fetch(`${aiServiceUrl}/sandbox/run`, {
      method: "POST",
      headers: getAiServiceHeaders(),
      body: JSON.stringify({
        job_id: repair.id,
        repository_path: repoPath,
        command,
        timeout: 120,
      }),
    });

    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      const detailMsg = formatErrorDetail(errBody.detail || errBody.error || errBody, `AI service returned HTTP ${resp.status}`);
      const err = new Error(detailMsg);
      err.code = errBody.code;
      err.status = resp.status;
      err.detail = errBody.detail;
      throw err;
    }
    runResult = await resp.json();
  } catch (err) {
    res.status(502).json({ error: `Sandbox execution failed: ${err.message}` });
    return;
  }

  // Persist SandboxRun in SQLite
  const runRecord = await prisma.sandboxRun.create({
    data: {
      id: randomUUID(),
      repairJobId: repair.id,
      command: runResult.command || command,
      status: runResult.status,
      exitCode: Number(runResult.exit_code),
      stdout: runResult.stdout || "",
      stderr: runResult.stderr || "",
      duration: Number(runResult.duration || 0),
      timedOut: Boolean(runResult.timed_out),
      sandboxed: Boolean(runResult.sandboxed),
    },
  });

  await prisma.activityEvent.create({
    data: {
      id: randomUUID(),
      repairId: repair.id,
      event: "sandbox.completed",
      status: runResult.exit_code === 0 ? "success" : "warning",
      message: `Sandbox execution completed: status ${runResult.status}, exit code ${runResult.exit_code} (${runResult.duration}s).`,
    },
  });

  res.json(runRecord);
});


router.post("/repairs/:repairId/analyze", async (req, res) => {
  const parsed = GetRepairParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const repair = await prisma.repairJob.findUnique({
    where: { id: parsed.data.repairId },
    include: { project: true },
  });

  if (!(await assertRepairAccess(repair, req, res, "repair:run"))) return;

  let repoPath;
  try {
    const ws = await getResolvedRepoWorkspace(repair);
    repoPath = ws.relativePath;
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
    return;
  }

  // Set status to analyzing
  await prisma.repairJob.update({
    where: { id: repair.id },
    data: { status: "analyzing" },
  });

  await prisma.activityEvent.create({
    data: {
      id: randomUUID(),
      repairId: repair.id,
      event: "analysis.started",
      status: "info",
      message: "Starting repository analysis and baseline testing...",
    },
  });

  await recordRepairEvent({
    repairId: repair.id,
    eventType: REPAIR_EVENT_TYPES.REPOSITORY_DISCOVERED,
    status: "info",
    message: `Repository discovered: ${repoPath}`,
    metadata: { repository: repoPath },
  });

  const baselineStartTime = Date.now();
  await recordRepairEvent({
    repairId: repair.id,
    eventType: REPAIR_EVENT_TYPES.BASELINE_STARTED,
    status: "info",
    message: "Baseline testing started...",
  });

  const aiServiceUrl = process.env.AI_SERVICE_URL ?? "http://localhost:8000";
  let aiResponse;
  try {
    const resp = await fetch(`${aiServiceUrl}/agent/analyze`, {
      method: "POST",
      headers: getAiServiceHeaders(),
      body: JSON.stringify({
        job_id: repair.id,
        repository_path: repoPath,
        language: repair.language || undefined,
      }),
    });

    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      const detailMsg = formatErrorDetail(errBody.detail || errBody.error || errBody, `AI service returned HTTP ${resp.status}`);
      const err = new Error(detailMsg);
      err.code = errBody.code;
      err.status = resp.status;
      err.detail = errBody.detail;
      throw err;
    }
    aiResponse = await resp.json();
  } catch (err) {
    const baselineDurationMs = Date.now() - baselineStartTime;
    const sanitized = classifyAndSanitizeError(err, aiServiceUrl, "analyze");

    await prisma.repairJob.update({
      where: { id: repair.id },
      data: { status: "failed" },
    });

    await prisma.activityEvent.create({
      data: {
        id: randomUUID(),
        repairId: repair.id,
        event: "analysis.failed",
        status: "error",
        message: sanitized.message,
      },
    });

    await recordRepairEvent({
      repairId: repair.id,
      eventType: REPAIR_EVENT_TYPES.REPAIR_FAILED,
      status: "error",
      message: sanitized.message,
      durationMs: baselineDurationMs,
      metadata: { code: sanitized.code },
    });

    res.status(sanitized.status).json({
      error: sanitized.message,
      code: sanitized.code,
    });
    return;
  }

  const baselineDurationMs = Date.now() - baselineStartTime;
  const totalTests = aiResponse.baseline?.total ?? 0;
  const passedTests = aiResponse.baseline?.passed ?? 0;
  const failedTests = aiResponse.baseline?.failed ?? 0;
  const testCommand = aiResponse.repository?.test_command || aiResponse.baseline?.command || null;
  const finalStatus = failedTests > 0 ? "testing" : "verified";

  const repoLang = aiResponse.repository?.language || repair.language || "python";
  const repoFramework = aiResponse.repository?.framework || repair.framework || null;
  const repoTestFramework = aiResponse.repository?.test_framework || repair.testFramework || null;
  const repoPkgManager = aiResponse.repository?.package_manager || repair.packageManager || null;

  await prisma.repairJob.update({
    where: { id: repair.id },
    data: {
      status: finalStatus,
      testsPassed: passedTests,
      testsTotal: totalTests,
      testCommand: testCommand,
      language: repoLang,
      framework: repoFramework,
      testFramework: repoTestFramework,
      packageManager: repoPkgManager,
      analysis: JSON.stringify(aiResponse.repository || aiResponse.analysis || {}),
      baselineResult: JSON.stringify(aiResponse.baseline || {}),
      failures: JSON.stringify(aiResponse.failures || []),
    },
  });

  if (aiResponse.repository?.test_framework || aiResponse.repository?.language) {
    await prisma.project.update({
      where: { id: repair.projectId },
      data: {
        language: aiResponse.repository.language || "Python",
        testFramework: aiResponse.repository.test_framework || undefined,
      },
    });
  }

  await prisma.activityEvent.create({
    data: {
      id: randomUUID(),
      repairId: repair.id,
      event: "baseline.completed",
      status: failedTests > 0 ? "warning" : "success",
      message: `Baseline testing complete: ${passedTests} of ${totalTests} passed (${failedTests} failed, ${aiResponse.baseline?.skipped ?? 0} skipped).`,
    },
  });

  await recordRepairEvent({
    repairId: repair.id,
    eventType: REPAIR_EVENT_TYPES.BASELINE_COMPLETED,
    status: failedTests > 0 ? "warning" : "success",
    message: `Baseline testing complete: ${passedTests}/${totalTests} passed (${failedTests} failed, ${aiResponse.baseline?.skipped ?? 0} skipped).`,
    metadata: {
      testsPassed: passedTests,
      testsTotal: totalTests,
      failedTests,
      skipped: aiResponse.baseline?.skipped ?? 0,
      durationMs: baselineDurationMs,
    },
    durationMs: baselineDurationMs,
  });

  if (failedTests > 0) {
    await recordRepairEvent({
      repairId: repair.id,
      eventType: REPAIR_EVENT_TYPES.FAILURE_DETECTED,
      status: "warning",
      message: `${failedTests} test failure(s) detected during baseline testing.`,
      metadata: {
        failedCount: failedTests,
        failures: aiResponse.failures || [],
      },
    });
  }

  const responsePayload = {
    jobId: repair.id,
    status: "baseline_completed",
    repository: {
      language: aiResponse.repository?.language || "python",
      testFramework: aiResponse.repository?.test_framework || null,
      testCommand: testCommand,
      sourcePaths: aiResponse.repository?.source_paths || [],
      testPaths: aiResponse.repository?.test_paths || [],
      dependencyFiles: aiResponse.repository?.dependency_files || [],
      configFiles: aiResponse.repository?.config_files || [],
      pythonVersion: aiResponse.repository?.python_version || null,
    },
    baseline: {
      total: totalTests,
      passed: passedTests,
      failed: failedTests,
      skipped: aiResponse.baseline?.skipped ?? 0,
      errors: aiResponse.baseline?.errors ?? 0,
      duration: aiResponse.baseline?.duration ?? 0,
      status: aiResponse.baseline?.status || (failedTests > 0 ? "failed" : "passed"),
    },
    failures: aiResponse.failures || [],
    analysis: aiResponse.repository || aiResponse.analysis || {},
  };

  res.json(responsePayload);
});

// --- Milestone 4 AI Endpoints ---

router.post("/repairs/:repairId/root-cause", async (req, res) => {
  const parsed = GetRepairParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const repair = await prisma.repairJob.findUnique({
    where: { id: parsed.data.repairId },
    include: { project: true },
  });

  if (!(await assertRepairAccess(repair, req, res, "repair:run"))) return;

  let repoPath;
  try {
    const ws = await getResolvedRepoWorkspace(repair);
    repoPath = ws.relativePath;
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
    return;
  }

  const rcStartTime = Date.now();
  await recordRepairEvent({
    repairId: repair.id,
    eventType: REPAIR_EVENT_TYPES.ROOT_CAUSE_STARTED,
    status: "info",
    message: "Root cause analysis started...",
  });

  const aiServiceUrl = process.env.AI_SERVICE_URL ?? "http://localhost:8000";
  let aiResponse;
  try {
    const resp = await fetch(`${aiServiceUrl}/agent/root-cause`, {
      method: "POST",
      headers: getAiServiceHeaders(),
      body: JSON.stringify({
        job_id: repair.id,
        repository_path: repoPath,
        failures: safeJsonParse(repair.failures),
      }),
    });

    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      const detailMsg = formatErrorDetail(errBody.detail || errBody.error || errBody, `AI service returned HTTP ${resp.status}`);
      const err = new Error(detailMsg);
      err.code = errBody.code;
      err.status = resp.status;
      err.detail = errBody.detail;
      throw err;
    }
    aiResponse = await resp.json();
  } catch (err) {
    res.status(502).json({ error: `Root cause analysis failed: ${err.message}` });
    return;
  }

  const rcDurationMs = Date.now() - rcStartTime;
  await prisma.activityEvent.create({
    data: {
      id: randomUUID(),
      repairId: repair.id,
      event: "root_cause.identified",
      status: "info",
      message: `Root cause identified: ${aiResponse.root_cause?.summary || "Analysis complete"}`,
    },
  });

  await recordRepairEvent({
    repairId: repair.id,
    eventType: REPAIR_EVENT_TYPES.ROOT_CAUSE_COMPLETED,
    status: "info",
    message: `Root cause identified: ${aiResponse.root_cause?.summary || "Analysis complete"} (${(rcDurationMs / 1000).toFixed(1)}s)`,
    metadata: {
      root_cause: aiResponse.root_cause,
      confidence: aiResponse.root_cause?.confidence,
      durationMs: rcDurationMs,
    },
    durationMs: rcDurationMs,
  });

  res.json(aiResponse);
});

router.post("/repairs/:repairId/patch", async (req, res) => {
  const parsed = GetRepairParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const repair = await prisma.repairJob.findUnique({
    where: { id: parsed.data.repairId },
    include: { project: true },
  });

  if (!(await assertRepairAccess(repair, req, res, "repair:run"))) return;

  let repoPath;
  try {
    const ws = await getResolvedRepoWorkspace(repair);
    repoPath = ws.relativePath;
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
    return;
  }

  const aiServiceUrl = process.env.AI_SERVICE_URL ?? "http://localhost:8000";
  const patchStartTime = Date.now();
  let rootCause = req.body?.rootCause;
  let patchPlan = req.body?.patchPlan;

  try {
    // 1. If root cause not supplied, compute it first
    if (!rootCause) {
      const rcResp = await fetch(`${aiServiceUrl}/agent/root-cause`, {
        method: "POST",
        headers: getAiServiceHeaders(),
        body: JSON.stringify({
          job_id: repair.id,
          repository_path: repoPath,
          failures: safeJsonParse(repair.failures),
        }),
      });
      if (!rcResp.ok) {
        throw new Error("Failed to determine root cause before patching.");
      }
      const rcData = await rcResp.json();
      rootCause = rcData.root_cause;
    }

    // 2. Plan patch
    if (!patchPlan) {
      const planStartTime = Date.now();
      await recordRepairEvent({
        repairId: repair.id,
        eventType: REPAIR_EVENT_TYPES.PATCH_PLANNING_STARTED,
        status: "info",
        message: "Patch planning started...",
      });

      const planResp = await fetch(`${aiServiceUrl}/agent/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          job_id: repair.id,
          repository_path: repoPath,
          root_cause: rootCause,
          failures: safeJsonParse(repair.failures),
        }),
      });
      if (!planResp.ok) {
        throw new Error("Failed to generate patch plan.");
      }
      const planData = await planResp.json();
      patchPlan = planData.patch_plan;

      const planDurationMs = Date.now() - planStartTime;
      await recordRepairEvent({
        repairId: repair.id,
        eventType: REPAIR_EVENT_TYPES.PATCH_PLANNING_COMPLETED,
        status: "info",
        message: "Patch plan completed.",
        metadata: { patchPlan, durationMs: planDurationMs },
        durationMs: planDurationMs,
      });
    }

    // 3. Generate and validate patch
    const patchGenStartTime = Date.now();
    await recordRepairEvent({
      repairId: repair.id,
      eventType: REPAIR_EVENT_TYPES.PATCH_GENERATED,
      status: "info",
      message: "Generating patch...",
    });

    const patchResp = await fetch(`${aiServiceUrl}/agent/patch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        job_id: repair.id,
        repository_path: repoPath,
        root_cause: rootCause,
        patch_plan: patchPlan,
        failures: safeJsonParse(repair.failures),
      }),
    });

    if (!patchResp.ok) {
      const errBody = await patchResp.json().catch(() => ({}));
      const detailMsg = formatErrorDetail(errBody.detail || errBody.error || errBody, `Patch generation failed with HTTP ${patchResp.status}`);
      const err = new Error(detailMsg);
      err.code = errBody.code;
      err.status = patchResp.status;
      err.detail = errBody.detail;
      throw err;
    }

    const patchResult = await patchResp.json();
    const genPatch = patchResult.generated_patch;
    const valResult = patchResult.validation;
    const patchDurationMs = Date.now() - patchGenStartTime;

    // Persist in Prisma Patch model
    const patchRecord = await prisma.patch.create({
      data: {
        id: randomUUID(),
        repairJobId: repair.id,
        attemptNumber: 1,
        diff: genPatch.diff,
        filesChanged: JSON.stringify(genPatch.files || []),
        linesAdded: valResult.lines_added || 0,
        linesRemoved: valResult.lines_removed || 0,
        rootCause: JSON.stringify(rootCause),
        patchPlan: JSON.stringify(patchPlan),
        validationResult: JSON.stringify(valResult),
        status: valResult.valid ? "VALID" : (valResult.status || "INVALID"),
      },
    });

    await prisma.activityEvent.create({
      data: {
        id: randomUUID(),
        repairId: repair.id,
        event: "patch.generated",
        status: valResult.valid ? "success" : "warning",
        message: `Patch generated (${valResult.lines_added} lines added, ${valResult.lines_removed} lines removed). Validation: ${valResult.status}.`,
      },
    });

    await recordRepairEvent({
      repairId: repair.id,
      eventType: REPAIR_EVENT_TYPES.PATCH_VALIDATED,
      status: valResult.valid ? "success" : "warning",
      message: `Patch validated: ${valResult.status || (valResult.valid ? "VALID" : "INVALID")} (+${valResult.lines_added || 0}/-${valResult.lines_removed || 0})`,
      metadata: {
        valid: valResult.valid,
        status: valResult.status,
        lines_added: valResult.lines_added,
        lines_removed: valResult.lines_removed,
        durationMs: patchDurationMs,
      },
      durationMs: patchDurationMs,
    });

    res.json({
      id: patchRecord.id,
      repairJobId: patchRecord.repairJobId,
      attemptNumber: patchRecord.attemptNumber,
      diff: patchRecord.diff,
      filesChanged: safeJsonParse(patchRecord.filesChanged) || [],
      linesAdded: patchRecord.linesAdded,
      linesRemoved: patchRecord.linesRemoved,
      rootCause: safeJsonParse(patchRecord.rootCause),
      patchPlan: safeJsonParse(patchRecord.patchPlan),
      validationResult: safeJsonParse(patchRecord.validationResult),
      status: patchRecord.status,
      createdAt: patchRecord.createdAt.toISOString(),
    });
  } catch (err) {
    res.status(502).json({ error: `Patch generation error: ${err.message}` });
  }
});

router.post("/repairs/:repairId/apply-patch", async (req, res) => {
  const parsed = GetRepairParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const repair = await prisma.repairJob.findUnique({
    where: { id: parsed.data.repairId },
    include: { project: true, patches: { orderBy: { createdAt: "desc" }, take: 1 } },
  });

  if (!(await assertRepairAccess(repair, req, res, "repair:run"))) return;

  let repoPath;
  try {
    const ws = await getResolvedRepoWorkspace(repair);
    repoPath = ws.relativePath;
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
    return;
  }

  // Determine diff to apply
  let diffToApply = req.body?.diff;
  let targetPatch = null;

  if (req.body?.patchId) {
    targetPatch = await prisma.patch.findUnique({ where: { id: req.body.patchId } });
    if (targetPatch) diffToApply = targetPatch.diff;
  } else if (repair.patches && repair.patches.length > 0) {
    targetPatch = repair.patches[0];
    diffToApply = targetPatch.diff;
  }

  if (!diffToApply) {
    res.status(400).json({ error: "No patch diff found to apply." });
    return;
  }

  const applyStartTime = Date.now();
  const aiServiceUrl = process.env.AI_SERVICE_URL ?? "http://localhost:8000";
  let applyResponse;
  try {
    const resp = await fetch(`${aiServiceUrl}/agent/apply-patch`, {
      method: "POST",
      headers: getAiServiceHeaders(),
      body: JSON.stringify({
        job_id: repair.id,
        repository_path: repoPath,
        diff: diffToApply,
      }),
    });

    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      const detailMsg = formatErrorDetail(errBody.detail || errBody.error || errBody, `AI service returned HTTP ${resp.status}`);
      const err = new Error(detailMsg);
      err.code = errBody.code;
      err.status = resp.status;
      err.detail = errBody.detail;
      throw err;
    }
    applyResponse = await resp.json();
  } catch (err) {
    res.status(502).json({ error: `Patch application error: ${err.message}` });
    return;
  }

  const appResult = applyResponse.result;
  const applyDurationMs = Date.now() - applyStartTime;

  if (targetPatch) {
    await prisma.patch.update({
      where: { id: targetPatch.id },
      data: {
        applicationResult: JSON.stringify(appResult),
        status: appResult.applied ? "APPLIED" : (appResult.status || "FAILED"),
      },
    });
  }

  await prisma.activityEvent.create({
    data: {
      id: randomUUID(),
      repairId: repair.id,
      event: "patch.applied",
      status: appResult.applied ? "success" : "error",
      message: appResult.applied
        ? `Patch applied successfully to ${appResult.files_modified?.join(", ")}.`
        : `Patch application failed: ${appResult.error}`,
    },
  });

  await recordRepairEvent({
    repairId: repair.id,
    eventType: REPAIR_EVENT_TYPES.PATCH_APPLIED,
    status: appResult.applied ? "success" : "error",
    message: appResult.applied
      ? `Patch applied successfully to ${appResult.files_modified?.join(", ")}.`
      : `Patch application failed: ${appResult.error}`,
    metadata: {
      applied: appResult.applied,
      status: appResult.status,
      filesModified: appResult.files_modified,
      error: appResult.error,
      durationMs: applyDurationMs,
    },
    durationMs: applyDurationMs,
  });

  await prisma.auditLog.create({
    data: {
      id: randomUUID(),
      repairId: repair.id,
      event: "PATCH_APPLIED",
      metadata: JSON.stringify({
        applied: appResult.applied,
        status: appResult.status,
        filesModified: appResult.files_modified,
        backupId: appResult.backup_id,
        error: appResult.error,
      }),
    },
  });

  res.json({
    applied: appResult.applied,
    status: appResult.status,
    result: appResult,
  });
});

router.get("/repairs/:repairId/patch", async (req, res) => {
  const parsed = GetRepairParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const repair = await prisma.repairJob.findUnique({
    where: { id: parsed.data.repairId },
    include: { project: true },
  });

  if (!(await assertRepairAccess(repair, req, res, "repair:view"))) return;

  const patch = await prisma.patch.findFirst({
    where: { repairJobId: parsed.data.repairId },
    orderBy: { createdAt: "desc" },
  });

  if (!patch) {
    res.status(404).json({ error: "No patch found for this repair job" });
    return;
  }

  res.json({
    id: patch.id,
    repairJobId: patch.repairJobId,
    attemptNumber: patch.attemptNumber,
    diff: patch.diff,
    filesChanged: safeJsonParse(patch.filesChanged) || [],
    linesAdded: patch.linesAdded,
    linesRemoved: patch.linesRemoved,
    rootCause: safeJsonParse(patch.rootCause),
    patchPlan: safeJsonParse(patch.patchPlan),
    validationResult: safeJsonParse(patch.validationResult),
    applicationResult: safeJsonParse(patch.applicationResult),
    status: patch.status,
    createdAt: patch.createdAt.toISOString(),
  });
});


router.post("/repairs/:repairId/repair", async (req, res) => {
  const parsed = GetRepairParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const repair = await prisma.repairJob.findUnique({
    where: { id: parsed.data.repairId },
    include: { project: true },
  });

  if (!(await assertRepairAccess(repair, req, res, "repair:run"))) return;

  // Idempotency & Concurrency: Acquire execution slot
  let abortController;
  try {
    abortController = jobLifecycleService.acquireSlot(repair.id, req.user, repair.organizationId);
  } catch (slotErr) {
    res.status(slotErr.status || 409).json({ error: slotErr.message, code: slotErr.code });
    return;
  }

  let repoPath;
  try {
    const ws = await getResolvedRepoWorkspace(repair);
    repoPath = ws.relativePath;
  } catch (err) {
    jobLifecycleService.releaseSlot(repair.id);
    res.status(err.status || 400).json({ error: err.message });
    return;
  }

  const maxAttempts = Number(req.body?.maxAttempts) || Number(repair.maxIterations) || 3;
  const testCommand = req.body?.command || repair.testCommand || "pytest";

  await prisma.repairJob.update({
    where: { id: repair.id },
    data: { status: "self_correcting" },
  });

  await prisma.activityEvent.create({
    data: {
      id: randomUUID(),
      repairId: repair.id,
      event: "repair.started",
      status: "info",
      message: `Autonomous self-correction loop started (max attempts: ${maxAttempts}).`,
    },
  });

  const repairStartTime = Date.now();
  await recordRepairEvent({
    repairId: repair.id,
    eventType: REPAIR_EVENT_TYPES.REPAIR_ATTEMPT_STARTED,
    status: "info",
    message: `Autonomous self-correction loop started (max attempts: ${maxAttempts}).`,
    metadata: { maxAttempts, command: testCommand },
  });

  const aiServiceUrl = process.env.AI_SERVICE_URL ?? "http://localhost:8000";
  const maxRetries = Number(repair.maxRetries) || 2;
  let retryCount = Number(repair.retryCount) || 0;
  let correctionResult;
  let lastError;

  while (retryCount <= maxRetries) {
    try {
      const resp = await fetch(`${aiServiceUrl}/agent/self-correction`, {
        method: "POST",
        headers: getAiServiceHeaders(),
        signal: abortController.signal,
        body: JSON.stringify({
          job_id: repair.id,
          repository_path: repoPath,
          test_command: testCommand,
          max_attempts: maxAttempts,
          issue: repair.issue,
          language: repair.language || undefined,
        }),
      });

      if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({}));
        const detailMsg = formatErrorDetail(errBody.detail || errBody.error || errBody, `AI service returned HTTP ${resp.status}`);
        const err = new Error(detailMsg);
        err.code = errBody.code;
        err.status = resp.status;
        err.detail = errBody.detail;
        throw err;
      }
      correctionResult = await resp.json();
      if (retryCount > 0) {
        jobLifecycleService.stats.retriesSucceeded += 1;
      }
      break;
    } catch (err) {
      lastError = err;

      // Check if cancellation occurred
      const freshCheck = await prisma.repairJob.findUnique({ where: { id: repair.id } });
      if (freshCheck && (freshCheck.status === "cancelled" || err.name === "AbortError" || abortController.signal.aborted)) {
        jobLifecycleService.releaseSlot(repair.id);
        res.json({
          job_id: repair.id,
          status: "cancelled",
          is_verified: false,
          message: "Repair job was cancelled by user request.",
        });
        return;
      }

      // Check if transient failure is retryable
      const isRetryable = jobLifecycleService.isRetryableFailure(err);
      if (isRetryable && retryCount < maxRetries) {
        retryCount += 1;
        jobLifecycleService.stats.retriesAttempted += 1;
        await prisma.repairJob.update({
          where: { id: repair.id },
          data: { retryCount },
        });

        await recordRepairEvent({
          repairId: repair.id,
          eventType: REPAIR_EVENT_TYPES.REPAIR_ATTEMPT_FAILED,
          status: "warning",
          message: `Transient failure encountered: ${err.message}. Retrying attempt ${retryCount} of ${maxRetries}...`,
          metadata: { retryCount, maxRetries, error: err.message },
        });

        // Exponential backoff: 300ms * 2^retryCount
        const backoffMs = Math.min(300 * Math.pow(2, retryCount), 3000);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }

      break;
    }
  }

  const totalRepairDurationMs = Date.now() - repairStartTime;

  if (!correctionResult) {
    jobLifecycleService.releaseSlot(repair.id);

    const sanitized = classifyAndSanitizeError(lastError, aiServiceUrl);

    await prisma.repairJob.update({
      where: { id: repair.id },
      data: { status: "failed" },
    });
    await prisma.activityEvent.create({
      data: {
        id: randomUUID(),
        repairId: repair.id,
        event: "repair.failed",
        status: "error",
        message: sanitized.message,
      },
    });
    await recordRepairEvent({
      repairId: repair.id,
      eventType: REPAIR_EVENT_TYPES.REPAIR_FAILED,
      status: "error",
      message: sanitized.message,
      durationMs: totalRepairDurationMs,
      metadata: { code: sanitized.code },
    });
    res.status(sanitized.status).json({
      error: sanitized.message,
      code: sanitized.code,
      durationMs: totalRepairDurationMs,
    });
    return;
  }

  // Persist attempt history into RepairAttempt and Patch tables
  const attemptHistory = correctionResult.attempt_history || [];
  for (const item of attemptHistory) {
    const attemptId = randomUUID();
    const patchId = randomUUID();
    const attemptNum = Number(item.attempt || item.attempt_number) || 1;

    const diff = item.patch || item.generated_patch?.diff;
    const filesChanged = item.files_changed || item.generated_patch?.files || [];
    const linesAdded = Number(item.lines_added || item.validation?.lines_added) || 0;
    const linesRemoved = Number(item.lines_removed || item.linesRemoved || item.validation?.lines_removed) || 0;
    const attemptStatus = item.result || item.status || "UNKNOWN";
    const isPassing = attemptStatus === "VERIFIED" || attemptStatus === "PASSED";
    const attemptDurationMs = item.duration != null ? Math.round(Number(item.duration) * 1000) : null;

    if (diff) {
      await prisma.patch.create({
        data: {
          id: patchId,
          repairJobId: repair.id,
          attemptNumber: attemptNum,
          diff: diff,
          filesChanged: JSON.stringify(filesChanged),
          linesAdded: linesAdded,
          linesRemoved: linesRemoved,
          rootCause: item.root_cause ? JSON.stringify(item.root_cause) : null,
          patchPlan: item.patch_plan ? JSON.stringify(item.patch_plan) : null,
          validationResult: item.validation ? JSON.stringify(item.validation) : null,
          applicationResult: item.application ? JSON.stringify(item.application) : null,
          status: isPassing ? "APPLIED" : attemptStatus || "FAILED",
        },
      });

      await recordRepairEvent({
        repairId: repair.id,
        eventType: REPAIR_EVENT_TYPES.PATCH_GENERATED,
        status: "info",
        message: `Patch generated for attempt ${attemptNum} (+${linesAdded}/-${linesRemoved}).`,
        metadata: { attemptNumber: attemptNum, filesChanged, linesAdded, linesRemoved },
      });

      await recordRepairEvent({
        repairId: repair.id,
        eventType: REPAIR_EVENT_TYPES.PATCH_VALIDATED,
        status: item.validation?.valid !== false ? "success" : "warning",
        message: `Patch validated for attempt ${attemptNum}: ${item.validation?.status || "VALID"}.`,
        metadata: { attemptNumber: attemptNum, validation: item.validation },
      });

      if (item.application?.applied) {
        await recordRepairEvent({
          repairId: repair.id,
          eventType: REPAIR_EVENT_TYPES.PATCH_APPLIED,
          status: "success",
          message: `Patch applied for attempt ${attemptNum} to ${item.application?.files_modified?.join(", ") || "repository"}.`,
          metadata: { attemptNumber: attemptNum, filesModified: item.application?.files_modified },
        });
      }
    }

    await prisma.repairAttempt.create({
      data: {
        id: attemptId,
        repairJobId: repair.id,
        attemptNumber: attemptNum,
        status: attemptStatus,
        failureSummary: item.failure_summary || (item.failures?.length ? `${item.failures.length} test failure(s)` : null),
        rootCause: item.root_cause ? JSON.stringify(item.root_cause) : null,
        rootCauseConfidence: typeof item.root_cause_confidence === "number" ? item.root_cause_confidence : null,
        patchId: diff ? patchId : null,
        rollbackPerformed: Boolean(item.rollback_performed),
        verificationResult: (item.verification_result || item.verification) ? JSON.stringify(item.verification_result || item.verification) : null,
        duration: typeof item.duration === "number" ? item.duration : null,
      },
    });

    await prisma.activityEvent.create({
      data: {
        id: randomUUID(),
        repairId: repair.id,
        event: `attempt.${attemptNum}.${attemptStatus.toLowerCase()}`,
        status: isPassing ? "success" : "warning",
        message: `Attempt ${attemptNum}: ${attemptStatus}${item.rollback_performed ? " (Rolled back)" : ""}`,
      },
    });

    const ver = item.verification_result || item.verification || {};
    if (ver.status || ver.total != null) {
      await recordRepairEvent({
        repairId: repair.id,
        eventType: REPAIR_EVENT_TYPES.VERIFICATION_STARTED,
        status: "info",
        message: `Verification testing started for attempt ${attemptNum}.`,
      });
      await recordRepairEvent({
        repairId: repair.id,
        eventType: REPAIR_EVENT_TYPES.VERIFICATION_COMPLETED,
        status: isPassing ? "success" : "warning",
        message: `Verification testing completed for attempt ${attemptNum}: ${ver.passed || 0}/${ver.total || 0} passed.`,
        metadata: { attemptNumber: attemptNum, passed: ver.passed, total: ver.total, failed: ver.failed, status: ver.status },
      });
    }

    if (ver.regression_detected) {
      await recordRepairEvent({
        repairId: repair.id,
        eventType: REPAIR_EVENT_TYPES.REGRESSION_DETECTED,
        status: "warning",
        message: `Regression detected during attempt ${attemptNum}.`,
        metadata: { attemptNumber: attemptNum, regression: ver.regression_detected },
      });
    }

    if (isPassing) {
      await recordRepairEvent({
        repairId: repair.id,
        eventType: REPAIR_EVENT_TYPES.REPAIR_ATTEMPT_SUCCEEDED,
        status: "success",
        message: `Attempt ${attemptNum} SUCCEEDED (${ver.passed || 0}/${ver.total || 0} passed).`,
        metadata: { attemptNumber: attemptNum, passed: ver.passed, total: ver.total },
        durationMs: attemptDurationMs,
      });
    } else {
      await recordRepairEvent({
        repairId: repair.id,
        eventType: REPAIR_EVENT_TYPES.REPAIR_ATTEMPT_FAILED,
        status: "warning",
        message: `Attempt ${attemptNum} FAILED: ${item.failure_summary || (ver.failed ? `${ver.failed} test(s) failed` : "Tests did not pass")}.`,
        metadata: { attemptNumber: attemptNum, rollbackPerformed: Boolean(item.rollback_performed) },
        durationMs: attemptDurationMs,
      });
    }
  }

  let finalStatus = "failed";
  if (correctionResult.is_verified) {
    finalStatus = "verified";
  } else if (correctionResult.final_status === "REQUIRES_REVIEW") {
    finalStatus = "requires_review";
  } else if (correctionResult.final_status === "TIMEOUT") {
    finalStatus = "timeout";
  } else {
    finalStatus = "failed";
  }

  const lastAttempt = attemptHistory[attemptHistory.length - 1];
  const verResult = correctionResult.verification_result || lastAttempt?.verification || lastAttempt?.verification_result || {};
  const testsPassed = verResult.passed != null ? verResult.passed : repair.testsPassed;
  const testsTotal = verResult.total != null ? verResult.total : repair.testsTotal;

  // Centralized verification policy enforcement: FixForge must NEVER mark a repair
  // verified when zero tests were collected, only skipped tests existed, regressions occurred,
  // or failures/errors remain.
  if (finalStatus === "verified") {
    const passedNum = Number(testsPassed);
    const totalNum = Number(testsTotal);
    const skippedNum = Number(verResult.skipped) || 0;
    const executedNum = totalNum - skippedNum;
    const failedNum = Number(verResult.failed) || 0;
    const errorsNum = Number(verResult.errors) || 0;
    const hasRegressions = Boolean(verResult.regression_detected || (verResult.new_failures && verResult.new_failures.length > 0));
    const exitCode = verResult.exit_code != null ? Number(verResult.exit_code) : (failedNum > 0 ? 1 : 0);

    const isGenuineVerification =
      Boolean(correctionResult.is_verified) &&
      !isNaN(passedNum) &&
      !isNaN(totalNum) &&
      passedNum > 0 &&
      totalNum > 0 &&
      executedNum > 0 &&
      passedNum === executedNum &&
      failedNum === 0 &&
      errorsNum === 0 &&
      exitCode === 0 &&
      !hasRegressions;

    if (!isGenuineVerification) {
      finalStatus = "failed";
    }
  }

  // Guard against late callback overwriting cancelled status
  const freshCheck = await prisma.repairJob.findUnique({ where: { id: repair.id } });
  if (freshCheck && (freshCheck.status === "cancelled" || freshCheck.status === "CANCELLED")) {
    jobLifecycleService.releaseSlot(repair.id);
    res.json({
      job_id: repair.id,
      status: "cancelled",
      is_verified: false,
      attempt_count: correctionResult.attempt_count || 1,
      final_status: "cancelled",
      repair: toRepair(freshCheck),
      message: "Repair job was cancelled; late success update discarded.",
    });
    return;
  }

  const updatedJob = await prisma.repairJob.update({
    where: { id: repair.id },
    data: {
      status: finalStatus,
      iteration: correctionResult.attempt_count || 1,
      testsPassed: Number(testsPassed),
      testsTotal: Number(testsTotal),
    },
    include: {
      sandboxRuns: { orderBy: { createdAt: "asc" } },
      patches: { orderBy: { createdAt: "desc" } },
      attempts: { orderBy: { attemptNumber: "asc" } },
    },
  });

  await prisma.activityEvent.create({
    data: {
      id: randomUUID(),
      repairId: repair.id,
      event: finalStatus === "verified" ? "repair.verified" : "repair.failed",
      status: finalStatus === "verified" ? "success" : "error",
      message: finalStatus === "verified"
        ? `Repair VERIFIED: ${testsPassed}/${testsTotal} tests passing across ${correctionResult.attempt_count} attempt(s).`
        : `Repair finished with status: ${finalStatus} after ${correctionResult.attempt_count} attempt(s).`,
    },
  });

  if (finalStatus === "verified") {
    await recordRepairEvent({
      repairId: repair.id,
      eventType: REPAIR_EVENT_TYPES.REPAIR_VERIFIED,
      status: "success",
      message: `Repair VERIFIED: ${testsPassed}/${testsTotal} tests passing across ${correctionResult.attempt_count || 1} attempt(s) (${(totalRepairDurationMs / 1000).toFixed(1)}s).`,
      metadata: {
        testsPassed,
        testsTotal,
        attempts: correctionResult.attempt_count || 1,
        durationMs: totalRepairDurationMs,
      },
      durationMs: totalRepairDurationMs,
    });
  } else if (finalStatus === "requires_review") {
    await recordRepairEvent({
      repairId: repair.id,
      eventType: REPAIR_EVENT_TYPES.REQUIRES_REVIEW,
      status: "warning",
      message: `Repair REQUIRES REVIEW: max iterations reached without clean fix.`,
      metadata: {
        attempts: correctionResult.attempt_count || 1,
        testsPassed,
        testsTotal,
      },
      durationMs: totalRepairDurationMs,
    });
    await recordRepairEvent({
      repairId: repair.id,
      eventType: REPAIR_EVENT_TYPES.REPAIR_FAILED,
      status: "error",
      message: `Repair failed: manual review required.`,
      durationMs: totalRepairDurationMs,
    });
  } else {
    await recordRepairEvent({
      repairId: repair.id,
      eventType: REPAIR_EVENT_TYPES.REPAIR_FAILED,
      status: "error",
      message: `Repair failed with status: ${finalStatus}.`,
      durationMs: totalRepairDurationMs,
    });
  }

  await prisma.auditLog.create({
    data: {
      id: randomUUID(),
      repairId: repair.id,
      event: finalStatus === "verified" ? "REPAIR_VERIFIED" : "REPAIR_FAILED",
      metadata: JSON.stringify({
        is_verified: correctionResult.is_verified,
        final_status: finalStatus,
        attempts: correctionResult.attempt_count,
        total_llm_calls: correctionResult.total_llm_calls,
        verification_result: verResult,
      }),
    },
  });

  // M10 Intelligence Analysis: Quality, Risk, Failure Category, Strategy, Confidence
  let intelligenceData = {};
  try {
    const bestAttempt = attemptHistory.find((a) => a.patch || a.generated_patch?.diff) || attemptHistory[attemptHistory.length - 1] || {};
    const diffContent = bestAttempt.patch || bestAttempt.generated_patch?.diff || (repair.patches?.[0]?.diff) || "";
    const patchQuality = diffContent ? PatchQualityAnalyzer.analyzeDiff(diffContent) : null;
    const patchRisk = patchQuality ? PatchRiskAnalyzer.assessRisk(patchQuality.metrics) : { riskScore: 0.1, level: "LOW", reasons: [] };

    const failures = safeJsonParse(repair.failures) || [];
    const errorText = failures.map((f) => `${f.test_name}: ${f.message}`).join("\n") || repair.issue;
    const failureCategory = classifyFailure(errorText, "", repair.language || "Python");
    const errorSignature = extractErrorSignature(errorText, failureCategory);
    const repairStrategy = RepairPlannerService.inferStrategy(failureCategory);
    const rootCauseCertainty = RepairPlannerService.assessRootCauseCertainty(repair.issue, failureCategory, failures).certainty;

    const regressionCheck = RegressionIntelligenceService.analyzeRegression({
      baselineResult: safeJsonParse(repair.baselineResult),
      currentResult: verResult,
      modifiedFiles: patchQuality?.metrics?.files || [],
    });

    const confidence = RepairConfidenceService.calculateScore({
      isVerified: Boolean(correctionResult.is_verified || finalStatus === "verified"),
      testsPassed: Number(testsPassed),
      testsTotal: Number(testsTotal),
      hasRegression: regressionCheck.hasRegression,
      attemptCount: correctionResult.attempt_count || 1,
      linesChanged: (patchQuality?.metrics?.linesAdded || 0) + (patchQuality?.metrics?.linesRemoved || 0),
      filesChanged: patchQuality?.metrics?.filesChanged || 1,
      rootCauseCertainty,
    });

    const plan = await RepairPlannerService.createPlan({
      issue: repair.issue,
      analysis: safeJsonParse(repair.analysis),
      failures,
      language: repair.language || "Python",
      framework: repair.testFramework || repair.framework || "pytest",
      organizationId: repair.organizationId,
    });

    await prisma.repairJob.update({
      where: { id: repair.id },
      data: {
        confidenceScore: confidence.score,
        confidenceLevel: confidence.level,
        confidenceReasons: JSON.stringify(confidence.reasons),
        patchRiskScore: patchRisk.riskScore,
        patchRiskLevel: patchRisk.level,
        patchRiskReasons: JSON.stringify(patchRisk.reasons),
        patchQuality: patchQuality ? JSON.stringify(patchQuality) : null,
        failureCategory,
        repairStrategy,
        rootCauseCertainty,
        repairPlan: JSON.stringify(plan),
      },
    });

    if (finalStatus === "verified") {
      await RepairMemoryService.recordMemory({
        organizationId: repair.organizationId,
        repairJobId: repair.id,
        language: repair.language || "Python",
        framework: repair.testFramework || repair.framework || "pytest",
        failureCategory,
        errorSignature,
        rootCauseCategory: failureCategory,
        patchStrategy: repairStrategy,
        verificationOutcome: "VERIFIED",
        attemptCount: correctionResult.attempt_count || 1,
        confidenceScore: confidence.score,
        riskScore: patchRisk.riskScore,
        summary: `Verified repair using ${repairStrategy} for ${failureCategory}`,
      });
    }

    intelligenceData = {
      confidence,
      risk: patchRisk,
      quality: patchQuality,
      failureCategory,
      repairStrategy,
      rootCauseCertainty,
      plan,
    };
  } catch (err) {
    console.warn("Failed to compute M10 intelligence metrics:", err.message);
  }
  jobLifecycleService.releaseSlot(repair.id);

  res.json({
    job_id: repair.id,
    status: finalStatus,
    is_verified: Boolean(correctionResult.is_verified),
    attempt_count: correctionResult.attempt_count || 1,
    final_status: correctionResult.final_status,
    attempt_history: correctionResult.attempt_history || [],
    verification_result: correctionResult.verification_result || null,
    repair: toRepair(updatedJob),
  });
});

/**
 * POST /api/repairs/:repairId/cancel
 * Idempotent cancellation endpoint (Milestone 13.1)
 */
router.post("/repairs/:repairId/cancel", async (req, res) => {
  const parsed = GetRepairParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message, code: "INVALID_IDENTIFIER" });
    return;
  }

  const isProduction =
    process.env.NODE_ENV === "production" ||
    process.env.FIXFORGE_ENV === "production" ||
    process.env.NODE_ENV === "staging" ||
    process.env.FIXFORGE_ENV === "staging";
  if ((isProduction || req.headers["x-anonymous"] === "true") && (!req.user || req.isAnonymous)) {
    res.status(401).json({ error: "Authentication required to cancel repairs.", code: "UNAUTHORIZED" });
    return;
  }

  try {
    const result = await jobLifecycleService.cancelJob(
      parsed.data.repairId,
      req.user,
      req.body?.reason || "Cancelled by user request"
    );
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, code: err.code || "CANCEL_FAILED" });
  }
});

/**
 * GET /api/repairs/:repairId/lifecycle
 * Query repair job lifecycle state machine status (Milestone 13.1)
 */
router.get("/repairs/:repairId/lifecycle", async (req, res) => {
  const parsed = GetRepairParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message, code: "INVALID_IDENTIFIER" });
    return;
  }

  const repair = await prisma.repairJob.findUnique({
    where: { id: parsed.data.repairId },
    include: { project: true },
  });

  if (!(await assertRepairAccess(repair, req, res, "repair:view"))) return;

  const canonical = jobLifecycleService.canonicalState(repair.status);
  const isActive = jobLifecycleService.activeJobs.has(repair.id);

  res.json({
    repairId: repair.id,
    status: repair.status,
    canonicalState: canonical,
    active: isActive,
    createdAt: repair.createdAt,
    updatedAt: repair.updatedAt,
  });
});

/**
 * GET /api/repairs/stats/concurrency
 * Query concurrency limits and capacity metrics (Milestone 13.1)
 */
router.get("/repairs/stats/concurrency", (req, res) => {
  res.json(jobLifecycleService.getConcurrencyStats());
});

router.get("/repairs/:repairId/attempts", async (req, res) => {
  const parsed = GetRepairParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const repair = await prisma.repairJob.findUnique({
    where: { id: parsed.data.repairId },
    include: { project: true },
  });

  if (!(await assertRepairAccess(repair, req, res, "repair:view"))) return;

  const attempts = await prisma.repairAttempt.findMany({
    where: { repairJobId: parsed.data.repairId },
    orderBy: { attemptNumber: "asc" },
  });

  res.json(
    attempts.map((a) => ({
      id: a.id,
      repairJobId: a.repairJobId,
      attemptNumber: Number(a.attemptNumber),
      status: a.status,
      failureSummary: a.failureSummary,
      rootCause: safeJsonParse(a.rootCause),
      rootCauseConfidence: a.rootCauseConfidence != null ? Number(a.rootCauseConfidence) : null,
      patchId: a.patchId,
      testRunId: a.testRunId,
      sandboxRunId: a.sandboxRunId,
      startedAt: a.startedAt instanceof Date ? a.startedAt.toISOString() : a.startedAt,
      completedAt: a.completedAt instanceof Date ? a.completedAt.toISOString() : a.completedAt,
      duration: a.duration != null ? Number(a.duration) : null,
      rollbackPerformed: Boolean(a.rollbackPerformed),
      verificationResult: safeJsonParse(a.verificationResult),
      patchDiff: a.patchDiff,
      patchHash: a.patchHash,
      error: a.error,
      createdAt: a.createdAt instanceof Date ? a.createdAt.toISOString() : a.createdAt,
    }))
  );
});

router.get("/repairs/:repairId/events", async (req, res) => {
  const parsed = GetRepairParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const repair = await prisma.repairJob.findUnique({
    where: { id: parsed.data.repairId },
    include: { project: true },
  });

  if (!(await assertRepairAccess(repair, req, res, "repair:view"))) return;

  const events = await getRepairEvents(parsed.data.repairId);
  res.json(events);
});

router.post("/repairs/:repairId/verify", async (req, res) => {
  const parsed = GetRepairParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const repair = await prisma.repairJob.findUnique({
    where: { id: parsed.data.repairId },
    include: { project: true },
  });

  if (!(await assertRepairAccess(repair, req, res, "repair:run"))) return;

  let repoPath;
  try {
    const ws = await getResolvedRepoWorkspace(repair);
    repoPath = ws.relativePath;
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
    return;
  }

  const testCommand = req.body?.command || repair.testCommand || "pytest";
  const aiServiceUrl = process.env.AI_SERVICE_URL ?? "http://localhost:8000";

  const verifyStartTime = Date.now();
  await recordRepairEvent({
    repairId: repair.id,
    eventType: REPAIR_EVENT_TYPES.VERIFICATION_STARTED,
    status: "info",
    message: "On-demand verification testing started...",
  });

  let verifyResult;
  try {
    const resp = await fetch(`${aiServiceUrl}/agent/verify`, {
      method: "POST",
      headers: getAiServiceHeaders(),
      body: JSON.stringify({
        job_id: repair.id,
        repository_path: repoPath,
        test_command: testCommand,
      }),
    });

    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      const detailMsg = formatErrorDetail(errBody.detail || errBody.error || errBody, `AI service returned HTTP ${resp.status}`);
      const err = new Error(detailMsg);
      err.code = errBody.code;
      err.status = resp.status;
      err.detail = errBody.detail;
      throw err;
    }
    verifyResult = await resp.json();
  } catch (err) {
    const verifyDurationMs = Date.now() - verifyStartTime;
    await recordRepairEvent({
      repairId: repair.id,
      eventType: REPAIR_EVENT_TYPES.VERIFICATION_COMPLETED,
      status: "error",
      message: `Verification execution failed: ${err.message}`,
      durationMs: verifyDurationMs,
    });
    res.status(502).json({ error: `Verification execution failed: ${err.message}` });
    return;
  }

  const v = verifyResult.verification || {};
  const isPassed =
    v.status === "PASSED" &&
    v.exit_code === 0 &&
    (v.total || 0) > 0 &&
    ((v.total || 0) - (v.skipped || 0)) > 0 &&
    (v.passed || 0) > 0 &&
    (v.failed || 0) === 0 &&
    (v.errors || 0) === 0 &&
    !v.regression_detected;
  const verifyDurationMs = Date.now() - verifyStartTime;

  await prisma.repairJob.update({
    where: { id: repair.id },
    data: {
      testsPassed: v.passed != null ? v.passed : repair.testsPassed,
      testsTotal: v.total != null ? v.total : repair.testsTotal,
      status: isPassed ? "verified" : repair.status,
    },
  });

  await prisma.activityEvent.create({
    data: {
      id: randomUUID(),
      repairId: repair.id,
      event: isPassed ? "verification.passed" : "verification.failed",
      status: isPassed ? "success" : "error",
      message: `On-demand verification: ${v.passed || 0}/${v.total || 0} passed. Status: ${v.status}.`,
    },
  });

  await recordRepairEvent({
    repairId: repair.id,
    eventType: REPAIR_EVENT_TYPES.VERIFICATION_COMPLETED,
    status: isPassed ? "success" : "warning",
    message: `Verification completed: ${v.passed || 0}/${v.total || 0} passed. Status: ${v.status} (${(verifyDurationMs / 1000).toFixed(1)}s).`,
    metadata: {
      passed: v.passed,
      total: v.total,
      failed: v.failed,
      status: v.status,
      regressionDetected: Boolean(v.regression_detected),
      durationMs: verifyDurationMs,
    },
    durationMs: verifyDurationMs,
  });

  if (isPassed) {
    await recordRepairEvent({
      repairId: repair.id,
      eventType: REPAIR_EVENT_TYPES.REPAIR_VERIFIED,
      status: "success",
      message: `Repair VERIFIED: ${v.passed}/${v.total} tests passing.`,
      metadata: { passed: v.passed, total: v.total },
      durationMs: verifyDurationMs,
    });
  }

  res.json(v);
});

/**
 * GET /api/repairs/:repairId/report
 * Exportable repair report in Markdown or JSON format (Milestone 10)
 */
router.get("/repairs/:repairId/report", async (req, res) => {
  const parsed = GetRepairParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message, code: "INVALID_IDENTIFIER" });
    return;
  }

  const repair = await prisma.repairJob.findUnique({
    where: { id: parsed.data.repairId },
    include: {
      project: true,
      patches: { orderBy: { createdAt: "desc" } },
      attempts: { orderBy: { attemptNumber: "asc" } },
      organization: true,
    },
  });

  if (!(await assertRepairAccess(repair, req, res, "repair:view"))) return;

  const format = String(req.query.format || "markdown").toLowerCase();
  const repairObj = {
    ...toRepair(repair),
    patches: repair.patches.map((p) => ({
      ...p,
      filesChanged: safeJsonParse(p.filesChanged),
    })),
  };

  if (format === "json") {
    res.json(ReportGenerator.generateJson(repairObj, repair.project));
  } else {
    const md = ReportGenerator.generateMarkdown(repairObj, repair.project);
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.send(md);
  }
});

/**
 * GET /api/repairs/:repairId/plan
 * Intelligent repair decision & plan preview (Milestone 10)
 */
router.get("/repairs/:repairId/plan", async (req, res) => {
  const parsed = GetRepairParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message, code: "INVALID_IDENTIFIER" });
    return;
  }

  const repair = await prisma.repairJob.findUnique({
    where: { id: parsed.data.repairId },
    include: { project: true },
  });

  if (!(await assertRepairAccess(repair, req, res, "repair:view"))) return;

  if (repair.repairPlan) {
    res.json(safeJsonParse(repair.repairPlan));
    return;
  }

  const plan = await RepairPlannerService.createPlan({
    issue: repair.issue,
    analysis: safeJsonParse(repair.analysis),
    failures: safeJsonParse(repair.failures) || [],
    language: repair.language || "Python",
    framework: repair.testFramework || repair.framework || "pytest",
    organizationId: repair.organizationId,
  });

  res.json(plan);
});

/**
 * GET /api/repairs/:repairId/memory
 * Advisory similar historical repairs (Milestone 10)
 */
router.get("/repairs/:repairId/memory", async (req, res) => {
  const parsed = GetRepairParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message, code: "INVALID_IDENTIFIER" });
    return;
  }

  const repair = await prisma.repairJob.findUnique({
    where: { id: parsed.data.repairId },
    include: { project: true },
  });

  if (!(await assertRepairAccess(repair, req, res, "repair:view"))) return;

  const similar = await RepairMemoryService.findSimilarRepairs({
    language: repair.language,
    failureCategory: repair.failureCategory,
    organizationId: repair.organizationId,
    limit: 5,
  });

  res.json({
    similarRepairs: similar,
    count: similar.length,
    advisoryNotice: "Repair memory is advisory. Patches must pass empirical test verification.",
  });
});

export default router;


