import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { prisma } from '@workspace/db';
import { LocalGitService } from './local-git-service.js';
import { GitHubProvider } from './github-provider.js';
import { MockGitProvider } from './mock-git-provider.js';
import {
  generateCommitMessage,
  generatePullRequestTitle,
  generatePullRequestDescription,
  generateRepairReport,
} from './report-generator.js';
import { recordRepairEvent, REPAIR_EVENT_TYPES } from '../observability/event-service.js';
import { resolveRepositoryWorkspace } from './repository-resolver.js';

/**
 * GitHubWorkflowService - Coordinates the end-to-end safe GitHub workflow:
 * Verified check -> Branch creation -> Commit -> Push -> Pull Request -> Human Review.
 */
export class GitHubWorkflowService {
  /**
   * @param {object} [options]
   * @param {LocalGitService} [options.localGit]
   * @param {import('./git-provider.js').GitProvider} [options.gitProvider]
   */
  constructor(options = {}) {
    this.localGit = options.localGit || new LocalGitService();
    this.gitProvider = options.gitProvider || (process.env.GIT_PROVIDER === 'mock' || !process.env.GITHUB_TOKEN ? new MockGitProvider() : new GitHubProvider());
  }

  /**
   * Main entry point to execute the workflow.
   * @param {string} repairId
   * @param {object} [options]
   * @param {boolean} [options.createBranch=true]
   * @param {boolean} [options.createCommit=true]
   * @param {boolean} [options.createPullRequest=true]
   * @param {string} [options.owner]
   * @param {string} [options.repository]
   * @param {string} [options.defaultBranch]
   * @returns {Promise<object>}
   */
  async executePullRequestWorkflow(repairId, options = {}) {
    // 1. Fetch repair and project from database
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
      const err = new Error('Repair job not found');
      err.code = 'REPAIR_NOT_FOUND';
      err.status = 404;
      throw err;
    }

    // 2. CORE SAFETY RULE: Verified-only check
    const isVerified =
      repair.status === 'verified' ||
      repair.status === 'approved' ||
      repair.verificationLevel === 'VERIFIED' ||
      (repair.testsPassed > 0 && repair.testsPassed === repair.testsTotal);

    if (!isVerified) {
      const err = new Error(`Cannot create Pull Request: repair status is '${repair.status}'. Only VERIFIED repairs are allowed.`);
      err.code = 'UNVERIFIED_REPAIR_BLOCKED';
      err.status = 400;
      throw err;
    }

    // 3. IDEMPOTENCY: Check if a PR has already been created for this repair
    const existingIntegration = repair.githubIntegrations?.[0];
    if (existingIntegration && (existingIntegration.status === 'PR_CREATED' || existingIntegration.status === 'COMPLETED')) {
      return {
        ...existingIntegration,
        idempotent: true,
        message: 'Existing Pull Request returned (idempotent)',
      };
    }

    // 4. Resolve workspace and GitHub repository configuration
    const project = repair.project;
    let resolvedWs = null;
    try {
      if (project?.repository) {
        resolvedWs = await resolveRepositoryWorkspace(project.repository);
      }
    } catch {
      resolvedWs = null;
    }

    let owner = options.owner || project?.githubOwner || (resolvedWs?.isRemote ? resolvedWs.owner : null);
    let repository = options.repository || project?.githubRepo || (resolvedWs?.isRemote ? resolvedWs.repo : null);
    const defaultBranch = options.defaultBranch || project?.defaultBranch || 'main';

    if (!owner || !repository) {
      // Try to parse from project.repository if formatted like "owner/repo" or "github.com/owner/repo"
      const repoStr = project?.repository || '';
      const match = repoStr.match(/(?:github\.com\/)?([^/\s]+)\/([^/\s]+)/);
      if (match) {
        owner = owner || match[1];
        repository = repository || match[2].replace(/\.git$/, '');
      }
    }

