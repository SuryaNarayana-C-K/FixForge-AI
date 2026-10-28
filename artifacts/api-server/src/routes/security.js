import { Router } from "express";
import { getSecurityOverview } from "../services/security/audit-service.js";
import { requireAuth, requireRole } from "../middlewares/auth.js";

const router = Router();

/**
 * GET /api/security/overview
 * Restricted to ADMIN and MANAGER roles only.
 * Scoped strictly to the caller's organization.
 */
router.get(
  "/security/overview",
  requireAuth,
  requireRole("ADMIN", "MANAGER"),
  async (req, res) => {
    try {
      const overview = await getSecurityOverview(req.user.organizationId);
      res.json(overview);
    } catch (err) {
      res.status(500).json({
        error: `Failed to fetch security overview: ${err.message}`,
        code: "SECURITY_OVERVIEW_ERROR",
      });
    }
  },
);

export default router;
