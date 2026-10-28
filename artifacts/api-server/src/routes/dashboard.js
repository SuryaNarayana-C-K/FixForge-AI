import { Router } from "express";
import {
  GetActivityQueryParams,
  GetActivityResponse,
  GetDashboardSummaryResponse,
} from "@workspace/api-zod";
import { prisma } from "@workspace/db";

const router = Router();

router.get("/dashboard/summary", async (req, res) => {
  if (!req.user || req.isAnonymous) {
    res.status(401).json({ error: "Authentication required to access dashboard summary.", code: "UNAUTHORIZED" });
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

  const whereOrg = { organizationId: orgId };

  const [activeRepairs, completedRepairs, failedRepairs, totalRepairs, verifiedRepairs] =
    await Promise.all([
      prisma.repairJob.count({
        where: {
          ...whereOrg,
          status: {
            in: [
              "queued",
              "analyzing",
              "patching",
              "testing",
              "self_correcting",
              "verifying",
            ],
          },
        },
      }),
      prisma.repairJob.count({
        where: { ...whereOrg, status: "verified" },
      }),
      prisma.repairJob.count({
        where: {
          ...whereOrg,
          status: {
            in: ["failed", "timeout", "cancelled"],
          },
        },
      }),
      prisma.repairJob.count({ where: whereOrg }),
      prisma.repairJob.aggregate({
        where: { ...whereOrg, status: "verified" },
        _avg: { iteration: true },
      }),
    ]);

  const successRate =
    totalRepairs === 0 ? 0 : Math.round((completedRepairs / totalRepairs) * 100);

  const response = {
    activeRepairs,
    completedRepairs,
    failedRepairs,
    successRate,
    averageIterations: Number(verifiedRepairs._avg.iteration ?? 0),
    averageRepairTimeSeconds: 0,
  };

  res.json(GetDashboardSummaryResponse.parse(response));
});

router.get("/activity", async (req, res) => {
  if (!req.user || req.isAnonymous) {
    res.status(401).json({ error: "Authentication required to access activity stream.", code: "UNAUTHORIZED" });
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

  const parsed = GetActivityQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const rows = await prisma.activityEvent.findMany({
    where: { repairJob: { organizationId: orgId } },
    orderBy: { createdAt: "desc" },
    take: parsed.data.limit,
  });

  res.json(
    GetActivityResponse.parse(
      rows.map((row) => ({
        id: row.id,
        event: row.event,
        status: row.status,
        message: row.message,
        repairId: row.repairId,
        createdAt:
          row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
      })),
    ),
  );
});

export default router;
