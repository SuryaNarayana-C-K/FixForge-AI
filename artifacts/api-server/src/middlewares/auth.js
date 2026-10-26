import { verifyToken } from "../services/security/auth-service.js";
import { recordAuditLog } from "../services/security/audit-service.js";
import { DEMO_USERS, DEMO_ORGS, prisma } from "@workspace/db";

export const ROLE_PERMISSIONS = {
  ADMIN: [
    "org:manage",
    "user:manage",
    "project:manage",
    "project:create",
    "policy:manage",
    "repair:create",
    "repair:run",
    "repair:approve",
    "repair:reject",
    "github:pr",
    "github:operate",
    "audit:read",
    "security:read",
    "observability:read",
    "project:view",
    "repair:view",
  ],
  MANAGER: [
    "project:manage",
    "project:create",
    "repair:create",
    "repair:run",
    "repair:approve",
    "repair:reject",
    "github:pr",
    "audit:read",
    "security:read",
    "observability:read",
    "project:view",
    "repair:view",
  ],
  DEVELOPER: [
    "project:view",
    "repair:create",
    "repair:run",
    "repair:view",
    "github:pr_request",
    "observability:read",
  ],
  VIEWER: [
    "project:view",
    "repair:view",
    "observability:read",
  ],
};

export function hasPermission(role, permission) {
  const permissions = ROLE_PERMISSIONS[role] || [];
  return permissions.includes(permission);
}

export async function authenticate(req, res, next) {
  let token = null;

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.substring(7).trim();
  } else if (req.cookies?.fixforge_token) {
    token = req.cookies.fixforge_token;
  }

  if (token) {
    const decoded = verifyToken(token);
    if (!decoded) {
      res.status(401).json({
        error: "Invalid or expired authorization token.",
        code: "UNAUTHORIZED",
      });
      return;
    }

    try {
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        include: {
          memberships: {
            where: decoded.organizationId
              ? { organizationId: decoded.organizationId }
              : undefined,
            include: { organization: true },
          },
        },
      });

      if (!user || !user.isActive) {
        res.status(401).json({
          error: "User not found or account is deactivated.",
          code: "UNAUTHORIZED",
        });
        return;
      }

      const membership = user.memberships?.[0];
      req.user = {
        id: user.id,
        email: user.email,
        name: user.name,
        role: membership?.role || decoded.role || "DEVELOPER",
        organizationId: membership?.organizationId || decoded.organizationId || null,
        organizationName: membership?.organization?.name || null,
      };
      next();
      return;
    } catch {
      res.status(401).json({
        error: "Failed to authenticate session.",
        code: "UNAUTHORIZED",
      });
      return;
    }
  }

  // Explicit anonymous request flag
  if (req.headers["x-anonymous"] === "true") {
    req.user = null;
    req.isAnonymous = true;
    next();
    return;
  }

  const nodeEnv = (process.env.NODE_ENV || "").trim().toLowerCase();
  const fixforgeEnv = (process.env.FIXFORGE_ENV || "").trim().toLowerCase();
  const isProductionOrStaging =
    nodeEnv === "production" ||
    fixforgeEnv === "production" ||
    nodeEnv === "staging" ||
    fixforgeEnv === "staging";

  // In production and staging, refuse demo fallback and reject spoofed x-demo-role
  if (isProductionOrStaging) {
    req.user = null;
    req.isAnonymous = true;
    req.isDemoFallback = false;
    next();
    return;
  }

  // Backward compatibility / demo mode for development test suites (M1-M8)
  const demoRole = req.headers["x-demo-role"] || "ADMIN";
  req.user = {
    id: DEMO_USERS.ADMIN.id,
    email: DEMO_USERS.ADMIN.email,
    name: DEMO_USERS.ADMIN.name,
    role: demoRole,
    organizationId: DEMO_ORGS.FIXFORGE_LABS.id,
    organizationName: DEMO_ORGS.FIXFORGE_LABS.name,
  };
  req.isDemoFallback = true;
  next();
}

export function requireStrictAuth(req, res, next) {
  let token = null;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.substring(7).trim();
  } else if (req.cookies?.fixforge_token) {
    token = req.cookies.fixforge_token;
  }

  if (!token) {
    res.status(401).json({
      error: "Authentication required.",
      code: "UNAUTHORIZED",
    });
    return;
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    res.status(401).json({
      error: "Invalid or expired token.",
      code: "UNAUTHORIZED",
    });
    return;
  }

  prisma.user
    .findUnique({
      where: { id: decoded.userId },
      include: {
        memberships: {
          where: decoded.organizationId
            ? { organizationId: decoded.organizationId }
            : undefined,
          include: { organization: true },
        },
      },
    })
    .then((user) => {
      if (!user || !user.isActive) {
        res.status(401).json({
          error: "User not found or account deactivated.",
          code: "UNAUTHORIZED",
        });
        return;
      }

      const membership = user.memberships?.[0];
      req.user = {
        id: user.id,
        email: user.email,
        name: user.name,
        role: membership?.role || decoded.role || "DEVELOPER",
        organizationId: membership?.organizationId || decoded.organizationId || null,
        organizationName: membership?.organization?.name || null,
      };
      next();
    })
    .catch(() => {
      res.status(401).json({
        error: "Failed to authenticate session.",
        code: "UNAUTHORIZED",
      });
    });
}

export function requireAuth(req, res, next) {
  if (!req.user || req.isAnonymous) {
    res.status(401).json({
      error: "Authentication required to access this resource.",
      code: "UNAUTHORIZED",
    });
    return;
  }
  next();
}

export function requireRole(...allowedRoles) {
  return async (req, res, next) => {
    if (!req.user || req.isAnonymous) {
      res.status(401).json({
        error: "Authentication required.",
        code: "UNAUTHORIZED",
      });
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      await recordAuditLog({
        organizationId: req.user.organizationId,
        userId: req.user.id,
        action: "ACCESS_DENIED",
        resourceType: "API_ENDPOINT",
        resourceId: req.originalUrl,
        metadata: {
          userRole: req.user.role,
          requiredRoles: allowedRoles,
          method: req.method,
        },
      });

      res.status(403).json({
        error: "Access denied: insufficient permissions.",
        code: "ACCESS_DENIED",
      });
      return;
    }

    next();
  };
}

export function requirePermission(permission) {
  return async (req, res, next) => {
    if (!req.user || req.isAnonymous) {
      res.status(401).json({
        error: "Authentication required.",
        code: "UNAUTHORIZED",
      });
      return;
    }

    if (!hasPermission(req.user.role, permission)) {
      await recordAuditLog({
        organizationId: req.user.organizationId,
        userId: req.user.id,
        action: "ACCESS_DENIED",
        resourceType: "PERMISSION",
        resourceId: permission,
        metadata: {
          userRole: req.user.role,
          requiredPermission: permission,
          endpoint: req.originalUrl,
        },
      });

      res.status(403).json({
        error: `Access denied: requires '${permission}' permission.`,
        code: "ACCESS_DENIED",
      });
      return;
    }

    next();
  };
}
