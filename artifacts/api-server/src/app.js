import express from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";

import cookieParser from "cookie-parser";
import { securityHeaders, validateInput } from "./middlewares/security.js";
import { authenticate } from "./middlewares/auth.js";

const app = express();

app.use(securityHeaders);
app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
export function getStrictCorsOptions() {
  const parseAllowedOrigins = () => {
    const configured = (process.env.ALLOWED_ORIGINS || process.env.CORS_ORIGIN || "").trim();
    if (configured) {
      return configured.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    }
    const isProd =
      process.env.NODE_ENV === "production" ||
      process.env.FIXFORGE_ENV === "production" ||
      process.env.NODE_ENV === "staging" ||
      process.env.FIXFORGE_ENV === "staging";
    if (isProd) {
      return [];
    }
    return [
      "http://localhost:3000",
      "http://localhost:5173",
      "http://127.0.0.1:3000",
      "http://127.0.0.1:5173",
      "http://localhost:8080",
      "http://127.0.0.1:8080",
    ];
  };

  return {
    origin(origin, callback) {
      // Allow non-browser requests without Origin header (curl, mobile apps, server-to-server)
      if (!origin) {
        return callback(null, true);
      }
      const allowed = parseAllowedOrigins();
      const normalizedOrigin = origin.trim().toLowerCase();
      if (allowed.includes(normalizedOrigin)) {
        return callback(null, true);
      }
      // Strictly deny unauthorized origins: callback(null, false) prevents Access-Control-Allow-Origin header
      return callback(null, false);
    },
    credentials: true,
  };
}

app.use(cors(getStrictCorsOptions()));
app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(authenticate);
app.use(validateInput);

app.use("/api", router);

app.use((err, req, res, _next) => {
  logger.error({ err }, "Unhandled error in request");
  
  // Sanitize message to avoid exposing filesystem paths, tokens, or credentials
  let safeMessage = "An internal server error occurred.";
  if (process.env.NODE_ENV !== "production" && err.message) {
    // Strip filesystem paths or potential tokens
    safeMessage = err.message.replace(/([A-Za-z]:\\[^:\s]+|\/[a-zA-Z0-9_\-\.\/]+)/g, "[REDACTED_PATH]");
  }

  res.status(err.status || 500).json({
    error: {
      code: err.code || "INTERNAL_ERROR",
      message: safeMessage,
    },
  });
});

export default app;
