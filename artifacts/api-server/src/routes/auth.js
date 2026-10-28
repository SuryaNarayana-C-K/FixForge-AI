import { Router } from "express";
import {
  registerUser,
  loginUser,
  getUserById,
} from "../services/security/auth-service.js";
import { recordAuditLog } from "../services/security/audit-service.js";
import { rateLimiter } from "../middlewares/security.js";
import { requireAuth } from "../middlewares/auth.js";

const router = Router();

const loginLimiter = rateLimiter({ windowMs: 60000, max: 10, name: "auth_login" });
const registerLimiter = rateLimiter({ windowMs: 3600000, max: 20, name: "auth_register" });

/**
 * POST /api/auth/register
 */
router.post("/auth/register", registerLimiter, async (req, res) => {
  const { email, password, name, organizationName, organizationSlug } = req.body || {};

  try {
    const result = await registerUser({
      email,
      password,
      name,
      organizationName,
      organizationSlug,
    });

    // Set secure cookie
    res.cookie("fixforge_token", result.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    });

    res.status(201).json(result);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({
      error: err.message || "Failed to register user.",
      code: err.code || "REGISTRATION_ERROR",
    });
  }
});

/**
 * POST /api/auth/login
 */
router.post("/auth/login", loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};

  try {
    const result = await loginUser({ email, password });

    res.cookie("fixforge_token", result.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 24 * 60 * 60 * 1000,
    });

    res.json(result);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({
      error: err.message || "Authentication failed.",
      code: err.code || "LOGIN_ERROR",
    });
  }
});

/**
 * POST /api/auth/logout
 */
router.post("/auth/logout", async (req, res) => {
  if (req.user?.id) {
    await recordAuditLog({
      organizationId: req.user.organizationId,
      userId: req.user.id,
      action: "USER_LOGOUT",
      resourceType: "User",
      resourceId: req.user.id,
      metadata: { email: req.user.email },
    });
  }

  res.clearCookie("fixforge_token");
  res.json({ message: "Logged out successfully." });
});

/**
 * GET /api/auth/me
 */
router.get("/auth/me", requireAuth, async (req, res) => {
  try {
    const userProfile = await getUserById(req.user.id);
    if (!userProfile) {
      res.status(404).json({ error: "User profile not found.", code: "NOT_FOUND" });
      return;
    }
    res.json(userProfile);
  } catch (err) {
    res.status(500).json({ error: err.message, code: "SERVER_ERROR" });
  }
});

export default router;
