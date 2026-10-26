import { PrismaClient } from "@prisma/client";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const prismaDir = path.resolve(currentDir, "../prisma");
const workspaceRoot = path.resolve(currentDir, "../../..");
const defaultDevDbPath = path.resolve(workspaceRoot, "database/dev.db");

/**
 * Resolves the active database URL, honoring an explicit DATABASE_URL
 * and falling back to database/dev.db only when unconfigured in development.
 * Staging and production environments are strictly prohibited from falling back
 * or targeting the development database.
 */
export function resolveDatabaseUrl(configuredUrl = process.env.DATABASE_URL, env = process.env) {
  const trimmed = (configuredUrl || "").trim();
  const normalizedDevPath = defaultDevDbPath.replace(/\\/g, "/");
  const isDefaultDev =
    !trimmed ||
    trimmed === `file:${normalizedDevPath}` ||
    trimmed === `file://${normalizedDevPath}` ||
    trimmed === "file:../../../database/dev.db" ||
    trimmed === "file:../../database/dev.db" ||
    trimmed === "file:./database/dev.db" ||
    trimmed === "file:database/dev.db" ||
    trimmed.endsWith("/database/dev.db");

  const nodeEnv = (env?.NODE_ENV || "").trim().toLowerCase();
  const fixforgeEnv = (env?.FIXFORGE_ENV || "").trim().toLowerCase();
  const isStagingOrProd =
    nodeEnv === "staging" ||
    nodeEnv === "production" ||
    fixforgeEnv === "staging" ||
    fixforgeEnv === "production";
  const activeEnv = nodeEnv || fixforgeEnv || "development";

  if (isStagingOrProd) {
    if (!trimmed) {
      throw new Error(
        `DATABASE_URL must be explicitly configured in ${activeEnv} mode. Cannot fall back to development database.`
      );
    }
    if (isDefaultDev) {
      throw new Error(
        `Invalid DATABASE_URL in ${activeEnv} mode: '${trimmed}'. Staging and production environments cannot target the development database (database/dev.db).`
      );
    }
  }

  if (!isDefaultDev) {
    return {
      url: trimmed,
      isExplicit: true,
    };
  }
  return {
    url: trimmed || `file:${normalizedDevPath}`,
    isExplicit: false,
  };
}

const { url: databaseUrl, isExplicit: isExplicitDatabaseUrl } = resolveDatabaseUrl(process.env.DATABASE_URL);

// Ensure the target directory exists for SQLite file: URLs
if (databaseUrl.startsWith("file:")) {
  let dbFilePath = databaseUrl.slice(5).split("?")[0];
  if (dbFilePath.startsWith("//")) {
    dbFilePath = dbFilePath.slice(2);
  }
  // Windows file:/C:/path handling
  if (/^\/[a-zA-Z]:/.test(dbFilePath)) {
    dbFilePath = dbFilePath.slice(1);
  }
  const resolvedTarget = path.isAbsolute(dbFilePath)
    ? dbFilePath
    : path.resolve(prismaDir, dbFilePath);
  try {
    mkdirSync(path.dirname(resolvedTarget), { recursive: true });
  } catch {}
}

// Preserve the active database URL in process.env.DATABASE_URL
process.env.DATABASE_URL = databaseUrl;

export const prisma = new PrismaClient({
  datasources: {
    db: {
      url: databaseUrl,
    },
  },
});

export const db = prisma;
export { databaseUrl, isExplicitDatabaseUrl };

export const DEMO_ORGS = {
  FIXFORGE_LABS: {
    id: "org-fixforge-labs-001",
    name: "FixForge Labs",
    slug: "fixforge-labs",
  },
  ACME_CORP: {
    id: "org-acme-corp-002",
    name: "Acme Corporation",
    slug: "acme-corp",
  },
};

export const DEMO_USERS = {
  ADMIN: {
    id: "user-admin-001",
    email: "admin@fixforge.local",
    passwordHash: "$2b$10$ve3sH0mgws5v4DT1KRCfaOmDg91yVKF45/ptPJVRDRTLC5UdbJbVO", // DemoAdmin123!
    name: "Admin User",
    role: "ADMIN",
    orgId: "org-fixforge-labs-001",
  },
  MANAGER: {
    id: "user-manager-002",
    email: "manager@fixforge.local",
    passwordHash: "$2b$10$WL2SAyEoh9OvnyT1ilN9/uqd9rqYrU/KgCG504U0Ls6bB9CEXasc2", // DemoManager123!
    name: "Manager User",
    role: "MANAGER",
    orgId: "org-fixforge-labs-001",
  },
  DEVELOPER: {
    id: "user-dev-003",
    email: "developer@fixforge.local",
    passwordHash: "$2b$10$cRa3eoOJYDaAxStVFTLZ9OAr1jD6lfSTpSgVCdQMWsBPOaP7EoDDK", // DemoDeveloper123!
    name: "Developer User",
    role: "DEVELOPER",
    orgId: "org-fixforge-labs-001",
  },
  VIEWER: {
    id: "user-viewer-004",
    email: "viewer@fixforge.local",
    passwordHash: "$2b$10$5Z1LyElU2q5R.mYjXQ2cp.Au3TLVjaAYCA8YWNR07RXP.bY84sg0C", // DemoViewer123!
    name: "Viewer User",
    role: "VIEWER",
    orgId: "org-fixforge-labs-001",
  },
  ACME_DEV: {
    id: "user-acme-dev-005",
    email: "acme-dev@acme.local",
    passwordHash: "$2b$10$YM1xCPagF9QbN9yq9cS6lO.Pivl1UhNyUGopkg.ZDR2SrBgEDc56a", // AcmeDev123!
    name: "Acme Developer",
    role: "DEVELOPER",
    orgId: "org-acme-corp-002",
  },
};

