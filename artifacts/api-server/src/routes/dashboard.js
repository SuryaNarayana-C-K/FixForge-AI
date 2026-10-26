import { Router } from "express";
import {
  GetActivityQueryParams,
  GetActivityResponse,
  GetDashboardSummaryResponse,
} from "@workspace/api-zod";
import { prisma, seedDatabase } from "@workspace/db";

const router = Router();

router.get("/dashboard/summary", async (req, res) => {
  await seedDatabase();
  const isProduction =
    process.env.NODE_ENV === "production" ||
    process.env.FIXFORGE_ENV === "production" ||
    process.env.NODE_ENV === "staging" ||
    process.env.FIXFORGE_ENV === "staging";
  if ((isProduction || req.headers["x-anonymous"] === "true") && (!req.user || req.isAnonymous)) {
    res.status(401).json({ error: "Authentication required to access dashboard summary.", code: "UNAUTHORIZED" });
    return;
  }

  const orgId = req.user?.organizationId;
  const whereOrg = orgId ? { organizationId: orgId } : {};

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
  await seedDatabase();
  const isProduction =
    process.env.NODE_ENV === "production" ||
    process.env.FIXFORGE_ENV === "production" ||
    process.env.NODE_ENV === "staging" ||
    process.env.FIXFORGE_ENV === "staging";
  if ((isProduction || req.headers["x-anonymous"] === "true") && (!req.user || req.isAnonymous)) {
    res.status(401).json({ error: "Authentication required to access activity stream.", code: "UNAUTHORIZED" });
    return;
  }

  const parsed = GetActivityQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const orgId = req.user?.organizationId;
  const where = orgId ? { repairJob: { organizationId: orgId } } : {};

  const rows = await prisma.activityEvent.findMany({
    where,
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
