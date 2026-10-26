import { Router } from "express";
import { HealthCheckResponse, GetServicesHealthResponse } from "@workspace/api-zod";
import { performance } from "node:perf_hooks";
import { prisma } from "@workspace/db";
import { getAiServiceHeaders } from "../services/ai-client.js";

const router = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/services/health", async (_req, res) => {
  const aiServiceUrl = process.env.AI_SERVICE_URL ?? "http://localhost:8000";
  const aiStart = performance.now();
  let aiStatus = "offline";
  let aiDetail = "AI service is not reachable";
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 800);
    const response = await fetch(`${aiServiceUrl}/healthz`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (response.ok) {
      aiStatus = "operational";
      aiDetail = "FastAPI agent service is responding";
    }
  } catch {
    aiStatus = "offline";
  }

  let dbStatus = "operational";
  let dbDetail = "Local SQLite database connected via Prisma";
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    dbStatus = "offline";
    dbDetail = "Database connection failed";
  }

  const overallStatus =
    aiStatus === "operational" && dbStatus === "operational" ? "operational" : "degraded";

  const data = GetServicesHealthResponse.parse({
    status: overallStatus,
    checkedAt: new Date(),
    services: [
      {
        name: "Node API",
        status: "operational",
        latencyMs: 1,
        detail: "Express API is responding",
      },
      {
        name: "SQLite",
        status: dbStatus,
        latencyMs: 1,
        detail: dbDetail,
      },
      {
        name: "AI Agent",
        status: aiStatus,
        latencyMs: Math.round(performance.now() - aiStart),
        detail: aiDetail,
      },
    ],
  });
  res.json(data);
});

router.get("/sandbox/health", async (_req, res) => {
  const aiServiceUrl = process.env.AI_SERVICE_URL ?? "http://localhost:8000";
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    const resp = await fetch(`${aiServiceUrl}/sandbox/health`, {
      headers: getAiServiceHeaders(),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) {
      res.status(resp.status).json({ docker_available: false, detail: "Sandbox health check failed" });
      return;
    }
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    const safeMsg = (err.message || "Connection failed").replace(/(postgres|mysql|sqlite|mongodb)(\+srv)?:\/\/[^\s]+/gi, "[REDACTED_URI]");
    res.status(503).json({ docker_available: false, runner: "docker", detail: `Sandbox offline: ${safeMsg}` });
  }
});

/**
 * GET /api/readyz
 * Production readiness probe validating Database, AI Agent, and Sandbox Runner.
 */
router.get("/readyz", async (_req, res) => {
  const checks = {
    api: "ready",
    database: "offline",
    aiAgent: "offline",
    dockerSandbox: "offline",
  };

  let isReady = true;
  const issues = [];

  // 1. Database check
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = "ready";
  } catch {
    checks.database = "unavailable";
    isReady = false;
    issues.push("Database connection unavailable");
  }

  // 2. AI Agent service check
  const aiServiceUrl = process.env.AI_SERVICE_URL ?? "http://localhost:8000";
  try {
    const resp = await fetch(`${aiServiceUrl}/healthz`, {
      signal: AbortSignal.timeout(1000),
    });
    if (resp.ok) {
      checks.aiAgent = "ready";
    } else {
      checks.aiAgent = "degraded";
      isReady = false;
      issues.push("AI Agent service returned unhealthy status");
    }
  } catch {
    checks.aiAgent = "unreachable";
    isReady = false;
    issues.push("AI Agent service unreachable");
  }

  // 3. Docker sandbox runner check
  try {
    const sandboxResp = await fetch(`${aiServiceUrl}/sandbox/health`, {
      headers: getAiServiceHeaders(),
      signal: AbortSignal.timeout(1200),
    });
    if (sandboxResp.ok) {
      const sandboxData = await sandboxResp.json();
      if (sandboxData.docker_available) {
        checks.dockerSandbox = "ready";
      } else {
        checks.dockerSandbox = "degraded";
        const isProd =
          process.env.NODE_ENV === "production" || process.env.FIXFORGE_ENV === "production";
        if (isProd) {
          isReady = false;
          issues.push("Docker sandbox engine unavailable in production");
        }
      }
    }
  } catch {
    checks.dockerSandbox = "unknown";
  }

  const statusCode = isReady ? 200 : 503;
  res.status(statusCode).json({
    status: isReady ? "ready" : "not_ready",
    timestamp: new Date().toISOString(),
    checks,
    ...(issues.length > 0 ? { issues } : {}),
  });
});

export default router;