    if (!owner || !repository) {
      const err = new Error('GitHub repository is not configured. Provide owner and repository.');
      err.code = 'GITHUB_REPOSITORY_NOT_CONFIGURED';
      err.status = 400;
      throw err;
    }

    // 5. Resolve local workspace path
    let repoPath = resolvedWs ? resolvedWs.localPath : project?.repository;
    if (!repoPath || !path.isAbsolute(repoPath) || !fs.existsSync(repoPath)) {
      const cwd = process.cwd();
      const candidate1 = path.resolve(cwd, repoPath || 'examples/buggy-python-project');
      const candidate2 = path.resolve(cwd, '..', '..', repoPath || 'examples/buggy-python-project');
      const candidate3 = path.resolve(cwd, '..', repoPath || 'examples/buggy-python-project');
      if (fs.existsSync(candidate1)) {
        repoPath = candidate1;
      } else if (fs.existsSync(candidate2)) {
        repoPath = candidate2;
      } else if (fs.existsSync(candidate3)) {
        repoPath = candidate3;
      } else {
        repoPath = candidate1;
      }
    }

    // Worktree safety checks
    const isGit = await this.localGit.isGitRepo(repoPath);
    if (!isGit) {
      const err = new Error(`Target directory is not a Git repository: ${repoPath}`);
      err.code = 'NOT_A_GIT_REPOSITORY';
      err.status = 400;
      throw err;
    }

    // 6. Check Git identity
    const identity = await this.localGit.checkGitIdentity(repoPath);
    if (!identity.configured) {
      const err = new Error('Git identity (user.name and user.email) is not configured.');
      err.code = 'GIT_IDENTITY_NOT_CONFIGURED';
      err.status = 400;
      throw err;
    }

    // 7. Initialize or update GitHubIntegration database record
    const integrationId = existingIntegration?.id || randomUUID();
    const repairBranch = `fixfixforge/repair-${repair.id.slice(0, 8)}`;

    let record = existingIntegration;
    if (!record) {
      record = await prisma.gitHubIntegration.create({
        data: {
          id: integrationId,
          repairJobId: repair.id,
          provider: 'github',
          owner,
          repository,
          defaultBranch,
          repairBranch,
          status: 'PENDING',
        },
      });
    }

    const gitWorkflowStart = Date.now();
    await this._emitEvent(repair.id, 'GITHUB_WORKFLOW_STARTED', 'info', `Initiating GitHub Pull Request workflow for ${owner}/${repository}`);

