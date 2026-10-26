import { Router } from "express";
import { randomUUID } from "node:crypto";
import { prisma } from "@workspace/db";
import { requireAuth, requireRole } from "../middlewares/auth.js";
import { getAuditLogs, recordAuditLog } from "../services/security/audit-service.js";
import { getPolicy, updatePolicy } from "../services/security/policy-service.js";
import { hashPassword } from "../services/security/auth-service.js";

const router = Router();

/**
 * GET /api/admin/organization
 */
router.get(
  "/admin/organization",
  requireAuth,
  requireRole("ADMIN", "MANAGER"),
  async (req, res) => {
    try {
      const org = await prisma.organization.findUnique({
        where: { id: req.user.organizationId },
        include: {
          _count: {
            select: { members: true, projects: true, repairJobs: true },
          },
        },
      });
      if (!org) {
        res.status(404).json({ error: "Organization not found", code: "NOT_FOUND" });
        return;
      }
      res.json(org);
    } catch (err) {
      res.status(500).json({ error: err.message, code: "SERVER_ERROR" });
    }
  },
);

/**
 * GET /api/admin/members
 */
router.get(
  "/admin/members",
  requireAuth,
  requireRole("ADMIN", "MANAGER"),
  async (req, res) => {
    try {
      const members = await prisma.organizationMember.findMany({
        where: { organizationId: req.user.organizationId },
        include: {
          user: {
            select: { id: true, email: true, name: true, isActive: true, createdAt: true },
          },
        },
        orderBy: { createdAt: "asc" },
      });

      res.json(
        members.map((m) => ({
          id: m.id,
          userId: m.userId,
          email: m.user.email,
          name: m.user.name,
          role: m.role,
          isActive: m.user.isActive,
          createdAt: m.createdAt,
        })),
      );
    } catch (err) {
      res.status(500).json({ error: err.message, code: "SERVER_ERROR" });
    }
  },
);

/**
 * POST /api/admin/members
 * Admin invites / adds a member to the organization
 */
router.post(
  "/admin/members",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res) => {
    const { email, name, role = "DEVELOPER", password = "TemporaryPassword123!" } = req.body || {};

    if (!email || !name) {
      res.status(400).json({ error: "Email and name are required", code: "INVALID_INPUT" });
      return;
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const targetRole = String(role).toUpperCase();

    const VALID_ROLES = ["ADMIN", "MANAGER", "DEVELOPER", "VIEWER"];
    if (!VALID_ROLES.includes(targetRole)) {
      res.status(400).json({ error: `Invalid role: ${role}`, code: "INVALID_ROLE" });
      return;
    }

    try {
      let user = await prisma.user.findUnique({
        where: { email: normalizedEmail },
      });

      if (!user) {
        const passwordHash = await hashPassword(password);
        user = await prisma.user.create({
          data: {
            id: randomUUID(),
            email: normalizedEmail,
            name: String(name).trim(),
            passwordHash,
            isActive: true,
          },
        });
      }

      // Check if already a member of this organization
      const existingMembership = await prisma.organizationMember.findUnique({
        where: {
          organizationId_userId: {
            organizationId: req.user.organizationId,
            userId: user.id,
          },
        },
      });

      if (existingMembership) {
        res.status(409).json({
          error: "User is already a member of this organization.",
          code: "MEMBER_EXISTS",
        });
        return;
      }

      const membership = await prisma.organizationMember.create({
        data: {
          organizationId: req.user.organizationId,
          userId: user.id,
          role: targetRole,
        },
      });

      await recordAuditLog({
        organizationId: req.user.organizationId,
        userId: req.user.id,
        action: "MEMBER_ADDED",
        resourceType: "OrganizationMember",
        resourceId: membership.id,
        metadata: { addedEmail: user.email, role: targetRole },
      });

      res.status(201).json({
        id: membership.id,
        userId: user.id,
        email: user.email,
        name: user.name,
        role: membership.role,
        isActive: user.isActive,
      });
    } catch (err) {
      res.status(500).json({ error: err.message, code: "SERVER_ERROR" });
    }
  },
);

/**
 * PUT /api/admin/members/:memberId
 * Change member role
 */
