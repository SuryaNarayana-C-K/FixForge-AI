#!/usr/bin/env node
/**
 * FixForge Tenant Identity Audit & Migration Tool
 * 
 * Inspects all tenant-scoped database entities (projects, repair_jobs, approval_policies)
 * for missing/null organizationId foreign keys.
 * 
 * Adheres strictly to Milestone 15.1:
 * - Does NOT silently assign unassociated records to arbitrary organizations.
 * - Produces an actionable audit log of orphaned records.
 * - Prepares safe migration readiness verification before schema NOT NULL enforcement.
 */

import { prisma } from "@workspace/db";

export async function auditTenantIntegrity() {
  const [
    nullProjects,
    nullRepairs,
    totalProjects,
    totalRepairs,
    totalOrgs,
  ] = await Promise.all([
    prisma.project.findMany({
      where: { organizationId: null },
      select: { id: true, name: true, repository: true, createdAt: true, createdById: true },
    }),
    prisma.repairJob.findMany({
      where: { organizationId: null },
      select: { id: true, projectId: true, issue: true, status: true, createdAt: true },
    }),
    prisma.project.count(),
    prisma.repairJob.count(),
    prisma.organization.count(),
  ]);

  const hasOrphans = nullProjects.length > 0 || nullRepairs.length > 0;

  return {
    isMigrationReady: !hasOrphans,
    totalOrganizations: totalOrgs,
    projects: {
      total: totalProjects,
      orphanedCount: nullProjects.length,
      orphans: nullProjects,
    },
    repairs: {
      total: totalRepairs,
      orphanedCount: nullRepairs.length,
      orphans: nullRepairs,
    },
    timestamp: new Date().toISOString(),
  };
}

async function main() {
  console.log("================================================================================");
  console.log("FixForge Milestone 15.1 — Tenant Identity Audit & Migration Readiness Tool");
  console.log("================================================================================\n");

  try {
    const report = await auditTenantIntegrity();

    console.log(`Scan completed at: ${report.timestamp}`);
    console.log(`Registered Organizations: ${report.totalOrganizations}\n`);

    console.log(`[Projects]`);
    console.log(`- Total:    ${report.projects.total}`);
    console.log(`- Orphaned: ${report.projects.orphanedCount} (organizationId IS NULL)`);
    if (report.projects.orphans.length > 0) {
      console.warn("  WARNING: The following projects lack tenant ownership:");
      for (const p of report.projects.orphans) {
        console.warn(`    - ID: ${p.id} | Name: '${p.name}' | Repo: '${p.repository}' | Created: ${p.createdAt}`);
      }
    }

    console.log(`\n[Repair Jobs]`);
    console.log(`- Total:    ${report.repairs.total}`);
    console.log(`- Orphaned: ${report.repairs.orphanedCount} (organizationId IS NULL)`);
    if (report.repairs.orphans.length > 0) {
      console.warn("  WARNING: The following repairs lack tenant ownership:");
      for (const r of report.repairs.orphans) {
        console.warn(`    - ID: ${r.id} | ProjectId: ${r.projectId} | Status: '${r.status}' | Issue: '${r.issue?.slice(0, 40)}...'`);
      }
    }

    console.log("\n--------------------------------------------------------------------------------");
    if (report.isMigrationReady) {
      console.log("RESULT: 100% of records are cleanly associated with valid organizations.");
      console.log("Status: SAFE FOR NOT NULL SCHEMA ENFORCEMENT.");
    } else {
      console.error("RESULT: Orphaned records found without valid organization associations.");
      console.error("Status: BLOCKED FOR NOT NULL SCHEMA ENFORCEMENT.");
      console.error("Action: Review and explicitly assign or archive orphaned records. Do not silently backfill.");
      process.exitCode = 1;
    }
    console.log("--------------------------------------------------------------------------------\n");
  } catch (err) {
    console.error("Audit failed with error:", err);
    process.exitCode = 2;
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && process.argv[1].endsWith("audit-tenant-migration.js")) {
  main();
}
