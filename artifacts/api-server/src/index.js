import app from "./app.js";
import { logger } from "./lib/logger.js";
import { seedDatabase } from "@workspace/db";
import { jobLifecycleService } from "./services/lifecycle/job-lifecycle-service.js";

import { enforceStartupConfig } from "./lib/config.js";

// Validate environment and fail fast on invalid production configuration
enforceStartupConfig();

const rawPort = process.env.PORT ?? "5000";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Demo seeding is an explicit, opt-in provisioning command (npm run db:seed).
// Startup seeding only executes when explicitly requested via SEED_ON_STARTUP=true in non-production.
if (process.env.SEED_ON_STARTUP === "true" && process.env.NODE_ENV !== "production") {
  seedDatabase().catch((err) => {
    logger.error({ err }, "Failed to seed database on startup");
  });
}

// Reconcile interrupted jobs and orphaned containers on startup
jobLifecycleService.reconcileInterruptedJobs().then((res) => {
  if (res.recoveredCount > 0) {
    logger.info({ recoveredCount: res.recoveredCount, recoveredIds: res.recoveredIds }, "Recovered interrupted jobs on startup");
  }
}).catch((err) => {
  logger.error({ err }, "Failed to reconcile interrupted jobs on startup");
});

app.listen(port, () => {
  logger.info({ port }, "Server listening");
});
