import { logger } from "./logger.js";

const DEFAULT_DEV_JWT_SECRET = "fixforge-dev-secret-key-change-in-prod";

/**
 * Validate environment and configuration at startup.
 * In production mode, insecure defaults and missing required settings fail fast.
 */
export function validateProductionConfig(env = process.env) {
  const nodeEnv = (env.NODE_ENV || "development").trim().toLowerCase();
  const fixforgeEnv = (env.FIXFORGE_ENV || nodeEnv).trim().toLowerCase();
  const isProduction = nodeEnv === "production" || fixforgeEnv === "production";
  const isStrictEnv =
    isProduction ||
    nodeEnv === "staging" ||
    fixforgeEnv === "staging";
  const envLabel = nodeEnv === "staging" || fixforgeEnv === "staging" ? "staging" : "production";

  const errors = [];
  const warnings = [];

  // 1. Port validation
  const port = Number(env.PORT ?? "5000");
  if (Number.isNaN(port) || port <= 0 || port > 65535) {
    errors.push(`Invalid PORT configuration: "${env.PORT}". Must be between 1 and 65535.`);
  }

  // 2. Secret & Token Validation
  const jwtSecret = env.JWT_SECRET;
  if (isStrictEnv) {
    if (!jwtSecret) {
      errors.push(`Missing required environment variable 'JWT_SECRET' in ${envLabel} mode.`);
    } else if (jwtSecret === DEFAULT_DEV_JWT_SECRET) {
      errors.push(`JWT_SECRET must not use the default development secret in ${envLabel} mode.`);
    } else if (jwtSecret.length < 32) {
      errors.push(`JWT_SECRET must be at least 32 characters long in ${envLabel} mode.`);
    }
  } else {
    if (!jwtSecret || jwtSecret === DEFAULT_DEV_JWT_SECRET) {
      warnings.push("Using default development JWT_SECRET. Do NOT use in production or staging.");
    }
  }

  // 3. Database URL
  if (isStrictEnv && !env.DATABASE_URL) {
    errors.push(`Missing required environment variable 'DATABASE_URL' in ${envLabel} mode.`);
  }

  // 4. Execution runner security
  if (isStrictEnv) {
    const allowLocal = (env.ALLOW_LOCAL_SUBPROCESS || "").trim().toLowerCase();
    if (allowLocal === "true" || allowLocal === "1" || allowLocal === "yes") {
      errors.push(
        `CRITICAL SECURITY VIOLATION: ALLOW_LOCAL_SUBPROCESS is set to 'true' in ${envLabel} mode. ` +
        `Host execution is strictly prohibited in ${envLabel}.`
      );
    }
  }

  // 5. Service-to-Service Internal Key Validation
  const internalKey = env.INTERNAL_SERVICE_KEY;
  const isStaging = nodeEnv === "staging" || fixforgeEnv === "staging";
  if (isStaging && !internalKey) {
    errors.push(`Missing required environment variable 'INTERNAL_SERVICE_KEY' in staging mode.`);
  } else if (internalKey && internalKey.length < 32) {
    errors.push(`INTERNAL_SERVICE_KEY must be at least 32 characters long in ${envLabel} mode.`);
  }

  return {
    isProduction: isStrictEnv,
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Enforce configuration at application boot.
 * Throws an Error with sanitized details if validation fails.
 */
export function enforceStartupConfig(env = process.env) {
  const result = validateProductionConfig(env);

  for (const warning of result.warnings) {
    logger.warn({ warning }, "Configuration warning");
  }

  if (!result.isValid) {
    for (const error of result.errors) {
      logger.error({ error }, "Configuration error");
    }
    throw new Error(
      `FixForge Startup Configuration Failed:\n - ${result.errors.join("\n - ")}`
    );
  }

  return result;
}
