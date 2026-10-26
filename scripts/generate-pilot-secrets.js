#!/usr/bin/env node
/**
 * FixForge Milestone 14: Secure Pilot Secret Generation Utility.
 *
 * Generates cryptographically secure 256-bit (64 hex char) secrets
 * and writes them directly into .env.pilot with restrictive permissions.
 *
 * CRITICAL SECURITY INVARIANT:
 * Secret values are NEVER printed to stdout, stderr, or log files.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const TARGET_ENV_PATH = path.join(ROOT_DIR, ".env.pilot");
const TEMPLATE_PATH = path.join(ROOT_DIR, ".env.pilot.example");

function generateSecureHex(bytes = 32) {
  return randomBytes(bytes).toString("hex");
}

function main() {
  const forceOverwrite = process.argv.includes("--force") || process.argv.includes("-f");

  if (fs.existsSync(TARGET_ENV_PATH) && !forceOverwrite) {
    console.error(
      "ERROR: .env.pilot already exists. To regenerate secrets, pass --force (WARNING: existing sessions will be invalidated)."
    );
    process.exit(1);
  }

  if (!fs.existsSync(TEMPLATE_PATH)) {
    console.error(`ERROR: Template file not found at ${TEMPLATE_PATH}`);
    process.exit(1);
  }

  const templateContent = fs.readFileSync(TEMPLATE_PATH, "utf-8");

  const jwtSecret = generateSecureHex(32);
  const sessionSecret = generateSecureHex(32);
  const serviceKey = generateSecureHex(32);
  const workerKey = generateSecureHex(32);

  let populated = templateContent
    .replace("REPLACE_WITH_GENERATED_64_CHAR_HEX_SECRET", jwtSecret)
    .replace("REPLACE_WITH_GENERATED_64_CHAR_HEX_SECRET", sessionSecret)
    .replace("REPLACE_WITH_GENERATED_64_CHAR_HEX_SECRET", serviceKey)
    .replace("REPLACE_WITH_GENERATED_64_CHAR_HEX_SECRET", workerKey);

  fs.writeFileSync(TARGET_ENV_PATH, populated, { mode: 0o600 });

  // Explicitly ensure 0600 file permissions on POSIX filesystems
  try {
    fs.chmodSync(TARGET_ENV_PATH, 0o600);
  } catch {
    // Windows file permissions are handled via NTFS ACLs
  }

  console.log("=================================================================");
  console.log("FixForge Pilot Security: Secrets Generated Successfully");
  console.log("=================================================================");
  console.log(`Target File:      ${TARGET_ENV_PATH}`);
  console.log(`Permissions:      chmod 600 (owner read/write only)`);
  console.log("Injected Keys:    JWT_SECRET, SESSION_SECRET, INTERNAL_SERVICE_KEY, INTERNAL_WORKER_KEY");
  console.log("Security Notice:  Secrets were written directly to disk and NEVER echoed to console.");
  console.log("Next Step:        Add your GEMINI_API_KEY to .env.pilot before running docker compose.");
  console.log("=================================================================");
}

main();
