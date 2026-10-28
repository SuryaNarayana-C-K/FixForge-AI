import { Router } from 'express';
import { prisma } from '@workspace/db';
import { GitHubWorkflowService } from '../services/git/github-workflow-service.js';
import { generateRepairReport } from '../services/git/report-generator.js';
import { hasPermission } from '../middlewares/auth.js';
import { recordAuditLog } from '../services/security/audit-service.js';
import { evaluatePolicy } from '../services/security/policy-service.js';
import { rateLimiter } from '../middlewares/security.js';

const router = Router();
const githubLimiter = rateLimiter({ windowMs: 60000, max: 20, name: 'github_pr' });

const isProduction = () =>
  process.env.NODE_ENV === 'production' || process.env.FIXFORGE_ENV === 'production';

// Default workflow service instance
const defaultWorkflowService = new GitHubWorkflowService();

/**
 * POST /api/repairs/:repairId/github/pr
 * Execute the GitHub workflow:
 * 1. Authenticate user & check role (VIEWER cannot open PR)
 * 2. Organization isolation check
 * 3. Verified repair check (M6 preserved)
 * 4. Approval policy evaluation (M9 governance)
 * 5. Branch -> Commit -> Push -> PR
 */
router.post('/repairs/:repairId/github/pr', githubLimiter, async (req, res) => {
  const { repairId } = req.params;
  const {
    createBranch = true,
    createCommit = true,
    createPullRequest = true,
    owner,
    repository,
    defaultBranch,
  } = req.body || {};

  const isProduction =
    process.env.NODE_ENV === 'production' || process.env.FIXFORGE_ENV === 'production';

  try {
    // 0. Authentication & tenant identity check
    if (!req.user || req.isAnonymous) {
      res.status(401).json({
        error: 'Authentication required to create GitHub pull requests.',
        code: 'UNAUTHORIZED',
      });
      return;
    }
    if (!req.user.organizationId) {
      res.status(403).json({
        error: 'Tenant identity required: user account is not associated with an organization.',
        code: 'TENANT_CONTEXT_REQUIRED',
      });
      return;
    }

    // 1. Role permission check (VIEWER is prohibited from PR operations)
    if (req.user && !hasPermission(req.user.role, 'github:pr') && !hasPermission(req.user.role, 'github:pr_request')) {
      await recordAuditLog({
        organizationId: req.user?.organizationId,
        userId: req.user?.id,
        action: 'ACCESS_DENIED',
        resourceType: 'GitHubPR',
        resourceId: repairId,
        repairId,
        metadata: { reason: 'Viewer cannot initiate GitHub pull request', role: req.user.role },
      });
      res.status(403).json({
        error: 'Access denied: your role is not authorized to create GitHub pull requests.',
        code: 'ACCESS_DENIED',
      });
      return;
    }

    const repair = await prisma.repairJob.findUnique({
      where: { id: repairId },
      include: { project: true },
    });

    if (!repair) {
      res.status(404).json({ error: 'Repair not found', code: 'NOT_FOUND' });
      return;
    }

    // 2. Organization isolation check: fail closed if repairOrg is null or mismatched
    const repairOrg = repair.organizationId || repair.project?.organizationId;
    if (!repairOrg || repairOrg !== req.user.organizationId) {
      await recordAuditLog({
        organizationId: req.user.organizationId,
        userId: req.user.id,
        action: 'ACCESS_DENIED',
        resourceType: 'GitHubPR',
        resourceId: repairId,
        repairId,
        metadata: { reason: 'Cross-organization GitHub PR creation attempt' },
      });
      res.status(403).json({
        error: 'Access denied: repair belongs to another organization.',
        code: 'ACCESS_DENIED',
      });
      return;
    }

    // 3. M6 verified repair check
    const isVerified =
      (repair.status === 'verified' ||
        repair.status === 'awaiting_approval' ||
        repair.status === 'approved' ||
        repair.verificationLevel === 'VERIFIED') &&
      repair.testsPassed > 0 &&
      repair.testsPassed === repair.testsTotal;

    if (!isVerified) {
      await recordAuditLog({
        organizationId: repairOrg,
        userId: req.user?.id,
        action: 'POLICY_VIOLATION',
        resourceType: 'RepairJob',
        resourceId: repairId,
        repairId,
        metadata: { reason: 'Attempted PR on unverified repair' },
      });
      res.status(400).json({
        error: 'Cannot open Pull Request for unverified repair: regression tests have not all passed.',
        code: 'UNVERIFIED_REPAIR_BLOCKED',
      });
      return;
    }

    // 4. M9 Governance: Approval Policy Evaluation
    const policyResult = await evaluatePolicy({
      organizationId: repairOrg,
      action: 'github_pr',
      repair,
      user: req.user,
    });

    if (!policyResult.allowed) {
      if (policyResult.code === 'APPROVAL_REQUIRED') {
        // Transition repair status to awaiting_approval
        await prisma.repairJob.update({
          where: { id: repairId },
          data: {
            approvalStatus: 'PENDING',
            status: 'awaiting_approval',
          },
        });

        await recordAuditLog({
          organizationId: repairOrg,
          userId: req.user?.id,
          action: 'ACCESS_DENIED',
          resourceType: 'RepairJob',
          resourceId: repairId,
          repairId,
          metadata: { reason: 'Human approval gate triggered' },
        });

        res.status(403).json({
          error: 'Human approval is required before opening a GitHub pull request.',
          code: 'APPROVAL_REQUIRED',
          approvalStatus: 'PENDING',
        });
        return;
      }

      res.status(403).json({
        error: policyResult.reason,
        code: policyResult.code || 'POLICY_VIOLATION',
      });
      return;
    }

    // 4b. Idempotency check: if PR already created, return existing result idempotently
    const existingPR = await prisma.gitHubIntegration.findFirst({
      where: {
        repairJobId: repairId,
        OR: [{ status: 'PR_CREATED' }, { pullRequestNumber: { not: null } }],
      },
    });

    if (existingPR && existingPR.pullRequestNumber) {
      await prisma.repairJob.update({
        where: { id: repairId },
        data: { deliveryStatus: 'DELIVERED', deliveryError: null },
      });
      res.json({
        success: true,
        idempotent: true,
        pullRequest: {
          number: existingPR.pullRequestNumber,
          url: existingPR.pullRequestUrl,
        },
        branch: { name: existingPR.repairBranch },
        commit: { sha: existingPR.commitSha },
        integration: existingPR,
        message: 'Pull request already exists for this verified repair.',
      });
      return;
    }

    await recordAuditLog({
      organizationId: repairOrg,
      userId: req.user?.id,
      action: 'GITHUB_PR_REQUESTED',
      resourceType: 'RepairJob',
      resourceId: repairId,
      repairId,
      metadata: { owner, repository },
    });

    // 5. Execute GitHub workflow
    const result = await defaultWorkflowService.executePullRequestWorkflow(repairId, {
      createBranch,
      createCommit,
      createPullRequest,
      owner,
      repository,
      defaultBranch,
    });

    await prisma.repairJob.update({
      where: { id: repairId },
      data: { deliveryStatus: 'DELIVERED', deliveryError: null },
    });

    await recordAuditLog({
      organizationId: repairOrg,
      userId: req.user?.id,
      action: 'GITHUB_PR_CREATED',
      resourceType: 'GitHubIntegration',
      resourceId: result.integration?.id || repairId,
      repairId,
      metadata: {
        pullRequestNumber: result.pullRequest?.number,
        pullRequestUrl: result.pullRequest?.url,
        branch: result.branch?.name,
      },
    });

    res.json(result);
  } catch (err) {
    let sanitizedMsg = err.message || String(err);
    // Sanitize any potential GitHub tokens or secrets
    sanitizedMsg = sanitizedMsg
      .replace(/ghp_[A-Za-z0-9_]{30,}/g, '[REDACTED_GITHUB_TOKEN]')
      .replace(/github_pat_[A-Za-z0-9_]{30,}/g, '[REDACTED_GITHUB_TOKEN]')
      .replace(/token\s+[A-Za-z0-9_-]{20,}/gi, 'token [REDACTED]');

    try {
      await prisma.repairJob.update({
        where: { id: repairId },
        data: { deliveryStatus: 'FAILED', deliveryError: sanitizedMsg },
      });
    } catch {}

    const status = err.status || (err.code === 'UNVERIFIED_REPAIR_BLOCKED' ? 400 : 500);
    res.status(status).json({
      error: sanitizedMsg,
      code: err.code || 'GITHUB_WORKFLOW_ERROR',
    });
  }
});

