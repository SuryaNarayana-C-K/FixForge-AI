import pino from "pino";

const isProduction =
  process.env.NODE_ENV === "production" || process.env.FIXFORGE_ENV === "production";

export const REDACTED_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers['set-cookie']",
  "token",
  "*.token",
  "*.*.token",
  "password",
  "*.password",
  "*.*.password",
  "secret",
  "*.secret",
  "*.*.secret",
  "apiKey",
  "*.apiKey",
  "*.*.apiKey",
  "api_key",
  "*.api_key",
  "githubToken",
  "*.githubToken",
  "ghToken",
  "*.ghToken",
  "DATABASE_URL",
  "connectionString",
  "*.connectionString",
  "INTERNAL_SERVICE_KEY",
  "req.headers['x-service-key']",
  "x-service-key",
];

/**
 * Redact sensitive substrings (API keys, GitHub tokens, Bearer tokens, service keys) from raw strings.
 */
export function sanitizeLogText(text) {
  if (typeof text !== "string") return text;
  let sanitized = text
    .replace(/AIza[0-9A-Za-z_-]{30,40}/g, "[REDACTED_API_KEY]")
    .replace(/ghp_[0-9A-Za-z]{30,40}/g, "[REDACTED_GH_TOKEN]")
    .replace(/github_pat_[0-9A-Za-z_]{70,90}/g, "[REDACTED_GH_TOKEN]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED_TOKEN]")
    .replace(/eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, "[REDACTED_JWT]")
    .replace(/(postgres|mysql|sqlite|mongodb)(\+srv)?:\/\/[^:]+:[^@]+@/gi, "$1://[REDACTED_USER]:[REDACTED_PWD]@")
    .replace(/X-Service-Key:\s*[A-Za-z0-9_-]+/gi, "X-Service-Key: [REDACTED_SERVICE_KEY]");

  if (process.env.INTERNAL_SERVICE_KEY && process.env.INTERNAL_SERVICE_KEY.length >= 16) {
    sanitized = sanitized.split(process.env.INTERNAL_SERVICE_KEY).join("[REDACTED_SERVICE_KEY]");
  }
  return sanitized;
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: REDACTED_PATHS,
    censor: "[REDACTED]",
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
