import { Router } from "express";
import { randomUUID } from "node:crypto";
import {
  CreateProjectBody,
  CreateProjectResponse,
  GetProjectParams,
  GetProjectResponse,
  ListProjectsResponse,
} from "@workspace/api-zod";
import { prisma, seedDatabase, DEMO_ORGS } from "@workspace/db";
import { hasPermission } from "../middlewares/auth.js";
import { recordAuditLog } from "../services/security/audit-service.js";
import { parseGitHubRepo, resolveRepositoryWorkspace } from "../services/git/repository-resolver.js";

const router = Router();

const toProject = (p) => ({
  id: p.id,
  name: p.name,
  repository: p.repository,
  language: p.language,
  testFramework: p.testFramework ?? null,
  status: p.status,
  repairCount: p._count?.repairJobs ?? p.repairCount ?? 0,
  createdAt: p.createdAt instanceof Date ? p.createdAt.toISOString() : p.createdAt,
  updatedAt: p.updatedAt instanceof Date ? p.updatedAt.toISOString() : p.updatedAt,
});

router.get("/projects", async (req, res) => {
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

  const projects = await prisma.project.findMany({
    where: { organizationId: orgId },
    include: {
      _count: {
        select: { repairJobs: true },
      },
    },
    orderBy: { updatedAt: "desc" },
  });
  res.json(ListProjectsResponse.parse(projects.map(toProject)));
});

router.post("/projects", async (req, res) => {
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

  if (!hasPermission(req.user.role, "project:create")) {
    await recordAuditLog({
      organizationId: orgId,
      userId: req.user.id,
      action: "ACCESS_DENIED",
      resourceType: "Project",
      metadata: { reason: "Role not authorized to create project", role: req.user.role },
    });
    res.status(403).json({
      error: "Access denied: insufficient permissions to create project.",
      code: "ACCESS_DENIED",
    });
    return;
  }

  const parsed = CreateProjectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const id = randomUUID();
  const parsedRemote = parseGitHubRepo(parsed.data.repository);

  let resolvedWs;
  try {
    resolvedWs = await resolveRepositoryWorkspace(parsed.data.repository);
  } catch (err) {
    res.status(err.status || 400).json({
      error: `Invalid repository: ${err.message}`,
      code: err.code || "REPOSITORY_NOT_FOUND",
    });
    return;
  }

  const created = await prisma.project.create({
    data: {
      id,
      organizationId: orgId,
      createdById: req.user.id,
      name: parsed.data.name,
      repository: resolvedWs.relativePath,
      language: parsed.data.language,
      testFramework: parsed.data.testFramework ?? null,
      status: "ready",
      githubOwner: parsedRemote?.owner ?? null,
      githubRepo: parsedRemote?.repo ?? null,
      defaultBranch: "main",
    },
    include: {
      _count: {
        select: { repairJobs: true },
      },
    },
  });

  await recordAuditLog({
    organizationId: orgId,
    userId: req.user.id,
    action: "PROJECT_CREATED",
    resourceType: "Project",
    resourceId: created.id,
    metadata: { name: created.name, repository: created.repository, language: created.language },
  });

  res.status(201).json(CreateProjectResponse.parse(toProject(created)));
});

router.get("/projects/:projectId", async (req, res) => {
  const parsed = GetProjectParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message, code: "INVALID_IDENTIFIER" });
    return;
  }

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

  const project = await prisma.project.findUnique({
    where: { id: parsed.data.projectId },
    include: {
      _count: {
        select: { repairJobs: true },
      },
    },
  });

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  // IDOR check: Enforce organization isolation (fail closed if project org is null or mismatched)
  if (!project.organizationId || project.organizationId !== orgId) {
    await recordAuditLog({
      organizationId: orgId,
      userId: req.user.id,
      action: "ACCESS_DENIED",
      resourceType: "Project",
      resourceId: project.id,
      metadata: { reason: "Cross-organization project access attempt" },
    });
    res.status(403).json({
      error: "Access denied: project belongs to another organization.",
      code: "ACCESS_DENIED",
    });
    return;
  }

  res.json(GetProjectResponse.parse(toProject(project)));
});

export default router;