router.put(
  "/admin/members/:memberId",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res) => {
    const { memberId } = req.params;
    const { role, isActive } = req.body || {};

    try {
      const membership = await prisma.organizationMember.findUnique({
        where: { id: memberId },
        include: { user: true },
      });

      if (!membership || membership.organizationId !== req.user.organizationId) {
        res.status(404).json({ error: "Member not found in organization", code: "NOT_FOUND" });
        return;
      }

      // Safeguard: Prevent removing the final administrator!
      if (membership.role === "ADMIN" && role && role !== "ADMIN") {
        const adminCount = await prisma.organizationMember.count({
          where: {
            organizationId: req.user.organizationId,
            role: "ADMIN",
          },
        });
        if (adminCount <= 1) {
          res.status(400).json({
            error: "Cannot demote the final organization administrator.",
            code: "LAST_ADMIN_PROTECTED",
          });
          return;
        }
      }

      const updated = await prisma.organizationMember.update({
        where: { id: memberId },
        data: {
          role: role ? String(role).toUpperCase() : undefined,
        },
      });

      if (typeof isActive === "boolean") {
        await prisma.user.update({
          where: { id: membership.userId },
          data: { isActive },
        });
      }

      await recordAuditLog({
        organizationId: req.user.organizationId,
        userId: req.user.id,
        action: "ROLE_CHANGED",
        resourceType: "OrganizationMember",
        resourceId: memberId,
        metadata: {
          targetUser: membership.user.email,
          previousRole: membership.role,
          newRole: updated.role,
        },
      });

      res.json({
        id: updated.id,
        userId: membership.userId,
        email: membership.user.email,
        name: membership.user.name,
        role: updated.role,
      });
    } catch (err) {
      res.status(500).json({ error: err.message, code: "SERVER_ERROR" });
    }
  },
);

/**
 * DELETE /api/admin/members/:memberId
 * Remove member from organization
 */
router.delete(
  "/admin/members/:memberId",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res) => {
    const { memberId } = req.params;

    try {
      const membership = await prisma.organizationMember.findUnique({
        where: { id: memberId },
        include: { user: true },
      });

      if (!membership || membership.organizationId !== req.user.organizationId) {
        res.status(404).json({ error: "Member not found in organization", code: "NOT_FOUND" });
        return;
      }

      // Safeguard: Prevent deleting the final administrator!
      if (membership.role === "ADMIN") {
        const adminCount = await prisma.organizationMember.count({
          where: {
            organizationId: req.user.organizationId,
            role: "ADMIN",
          },
        });
        if (adminCount <= 1) {
          res.status(400).json({
            error: "Cannot remove the final organization administrator.",
            code: "LAST_ADMIN_PROTECTED",
          });
          return;
        }
      }

      await prisma.organizationMember.delete({
        where: { id: memberId },
      });

      await recordAuditLog({
        organizationId: req.user.organizationId,
        userId: req.user.id,
        action: "MEMBER_REMOVED",
        resourceType: "OrganizationMember",
        resourceId: memberId,
        metadata: { removedUser: membership.user.email, role: membership.role },
      });

      res.json({ message: "Member removed from organization." });
    } catch (err) {
      res.status(500).json({ error: err.message, code: "SERVER_ERROR" });
    }
  },
);

/**
 * GET /api/admin/policy
 */
router.get(
  "/admin/policy",
  requireAuth,
  requireRole("ADMIN", "MANAGER"),
  async (req, res) => {
    try {
      const policy = await getPolicy(req.user.organizationId);
      res.json(policy);
    } catch (err) {
      res.status(500).json({ error: err.message, code: "SERVER_ERROR" });
    }
  },
);

/**
 * PUT /api/admin/policy
 */
router.put(
  "/admin/policy",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res) => {
    try {
      const updated = await updatePolicy(
        req.user.organizationId,
        req.body,
        req.user.id,
      );
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: err.message, code: "SERVER_ERROR" });
    }
  },
);

/**
 * GET /api/admin/audit-logs
 */
router.get(
  "/admin/audit-logs",
  requireAuth,
  requireRole("ADMIN", "MANAGER"),
  async (req, res) => {
    try {
      const { action, userId, limit = 50, offset = 0 } = req.query;
      const logs = await getAuditLogs({
        organizationId: req.user.organizationId,
        action: action ? String(action) : null,
        userId: userId ? String(userId) : null,
        limit: Number(limit),
        offset: Number(offset),
      });

      res.json({ logs, total: logs.length });
    } catch (err) {
      res.status(500).json({ error: err.message, code: "SERVER_ERROR" });
    }
  },
);

export default router;
