import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "@workspace/db";
import { recordAuditLog } from "./audit-service.js";

const JWT_SECRET = process.env.JWT_SECRET || "fixforge_m9_super_secret_jwt_key_2026!";
const TOKEN_EXPIRY = "24h";

export async function hashPassword(plainPassword) {
  return bcrypt.hash(plainPassword, 10);
}

export async function verifyPassword(plainPassword, passwordHash) {
  if (!plainPassword || !passwordHash) return false;
  return bcrypt.compare(plainPassword, passwordHash);
}

export function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function sanitizeUser(user, role = null, organization = null) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    isActive: user.isActive,
    createdAt: user.createdAt,
    role: role || (user.memberships?.[0]?.role ?? "DEVELOPER"),
    organizationId: organization?.id || user.memberships?.[0]?.organizationId || null,
    organizationName: organization?.name || user.memberships?.[0]?.organization?.name || null,
    organization: (organization || user.memberships?.[0]?.organization) ? {
      id: organization?.id || user.memberships?.[0]?.organization?.id,
      name: organization?.name || user.memberships?.[0]?.organization?.name,
      slug: organization?.slug || user.memberships?.[0]?.organization?.slug,
      tier: organization?.tier || user.memberships?.[0]?.organization?.tier || "ENTERPRISE",
    } : null,
  };
}

export async function registerUser({
  email,
  password,
  name,
  organizationName,
  organizationSlug,
}) {
  if (!email || typeof email !== "string" || !email.includes("@")) {
    throw { status: 400, message: "Valid email address is required.", code: "INVALID_EMAIL" };
  }
  if (!password || typeof password !== "string" || password.length < 8) {
    throw { status: 400, message: "Password must be at least 8 characters long.", code: "WEAK_PASSWORD" };
  }
  if (!name || typeof name !== "string" || name.trim().length === 0) {
    throw { status: 400, message: "Name is required.", code: "INVALID_NAME" };
  }

  const normalizedEmail = email.trim().toLowerCase();
  const existingUser = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });
  if (existingUser) {
    throw { status: 409, message: "User with this email already exists.", code: "USER_EXISTS" };
  }

  // Handle organization
  let org;
  let isFirstUserInOrg = false;
  const orgName = (organizationName || "My Organization").trim();
  const slug = (organizationSlug || orgName.toLowerCase().replace(/[^a-z0-9]+/g, "-")).trim();

  const existingOrg = await prisma.organization.findUnique({
    where: { slug },
  });

  if (existingOrg) {
    org = existingOrg;
    const memberCount = await prisma.organizationMember.count({
      where: { organizationId: org.id },
    });
    isFirstUserInOrg = memberCount === 0;
  } else {
    org = await prisma.organization.create({
      data: {
        id: randomUUID(),
        name: orgName,
        slug,
      },
    });
    // Create default approval policy
    await prisma.approvalPolicy.create({
      data: {
        organizationId: org.id,
        name: `${org.name} Default Policy`,
        requireHumanApproval: true,
        requireVerifiedRepair: true,
        allowGitHubPR: true,
        allowPush: true,
      },
    });
    isFirstUserInOrg = true;
  }

  const role = isFirstUserInOrg ? "ADMIN" : "DEVELOPER";
  const passwordHash = await hashPassword(password);
  const userId = randomUUID();

  const user = await prisma.user.create({
    data: {
      id: userId,
      email: normalizedEmail,
      name: name.trim(),
      passwordHash,
      isActive: true,
    },
  });

  await prisma.organizationMember.create({
    data: {
      organizationId: org.id,
      userId: user.id,
      role,
    },
  });

  const token = generateToken({
    userId: user.id,
    email: user.email,
    name: user.name,
    organizationId: org.id,
    role,
  });

  await recordAuditLog({
    organizationId: org.id,
    userId: user.id,
    action: "USER_REGISTERED",
    resourceType: "User",
    resourceId: user.id,
    metadata: { email: user.email, role, organizationName: org.name },
  });

  return {
    user: sanitizeUser(user, role, org),
    organization: { id: org.id, name: org.name, slug: org.slug, role },
    token,
  };
}

export async function loginUser({ email, password }) {
  if (!email || !password) {
    throw { status: 400, message: "Invalid email or password.", code: "INVALID_CREDENTIALS" };
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    include: {
      memberships: {
        include: { organization: true },
      },
    },
  });

  if (!user) {
    await recordAuditLog({
      action: "USER_LOGIN_FAILED",
      resourceType: "User",
      metadata: { emailAttempted: normalizedEmail, reason: "User not found" },
    });
    throw { status: 401, message: "Invalid email or password.", code: "INVALID_CREDENTIALS" };
  }

  if (!user.isActive) {
    await recordAuditLog({
      userId: user.id,
      action: "USER_LOGIN_FAILED",
      resourceType: "User",
      resourceId: user.id,
      metadata: { reason: "Account inactive" },
    });
    throw { status: 403, message: "Account has been deactivated. Please contact your administrator.", code: "ACCOUNT_DEACTIVATED" };
  }

  const isValidPassword = await verifyPassword(String(password), user.passwordHash);
  if (!isValidPassword) {
    await recordAuditLog({
      userId: user.id,
      organizationId: user.memberships?.[0]?.organizationId || null,
      action: "USER_LOGIN_FAILED",
      resourceType: "User",
      resourceId: user.id,
      metadata: { reason: "Incorrect password" },
    });
    throw { status: 401, message: "Invalid email or password.", code: "INVALID_CREDENTIALS" };
  }

  const membership = user.memberships?.[0];
  const role = membership?.role || "DEVELOPER";
  const org = membership?.organization || null;

  const token = generateToken({
    userId: user.id,
    email: user.email,
    name: user.name,
    organizationId: org?.id || null,
    role,
  });

  await recordAuditLog({
    userId: user.id,
    organizationId: org?.id || null,
    action: "USER_LOGIN",
    resourceType: "User",
    resourceId: user.id,
    metadata: { role, organization: org?.name },
  });

  return {
    user: sanitizeUser(user, role, org),
    organization: org ? { id: org.id, name: org.name, slug: org.slug, role } : null,
    token,
  };
}

export async function getUserById(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      memberships: {
        include: { organization: true },
      },
    },
  });

  if (!user) return null;
  const membership = user.memberships?.[0];
  return {
    user: sanitizeUser(user, membership?.role, membership?.organization),
    organization: membership?.organization
      ? {
          id: membership.organization.id,
          name: membership.organization.name,
          slug: membership.organization.slug,
          role: membership.role,
        }
      : null,
  };
}
