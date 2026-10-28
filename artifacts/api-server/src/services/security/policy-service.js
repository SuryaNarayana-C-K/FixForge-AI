import { randomUUID } from "node:crypto";
import { prisma } from "@workspace/db";
import { recordAuditLog } from "./audit-service.js";

export async function getPolicy(organizationId) {
  if (!organizationId) return null;
  let policy = await prisma.approvalPolicy.findFirst({
    where: { organizationId },
  });

  if (!policy) {
    policy = await prisma.approvalPolicy.create({
      data: {
        id: randomUUID(),
        organizationId,
        name: "Default Policy",
        requireHumanApproval: true,
        requireVerifiedRepair: true,
        allowGitHubPR: true,
        allowPush: true,
      },
    });
  }

  return policy;
}

export async function updatePolicy(organizationId, updates, userId = null) {
  const policy = await getPolicy(organizationId);

  const updated = await prisma.approvalPolicy.update({
    where: { id: policy.id },
    data: {
      name: updates.name !== undefined ? updates.name : policy.name,
      requireHumanApproval:
        updates.requireHumanApproval !== undefined
          ? Boolean(updates.requireHumanApproval)
          : policy.requireHumanApproval,
      requireVerifiedRepair:
        updates.requireVerifiedRepair !== undefined
          ? Boolean(updates.requireVerifiedRepair)
          : policy.requireVerifiedRepair,
      allowGitHubPR:
        updates.allowGitHubPR !== undefined
          ? Boolean(updates.allowGitHubPR)
          : policy.allowGitHubPR,
      allowPush:
        updates.allowPush !== undefined
          ? Boolean(updates.allowPush)
          : policy.allowPush,
    },
  });

  await recordAuditLog({
    organizationId,
    userId,
    action: "POLICY_CHANGED",
    resourceType: "ApprovalPolicy",
    resourceId: updated.id,
    metadata: {
      previous: {
        requireHumanApproval: policy.requireHumanApproval,
        requireVerifiedRepair: policy.requireVerifiedRepair,
        allowGitHubPR: policy.allowGitHubPR,
        allowPush: policy.allowPush,
      },
      updated: {
        requireHumanApproval: updated.requireHumanApproval,
        requireVerifiedRepair: updated.requireVerifiedRepair,
        allowGitHubPR: updated.allowGitHubPR,
        allowPush: updated.allowPush,
      },
    },
  });

  return updated;
}

/**
 * Evaluates whether an action on a repair is allowed by the organization's approval policy.
 * @param {Object} params
 * @param {string} params.organizationId
 * @param {'github_pr' | 'push' | 'repair_create' | 'repair_run'} params.action
 * @param {Object} params.repair
 * @param {Object} params.user
 */
export async function evaluatePolicy({ organizationId, action, repair, user }) {
  const policy = await getPolicy(organizationId);
  if (!policy) {
    return { allowed: true };
  }

  if (action === "github_pr") {
    // 1. Check if GitHub PR is enabled in policy
    if (!policy.allowGitHubPR) {
      await recordAuditLog({
        organizationId,
        userId: user?.id,
        action: "POLICY_VIOLATION",
        resourceType: "RepairJob",
        resourceId: repair?.id,
        metadata: { rule: "allowGitHubPR", reason: "GitHub PR operations disabled by policy" },
      });
      return {
        allowed: false,
        code: "POLICY_DISABLED_PR",
        reason: "Organization policy prohibits creating GitHub pull requests.",
      };
    }

    // 2. Check if verified repair is required
    if (policy.requireVerifiedRepair) {
      const isVerified =
        (repair.status === "verified" ||
          repair.status === "awaiting_approval" ||
          repair.status === "approved" ||
          repair.verificationLevel === "VERIFIED") &&
        repair.testsPassed > 0 &&
        repair.testsPassed === repair.testsTotal;

      if (!isVerified) {
        return {
          allowed: false,
          code: "UNVERIFIED_REPAIR_BLOCKED",
          reason: "Organization policy requires repairs to be verified before creating a PR.",
        };
      }
    }

    // 3. Check if human approval is required
    if (policy.requireHumanApproval) {
      const isApproved =
        repair.approvalStatus === "APPROVED" || Boolean(repair.approvedBy);

      if (!isApproved) {
        // If repair is awaiting approval
        return {
          allowed: false,
          code: "APPROVAL_REQUIRED",
          requiresApproval: true,
          reason: "Human approval is required before opening a GitHub pull request.",
        };
      }
    }
  }

  if (action === "push" && !policy.allowPush) {
    return {
      allowed: false,
      code: "POLICY_DISABLED_PUSH",
      reason: "Direct branch push is prohibited by organization policy.",
    };
  }

  return { allowed: true, policy };
}
