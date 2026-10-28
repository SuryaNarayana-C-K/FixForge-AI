import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDatabaseUrl } from "../src/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../../..");
const DEV_DB_PATH = path.resolve(ROOT_DIR, "database", "dev.db");

describe("lib/db Database Isolation & Configuration Regression Tests", () => {
  it("resolveDatabaseUrl: preserves explicit staging database URL", () => {
    const stagingUrl = "file:../../../database/staging.db";
    const resolved = resolveDatabaseUrl(stagingUrl);
    assert.strictEqual(resolved.url, stagingUrl);
    assert.strictEqual(resolved.isExplicit, true);
  });

  it("resolveDatabaseUrl: preserves explicit PostgreSQL production URL", () => {
    const prodUrl = "postgresql://fixforge_admin:TopSecret123@db.prod.internal:5432/fixforge_production";
    const resolved = resolveDatabaseUrl(prodUrl);
    assert.strictEqual(resolved.url, prodUrl);
    assert.strictEqual(resolved.isExplicit, true);
  });

  it("resolveDatabaseUrl: falls back to dev.db when unconfigured or empty", () => {
    const emptyResolved = resolveDatabaseUrl("");
    assert.strictEqual(emptyResolved.isExplicit, false);
    assert.ok(emptyResolved.url.endsWith("database/dev.db"));

    const nullResolved = resolveDatabaseUrl(null);
    assert.strictEqual(nullResolved.isExplicit, false);
    assert.ok(nullResolved.url.endsWith("database/dev.db"));
  });

  it("child process import: preserves explicit staging DATABASE_URL during module initialization", () => {
    const stagingDbPath = path.resolve(ROOT_DIR, "database", "staging-test-isolated.db");
    const stagingUrl = `file:${stagingDbPath.replace(/\\/g, "/")}`;

    const script = `
      import { databaseUrl, isExplicitDatabaseUrl } from './src/index.js';
      console.log(JSON.stringify({
        databaseUrl,
        isExplicitDatabaseUrl,
        envDatabaseUrl: process.env.DATABASE_URL
      }));
    `;

    const output = execSync(
      `node --input-type=module -e "${script.replace(/\n/g, " ")}"`,
      {
        cwd: path.resolve(__dirname, ".."),
        env: {
          ...process.env,
          DATABASE_URL: stagingUrl,
        },
        encoding: "utf-8",
      }
    );

    const parsed = JSON.parse(output.trim());
    assert.strictEqual(parsed.databaseUrl, stagingUrl);
    assert.strictEqual(parsed.isExplicitDatabaseUrl, true);
    assert.strictEqual(parsed.envDatabaseUrl, stagingUrl);
  });

  it("child process import: preserves explicit PostgreSQL production DATABASE_URL", () => {
    const prodUrl = "postgresql://prod_user:secret@10.0.0.5:5432/fixforge_db";

    const script = `
      import { databaseUrl, isExplicitDatabaseUrl } from './src/index.js';
      console.log(JSON.stringify({
        databaseUrl,
        isExplicitDatabaseUrl,
        envDatabaseUrl: process.env.DATABASE_URL
      }));
    `;

    const output = execSync(
      `node --input-type=module -e "${script.replace(/\n/g, " ")}"`,
      {
        cwd: path.resolve(__dirname, ".."),
        env: {
          ...process.env,
          DATABASE_URL: prodUrl,
        },
        encoding: "utf-8",
      }
    );

    const parsed = JSON.parse(output.trim());
    assert.strictEqual(parsed.databaseUrl, prodUrl);
    assert.strictEqual(parsed.isExplicitDatabaseUrl, true);
    assert.strictEqual(parsed.envDatabaseUrl, prodUrl);
  });

  it("child process import: uses development dev.db fallback when DATABASE_URL is unset", () => {
    const script = `
      delete process.env.DATABASE_URL;
      import('./src/index.js').then(mod => {
        console.log(JSON.stringify({
          databaseUrl: mod.databaseUrl,
          isExplicitDatabaseUrl: mod.isExplicitDatabaseUrl,
          envDatabaseUrl: process.env.DATABASE_URL
        }));
      });
    `;

    const output = execSync(
      `node --input-type=module -e "${script.replace(/\n/g, " ")}"`,
      {
        cwd: path.resolve(__dirname, ".."),
        env: {
          ...process.env,
          DATABASE_URL: "",
        },
        encoding: "utf-8",
      }
    );

    const parsed = JSON.parse(output.trim());
    assert.strictEqual(parsed.isExplicitDatabaseUrl, false);
    assert.ok(parsed.databaseUrl.endsWith("database/dev.db"));
    assert.ok(parsed.envDatabaseUrl.endsWith("database/dev.db"));
  });

  it("resolveDatabaseUrl: throws error in staging mode when DATABASE_URL is unconfigured", () => {
    assert.throws(
      () => resolveDatabaseUrl("", { NODE_ENV: "staging" }),
      /DATABASE_URL must be explicitly configured in staging mode/
    );
    assert.throws(
      () => resolveDatabaseUrl(null, { FIXFORGE_ENV: "staging" }),
      /DATABASE_URL must be explicitly configured in staging mode/
    );
  });

  it("resolveDatabaseUrl: throws error in staging mode when DATABASE_URL targets dev.db", () => {
    assert.throws(
      () => resolveDatabaseUrl("file:../../../database/dev.db", { NODE_ENV: "staging" }),
      /cannot target the development database/
    );
  });

  it("resolveDatabaseUrl: throws error in production mode when DATABASE_URL is unconfigured", () => {
    assert.throws(
      () => resolveDatabaseUrl("", { NODE_ENV: "production" }),
      /DATABASE_URL must be explicitly configured in production mode/
    );
  });

  it("resolveDatabaseUrl: throws error in production mode when DATABASE_URL targets dev.db", () => {
    assert.throws(
      () => resolveDatabaseUrl("file:../../../database/dev.db", { NODE_ENV: "production" }),
      /cannot target the development database/
    );
  });

  it("child process import: fails fast in staging mode when DATABASE_URL is unset", () => {
    const script = `import('./src/index.js');`;
    assert.throws(() => {
      execSync(`node --input-type=module -e "${script}"`, {
        cwd: path.resolve(__dirname, ".."),
        env: {
          ...process.env,
          NODE_ENV: "staging",
          DATABASE_URL: "",
        },
        encoding: "utf-8",
        stdio: "pipe",
      });
    });
  });

  it("child process import: fails fast in staging mode when DATABASE_URL targets dev.db", () => {
    const script = `import('./src/index.js');`;
    assert.throws(() => {
      execSync(`node --input-type=module -e "${script}"`, {
        cwd: path.resolve(__dirname, ".."),
        env: {
          ...process.env,
          NODE_ENV: "staging",
          DATABASE_URL: "file:../../../database/dev.db",
        },
        encoding: "utf-8",
        stdio: "pipe",
      });
    });
  });

  it("staging initialization does not create or modify database/dev.db", () => {
    const stagingDbFile = path.resolve(ROOT_DIR, "database", "staging-safety-test.db");
    const stagingUrl = `file:${stagingDbFile.replace(/\\/g, "/")}`;

    let devDbMtimeBefore = null;
    if (fs.existsSync(DEV_DB_PATH)) {
      devDbMtimeBefore = fs.statSync(DEV_DB_PATH).mtimeMs;
    }

    const script = `
      import { databaseUrl } from './src/index.js';
      console.log(databaseUrl);
    `;

    execSync(
      `node --input-type=module -e "${script.replace(/\n/g, " ")}"`,
      {
        cwd: path.resolve(__dirname, ".."),
        env: {
          ...process.env,
          NODE_ENV: "staging",
          DATABASE_URL: stagingUrl,
        },
        encoding: "utf-8",
      }
    );

    if (devDbMtimeBefore !== null) {
      const devDbMtimeAfter = fs.statSync(DEV_DB_PATH).mtimeMs;
      assert.strictEqual(devDbMtimeAfter, devDbMtimeBefore, "dev.db should not be touched by staging");
    }

    // Clean up temporary test file if created
    if (fs.existsSync(stagingDbFile)) {
      fs.unlinkSync(stagingDbFile);
    }
  });

  it("protection against unintended writes: staging initialization leaves dev.db untouched", () => {
    const stagingDbFile = path.resolve(ROOT_DIR, "database", "staging-safety-write-test.db");
    const stagingUrl = `file:${stagingDbFile.replace(/\\/g, "/")}`;

    let devDbMtimeBefore = null;
    let devDbSizeBefore = null;
    if (fs.existsSync(DEV_DB_PATH)) {
      const stat = fs.statSync(DEV_DB_PATH);
      devDbMtimeBefore = stat.mtimeMs;
      devDbSizeBefore = stat.size;
    }

    const script = `
      import { databaseUrl } from './src/index.js';
      console.log('ACTIVE_DB:', databaseUrl);
    `;

    execSync(
      `node --input-type=module -e "${script.replace(/\n/g, " ")}"`,
      {
        cwd: path.resolve(__dirname, ".."),
        env: {
          ...process.env,
          NODE_ENV: "staging",
          DATABASE_URL: stagingUrl,
        },
        encoding: "utf-8",
      }
    );

    if (devDbMtimeBefore !== null) {
      const statAfter = fs.statSync(DEV_DB_PATH);
      assert.strictEqual(statAfter.mtimeMs, devDbMtimeBefore, "dev.db mtime must remain unchanged");
      assert.strictEqual(statAfter.size, devDbSizeBefore, "dev.db size must remain unchanged");
    }

    if (fs.existsSync(stagingDbFile)) {
      fs.unlinkSync(stagingDbFile);
    }
  });
});
