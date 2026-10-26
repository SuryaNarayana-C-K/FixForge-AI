import { recordAuditLog } from "../services/security/audit-service.js";

const rateLimitBuckets = new Map();

export function resetRateLimits() {
  rateLimitBuckets.clear();
}

/**
 * Creates an in-memory rate limiter middleware.
 * @param {Object} options
 * @param {number} options.windowMs - Time frame in milliseconds
 * @param {number} options.max - Max requests per window
 * @param {string} options.name - Bucket name (e.g., 'login', 'repair', 'github')
 */
export function rateLimiter({ windowMs = 60000, max = 30, name = "default" } = {}) {
  return async (req, res, next) => {
    // Skip internal health endpoints
    if (
      req.path === "/healthz" ||
      req.path === "/services/health" ||
      req.path === "/sandbox/health"
    ) {
      return next();
    }

    const ip = req.ip || req.connection?.remoteAddress || "127.0.0.1";
    const key = `${name}:${req.user?.id || ip}`;
    const now = Date.now();

    let entry = rateLimitBuckets.get(key);
    if (!entry || now > entry.resetTime) {
      entry = { count: 1, resetTime: now + windowMs };
      rateLimitBuckets.set(key, entry);
      return next();
    }

    entry.count += 1;
    if (entry.count > max) {
      const retryAfterSeconds = Math.ceil((entry.resetTime - now) / 1000);
      res.setHeader("Retry-After", retryAfterSeconds);

      await recordAuditLog({
        organizationId: req.user?.organizationId || null,
        userId: req.user?.id || null,
        action: "RATE_LIMIT_TRIGGERED",
        resourceType: "RATE_LIMITER",
        resourceId: name,
        metadata: {
          key,
          ip,
          max,
          count: entry.count,
          endpoint: req.originalUrl,
        },
      });

      res.status(429).json({
        error: "Too many requests. Please slow down and try again later.",
        code: "RATE_LIMIT_EXCEEDED",
        retryAfter: retryAfterSeconds,
      });
      return;
    }

    next();
  };
}

export function securityHeaders(_req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' *",
  );

  if (process.env.NODE_ENV === "production") {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains; preload",
    );
  }

  next();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHELL_METACHARS_REGEX = /[;&|`$<>]/;
const PATH_TRAVERSAL_REGEX = /(?:\.\.[/\\]|[/\\]\.\.)/;

export function validateInput(req, res, next) {
  // Validate route UUID parameters if any
  for (const [param, val] of Object.entries(req.params)) {
    if (param.toLowerCase().endsWith("id") && val && !UUID_REGEX.test(val)) {
      // Allow legacy demo IDs like 'demo' or check uuid
      if (!val.startsWith("demo") && !val.startsWith("org-") && !val.startsWith("user-") && !val.startsWith("proj-") && !val.startsWith("repair-")) {
        res.status(400).json({
          error: `Malformed identifier parameter: ${param}. Must be a valid UUID.`,
          code: "INVALID_IDENTIFIER",
        });
        return;
      }
    }
  }

  // Validate request body
  if (req.body && typeof req.body === "object") {
    for (const [key, val] of Object.entries(req.body)) {
      if (typeof val === "string") {
        if (val.length > 50000) {
          res.status(400).json({
            error: `Input field '${key}' exceeds maximum permitted length.`,
            code: "PAYLOAD_TOO_LARGE",
          });
          return;
        }

        // Check path traversal in repositories, filenames, or commands
        if ((key === "repository" || key === "name" || key === "file" || key === "command") && PATH_TRAVERSAL_REGEX.test(val)) {
          res.status(400).json({
            error: `Security violation: Path traversal detected in '${key}'.`,
            code: "PATH_TRAVERSAL_DETECTED",
          });
          return;
        }

        // Check dangerous shell metacharacters in commands, names, or repositories
        if ((key === "name" || key === "repository" || key === "command") && SHELL_METACHARS_REGEX.test(val)) {
          res.status(400).json({
            error: `Security violation: Forbidden characters detected in '${key}'.`,
            code: "INJECTION_ATTEMPT_DETECTED",
          });
          return;
        }
      }
    }
  }

  next();
}