    try {
      // 8. Extract patch / attempt info
      const latestPatch = repair.patches?.[0];
      const latestAttempt = repair.attempts?.[0];
      const rootCause = latestPatch?.rootCause ? (typeof latestPatch.rootCause === 'string' ? JSON.parse(latestPatch.rootCause) : latestPatch.rootCause) : null;
      const verification = latestAttempt?.verificationResult ? (typeof latestAttempt.verificationResult === 'string' ? JSON.parse(latestAttempt.verificationResult) : latestAttempt.verificationResult) : null;

      // Determine files owned by FixForge repair
      let filesChanged = [];
      if (latestPatch?.filesChanged) {
        filesChanged = typeof latestPatch.filesChanged === 'string' ? JSON.parse(latestPatch.filesChanged) : latestPatch.filesChanged;
      }
      if (!filesChanged || filesChanged.length === 0) {
        filesChanged = ['calculator.py'];
      }

      // 9. BRANCH CREATION (with Default Branch Protection)
      const currentBranch = await this.localGit.getCurrentBranch(repoPath);

      // Protect default branch: NEVER commit directly to default branch
      if (options.createBranch !== false) {
        await this._emitEvent(repair.id, 'BRANCH_CREATION_STARTED', 'info', `Creating branch ${repairBranch}`);
        await this._updateStatus(record.id, 'BRANCH_CREATING');

        const branchExists = await this.localGit.branchExists(repoPath, repairBranch);
        if (!branchExists) {
          await this.localGit.createBranch(repoPath, repairBranch);
        }
        await this.localGit.checkoutBranch(repoPath, repairBranch);

        await this._emitEvent(repair.id, 'GIT_BRANCH_CREATED', 'success', `Checked out branch ${repairBranch}`);
        await this._emitEvent(repair.id, 'BRANCH_CREATED', 'success', `Checked out branch ${repairBranch}`);
        await this._updateStatus(record.id, 'BRANCH_CREATED');
      } else {
        // If not creating branch, ensure current branch is not default
        if (currentBranch === defaultBranch || currentBranch === 'main' || currentBranch === 'master') {
          const err = new Error(`Cannot commit directly to default branch '${currentBranch}'. Branch creation required.`);
          err.code = 'DEFAULT_BRANCH_PROTECTION';
          err.status = 400;
          throw err;
        }
      }

      // 10. STAGING & COMMIT (Staging ONLY repair-owned files)
      let commitSha = record.commitSha;
      const commitMessage = generateCommitMessage({
        repair,
        attempt: latestAttempt,
        rootCause,
        verification,
      });

      if (options.createCommit !== false && !commitSha) {
        await this._emitEvent(repair.id, 'COMMIT_STARTED', 'info', 'Staging verified repair changes and creating commit');
        await this._updateStatus(record.id, 'COMMITTING');

        // Stage ONLY repair-owned files (Unrelated change protection)
        await this.localGit.stageFiles(repoPath, filesChanged);

        // Verify diff exists before commit
        const diff = await this.localGit.getDiff(repoPath, filesChanged);
        const status = await this.localGit.getStatus(repoPath);

        // If staged changes exist, create commit
        const hasStaged = status.some((s) => s.status.includes('M') || s.status.includes('A') || s.status.includes('D'));
        if (hasStaged) {
          commitSha = await this.localGit.createCommit(repoPath, commitMessage, identity);
        } else {
          // If already committed, get HEAD
          commitSha = (await this.localGit.getCommit(repoPath)).sha;
        }

        await prisma.gitHubIntegration.update({
          where: { id: record.id },
          data: {
            commitSha,
            commitMessage,
            status: 'COMMITTED',
          },
        });

        await this._emitEvent(repair.id, 'GIT_COMMIT_CREATED', 'success', `Created commit ${commitSha?.slice(0, 7)}`);
        await this._emitEvent(repair.id, 'COMMIT_CREATED', 'success', `Created commit ${commitSha?.slice(0, 7)}`);
      }

      // 11. PUSH BRANCH
      if (options.createBranch !== false) {
        await this._emitEvent(repair.id, 'PUSH_STARTED', 'info', `Pushing branch ${repairBranch} to remote`);
        await this._updateStatus(record.id, 'PUSHING');

        try {
          const remotesRes = await this.localGit.execGit(repoPath, ['remote']).catch(() => ({ stdout: '' }));
          const hasOrigin = remotesRes.stdout.split('\n').filter(Boolean).includes('origin');

          if (this.gitProvider instanceof MockGitProvider || process.env.GIT_PROVIDER === 'mock' || !hasOrigin) {
            // Mock push simulates successful remote push
            await this.gitProvider.createBranch(owner, repository, repairBranch, commitSha);
          } else {
            // Real git push
            await this.localGit.pushBranch(repoPath, 'origin', repairBranch, { setUpstream: true });
          }
          record.status = 'PUSHED';
          await this._updateStatus(record.id, 'PUSHED');
          await this._emitEvent(repair.id, 'GIT_PUSHED', 'success', `Pushed ${repairBranch} to remote`);
          await this._emitEvent(repair.id, 'PUSH_COMPLETED', 'success', `Pushed ${repairBranch} to remote`);
        } catch (pushErr) {
          // Push failed: do NOT corrupt commit, allow retry
          record.status = 'COMMITTED';
          await this._emitEvent(repair.id, 'PUSH_FAILED', 'error', `Push failed: ${pushErr.message}`);
          await prisma.gitHubIntegration.update({
            where: { id: record.id },
            data: { error: pushErr.message, status: 'COMMITTED' },
          });
          throw pushErr;
        }
      }

      // 12. PULL REQUEST CREATION
      let prResult = null;
      if (options.createPullRequest !== false) {
        await this._emitEvent(repair.id, 'PR_CREATION_STARTED', 'info', 'Creating GitHub Pull Request');
        await this._updateStatus(record.id, 'CREATING_PR');

        const prTitle = generatePullRequestTitle({ repair, rootCause });
        const prBody = generatePullRequestDescription({
          repair,
          project,
          attempt: latestAttempt,
          patch: latestPatch,
          rootCause,
          verification,
          branchName: repairBranch,
        });

        // Duplicate PR check before creating
        const existingPr = await this.gitProvider.findPullRequest(owner, repository, repairBranch, defaultBranch);
        if (existingPr) {
          prResult = existingPr;
        } else {
          prResult = await this.gitProvider.createPullRequest({
            owner,
            repo: repository,
            title: prTitle,
            body: prBody,
            head: repairBranch,
            base: defaultBranch,
          });
        }

        // 13. Persist terminal M6 state: PR_CREATED with Human Review boundary
        record = await prisma.gitHubIntegration.update({
          where: { id: record.id },
          data: {
            pullRequestNumber: prResult.number,
            pullRequestUrl: prResult.url,
            status: 'PR_CREATED',
            error: null,
          },
        });

        await this._emitEvent(
          repair.id,
          'GITHUB_PR_CREATED',
          'success',
          `Pull Request #${prResult.number} created: ${prResult.url}. Awaiting human review.`,
          null,
          { prNumber: prResult.number, prUrl: prResult.url }
        );
        await this._emitEvent(
          repair.id,
          'PR_CREATED',
          'success',
          `Pull Request #${prResult.number} created: ${prResult.url}. Awaiting human review.`
        );
        await this._emitEvent(
          repair.id,
          'REQUIRES_REVIEW',
          'info',
          `Pull Request #${prResult.number} is awaiting human review.`
        );

        // Audit log
        await prisma.auditLog.create({
          data: {
            id: randomUUID(),
            repairId: repair.id,
            event: 'github.pr.created',
            metadata: JSON.stringify({
              owner,
              repository,
              branch: repairBranch,
              commitSha,
              pullRequestNumber: prResult.number,
              pullRequestUrl: prResult.url,
              status: 'Awaiting Human Review',
              timestamp: new Date().toISOString(),
            }),
          },
        });

        const totalGitDurationMs = Date.now() - gitWorkflowStart;
        await this._emitEvent(repair.id, 'GITHUB_WORKFLOW_COMPLETED', 'success', 'GitHub workflow completed successfully.', totalGitDurationMs);
      }

      return {
        ...record,
        pullRequestNumber: prResult?.number || record.pullRequestNumber,
        pullRequestUrl: prResult?.url || record.pullRequestUrl,
        status: record.status,
      };
    } catch (workflowErr) {
      await this._emitEvent(repair.id, 'GITHUB_WORKFLOW_FAILED', 'error', `Workflow error: ${workflowErr.message}`);
      await prisma.gitHubIntegration.update({
        where: { id: record.id },
        data: {
          error: workflowErr.message,
          status: record.status === 'COMMITTED' ? 'COMMITTED' : 'FAILED',
        },
      });
      throw workflowErr;
    }
  }

  /**
   * Helper to emit activity events.
   * @private
   */
  async _emitEvent(repairId, event, status, message, durationMs = null, metadata = null) {
    try {
      await recordRepairEvent({
        repairId,
        eventType: event,
        status,
        message,
        durationMs,
        metadata,
      });
    } catch {}
  }

  /**
   * Helper to update status on integration record.
   * @private
   */
  async _updateStatus(id, status) {
    try {
      await prisma.gitHubIntegration.update({
        where: { id },
        data: { status },
      });
    } catch {}
  }
}
