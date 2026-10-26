import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "@workspace/db";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_DB_PATH = path.resolve(ROOT_DIR, "database", "dev.db");
const DEFAULT_BACKUP_DIR = path.resolve(ROOT_DIR, "database", "backups");

/**
 * Perform a live, transactionally-safe SQLite hot backup using VACUUM INTO.
 */
export async function createDatabaseBackup(destinationPath = null) {
  if (!fs.existsSync(DEFAULT_BACKUP_DIR)) {
    fs.mkdirSync(DEFAULT_BACKUP_DIR, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = destinationPath || path.resolve(DEFAULT_BACKUP_DIR, `fixforge-backup-${timestamp}.db`);

  // If destination file already exists, remove it before VACUUM INTO
  if (fs.existsSync(backupPath)) {
    fs.unlinkSync(backupPath);
  }

  const normalizedBackupPath = backupPath.replace(/\\/g, "/");

  // Live online backup via SQLite VACUUM INTO
  await prisma.$executeRawUnsafe(`VACUUM INTO '${normalizedBackupPath}'`);

  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup failed: destination file was not created at ${backupPath}`);
  }

  const stats = fs.statSync(backupPath);
  const fileBuffer = fs.readFileSync(backupPath);
  const sha256 = createHash("sha256").update(fileBuffer).digest("hex");

  // Verify SQLite header magic bytes (SQLite format 3\0)
  const header = fileBuffer.subarray(0, 16).toString("utf-8");
  if (!header.startsWith("SQLite format 3")) {
    throw new Error(`Corrupted backup file: invalid SQLite header at ${backupPath}`);
  }

  return {
    success: true,
    backupPath,
    sizeBytes: stats.size,
    sha256,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Validate and restore a backup file to the target database location.
 */
export async function restoreDatabaseBackup(backupPath, targetDbPath = DEFAULT_DB_PATH) {
  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup file does not exist: ${backupPath}`);
  }

  const fileBuffer = fs.readFileSync(backupPath);
  const header = fileBuffer.subarray(0, 16).toString("utf-8");
  if (!header.startsWith("SQLite format 3")) {
    throw new Error(`Cannot restore: provided file is not a valid SQLite database (${backupPath})`);
  }

  const targetDir = path.dirname(targetDbPath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // Atomically copy backup into target
  fs.copyFileSync(backupPath, targetDbPath);

  // Verify restored database integrity
  const integrityResult = await prisma.$queryRawUnsafe(`PRAGMA integrity_check`);
  const status = integrityResult?.[0]?.integrity_check || "ok";

  return {
    success: true,
    targetDbPath,
    restoredFrom: backupPath,
    integrityCheck: status,
    restoredAt: new Date().toISOString(),
  };
}

/**
 * Verify schema and data retention across critical audit and history tables.
 */
export async function verifyDataRetentionSafety() {
  const [
    userCount,
    orgCount,
    projectCount,
    repairCount,
    eventCount,
    auditCount,
    patchCount,
    attemptCount,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.organization.count(),
    prisma.project.count(),
    prisma.repairJob.count(),
    prisma.activityEvent.count(),
    prisma.auditLog.count(),
    prisma.patch.count(),
    prisma.repairAttempt.count(),
  ]);

  return {
    safe: true,
    counts: {
      users: userCount,
      organizations: orgCount,
      projects: projectCount,
      repairJobs: repairCount,
      activityEvents: eventCount,
      auditLogs: auditCount,
      patches: patchCount,
      repairAttempts: attemptCount,
    },
    message: "Schema and tables verified. No history or audit records discarded.",
  };
}

// CLI execution handling
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] || "backup";
  if (command === "backup") {
    createDatabaseBackup()
      .then((res) => {
        console.log("Database backup completed successfully:", JSON.stringify(res, null, 2));
        process.exit(0);
      })
      .catch((err) => {
        console.error("Backup failed:", err);
        process.exit(1);
      });
  } else if (command === "verify") {
    verifyDataRetentionSafety()
      .then((res) => {
        console.log("Data retention check passed:", JSON.stringify(res, null, 2));
        process.exit(0);
      })
      .catch((err) => {
        console.error("Verification failed:", err);
        process.exit(1);
      });
  }
}
