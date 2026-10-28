#!/usr/bin/env node
/**
 * FixForge Explicit Database Provisioning & Demo Seeding CLI
 * 
 * Safely seeds demo organizations, users, and fixtures only when explicitly executed.
 * Prohibited from running automatically inside API request paths.
 */

import { seedDatabase, prisma } from "@workspace/db";

async function main() {
  const isProduction =
    process.env.NODE_ENV === "production" ||
    process.env.FIXFORGE_ENV === "production";

  if (isProduction && !process.argv.includes("--force")) {
    console.error("ERROR: Refusing to seed demo data in production environment without --force flag.");
    process.exit(1);
  }

  console.log("Starting explicit database provisioning...");
  const startTime = Date.now();

  try {
    await seedDatabase();
    const duration = Date.now() - startTime;

    const [orgCount, userCount, projectCount, repairCount] = await Promise.all([
      prisma.organization.count(),
      prisma.user.count(),
      prisma.project.count(),
      prisma.repairJob.count(),
    ]);

    console.log(`Database provisioning completed successfully in ${duration}ms:`);
    console.log(`- Organizations: ${orgCount}`);
    console.log(`- Users:         ${userCount}`);
    console.log(`- Projects:      ${projectCount}`);
    console.log(`- Repair Jobs:   ${repairCount}`);
  } catch (err) {
    console.error("Database provisioning failed:", err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