/**
 * GET /api/repairs/:repairId/github
 * Retrieve current GitHub integration status and history for a repair.
 */
router.get('/repairs/:repairId/github', async (req, res) => {
  const { repairId } = req.params;

  const repair = await prisma.repairJob.findUnique({
    where: { id: repairId },
    include: {
      project: true,
      githubIntegrations: {
        orderBy: { createdAt: 'desc' },
      },
    },
  });

  if (!repair) {
    res.status(404).json({ error: 'Repair not found' });
    return;
  }

  if (!req.user || req.isAnonymous) {
    res.status(401).json({ error: 'Authentication required.', code: 'UNAUTHORIZED' });
    return;
  }
  if (!req.user.organizationId) {
    res.status(403).json({
      error: 'Tenant identity required: user account is not associated with an organization.',
      code: 'TENANT_CONTEXT_REQUIRED',
    });
    return;
  }

  const repairOrg = repair.organizationId || repair.project?.organizationId;
  if (!repairOrg || repairOrg !== req.user.organizationId) {
    res.status(403).json({ error: 'Access denied: repair belongs to another organization.', code: 'ACCESS_DENIED' });
    return;
  }

  const integration = repair.githubIntegrations?.[0] || null;

  res.json({
    configured: Boolean(integration || repair.project?.githubOwner),
    owner: integration?.owner || repair.project?.githubOwner || null,
    repository: integration?.repository || repair.project?.githubRepo || null,
    defaultBranch: integration?.defaultBranch || repair.project?.defaultBranch || 'main',
    integration,
    history: repair.githubIntegrations || [],
  });
});

