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
app.use(cors({ origin: true, credentials: true }));
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