export async function seedDatabase() {
  // 1. Seed Organizations
  for (const org of Object.values(DEMO_ORGS)) {
    await prisma.organization.upsert({
      where: { id: org.id },
      update: { name: org.name, slug: org.slug },
      create: { id: org.id, name: org.name, slug: org.slug },
    });
  }

  // 2. Seed Default Approval Policies
  for (const org of Object.values(DEMO_ORGS)) {
    const existingPolicy = await prisma.approvalPolicy.findFirst({
      where: { organizationId: org.id },
    });
    if (!existingPolicy) {
      await prisma.approvalPolicy.create({
        data: {
          organizationId: org.id,
          name: `${org.name} Default Policy`,
          requireHumanApproval: true,
          requireVerifiedRepair: true,
          allowGitHubPR: true,
          allowPush: true,
        },
      });
    }
  }

  // 3. Seed Demo Users & Memberships
  for (const u of Object.values(DEMO_USERS)) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: {
        name: u.name,
        passwordHash: u.passwordHash,
        isActive: true,
      },
      create: {
        id: u.id,
        email: u.email,
        name: u.name,
        passwordHash: u.passwordHash,
        isActive: true,
      },
    });

    await prisma.organizationMember.upsert({
      where: {
        organizationId_userId: {
          organizationId: u.orgId,
          userId: u.id,
        },
      },
      update: { role: u.role },
      create: {
        organizationId: u.orgId,
        userId: u.id,
        role: u.role,
      },
    });
  }

  // 4. Update any existing demo projects using the dummy placeholder to point to the real local fixture
  await prisma.project.updateMany({
    where: {
      repository: "github.com/example/test",
    },
    data: {
      repository: "examples/buggy-python-project",
    },
  });

  // Steps 5 & 6 removed in Milestone 15.1: Do not silently assign null organizationId records to arbitrary tenants.
  // Unassigned records must be handled explicitly through audit migration scripts (scripts/audit-tenant-migration.js).

  // 7. Seed primary demo project if no projects exist
  const projectCount = await prisma.project.count();
  if (projectCount === 0) {
    const projectId = "e1a6f7e7-8d3e-4a5a-9f68-2f0c1a5d6e70";
    const repairId = "9f3c98ac-1e63-4c8c-9c3d-3f4dc20f51d1";

    await prisma.project.create({
      data: {
        id: projectId,
        organizationId: DEMO_ORGS.FIXFORGE_LABS.id,
        createdById: DEMO_USERS.ADMIN.id,
        name: "Buggy Python Demo",
        repository: "examples/buggy-python-project",
        language: "Python",
        testFramework: "pytest",
        status: "ready",
      },
    });

    await prisma.repairJob.create({
      data: {
        id: repairId,
        organizationId: DEMO_ORGS.FIXFORGE_LABS.id,
        createdById: DEMO_USERS.ADMIN.id,
        projectId,
        issue: "Fix the failing calculator edge-case tests",
        model: "OpenAI-compatible / default",
        verificationLevel: "standard",
        maxIterations: 5,
        status: "testing",
        iteration: 1,
        testsPassed: 7,
        testsTotal: 10,
      },
    });

    await prisma.activityEvent.create({
      data: {
        id: "c9c1e52e-5df6-4a75-9e3e-2a7ce5aa6fd8",
        repairId,
        event: "test.completed",
        status: "warning",
        message: "Baseline complete: 7 of 10 tests passing.",
      },
    });
  }

  // 8. Ensure secondary organization (Acme Corp) has an isolated project and repair for testing cross-org isolation
  const acmeProjId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
  const acmeRepairId = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

  try {
    await prisma.repairJob.deleteMany({ where: { id: "repair-acme-001" } });
    await prisma.project.deleteMany({ where: { id: "proj-acme-001" } });
  } catch {}

  await prisma.project.upsert({
    where: { id: acmeProjId },
    update: { organizationId: DEMO_ORGS.ACME_CORP.id },
    create: {
      id: acmeProjId,
      organizationId: DEMO_ORGS.ACME_CORP.id,
      createdById: DEMO_USERS.ACME_DEV.id,
      name: "Acme Proprietary Repo",
      repository: "examples/acme-project",
      language: "Python",
      testFramework: "pytest",
      status: "ready",
    },
  });

  await prisma.repairJob.upsert({
    where: { id: acmeRepairId },
    update: { organizationId: DEMO_ORGS.ACME_CORP.id },
    create: {
      id: acmeRepairId,
      organizationId: DEMO_ORGS.ACME_CORP.id,
      createdById: DEMO_USERS.ACME_DEV.id,
      projectId: acmeProjId,
      issue: "Acme internal repair task",
      model: "OpenAI-compatible / default",
      verificationLevel: "standard",
      maxIterations: 3,
      status: "queued",
      iteration: 0,
    },
  });
}