/**
 * GET /api/repairs/:repairId/github/report
 * Retrieve generated repair report in markdown and structured format.
 */
router.get('/repairs/:repairId/github/report', async (req, res) => {
  const { repairId } = req.params;

  const repair = await prisma.repairJob.findUnique({
    where: { id: repairId },
    include: {
      project: true,
      patches: { orderBy: { createdAt: 'desc' } },
      attempts: { orderBy: { attemptNumber: 'desc' } },
      githubIntegrations: { orderBy: { createdAt: 'desc' } },
    },
  });

  if (!repair) {
    res.status(404).json({ error: 'Repair not found' });
    return;
  }

  if (!req.user || req.isAnonymous) {
    res.status(401).json({ error: 'Authentication required.', code: 'UNAUTHORIZED' });
    return;
  }
  if (!req.user.organizationId) {
    res.status(403).json({
      error: 'Tenant identity required: user account is not associated with an organization.',
      code: 'TENANT_CONTEXT_REQUIRED',
    });
    return;
  }

  const reportRepairOrg = repair.organizationId || repair.project?.organizationId;
  if (!reportRepairOrg || reportRepairOrg !== req.user.organizationId) {
    res.status(403).json({ error: 'Access denied: repair belongs to another organization.', code: 'ACCESS_DENIED' });
    return;
  }

  const integration = repair.githubIntegrations?.[0];
  const patch = repair.patches?.[0];
  const attempt = repair.attempts?.[0];
  const rootCause = patch?.rootCause ? (typeof patch.rootCause === 'string' ? JSON.parse(patch.rootCause) : patch.rootCause) : null;
  const verification = attempt?.verificationResult ? (typeof attempt.verificationResult === 'string' ? JSON.parse(attempt.verificationResult) : attempt.verificationResult) : null;

  const report = generateRepairReport({
    repair,
    project: repair.project,
    attempt,
    patch,
    rootCause,
    verification,
    branchName: integration?.repairBranch || `fixfixforge/repair-${repair.id.slice(0, 8)}`,
    commitSha: integration?.commitSha,
    pullRequestUrl: integration?.pullRequestUrl,
  });

  res.json(report);
});

export default router;
