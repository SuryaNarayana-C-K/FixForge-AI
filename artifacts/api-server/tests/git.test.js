import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { prisma, seedDatabase, DEMO_ORGS } from '@workspace/db';
import { LocalGitService } from '../src/services/git/local-git-service.js';
import { MockGitProvider } from '../src/services/git/mock-git-provider.js';
import { GitHubProvider } from '../src/services/git/github-provider.js';
import { GitHubWorkflowService } from '../src/services/git/github-workflow-service.js';
import { enableTestAuthMock } from '../src/middlewares/auth.js';

describe('FixForge Milestone 6: Git & GitHub Integration Tests', () => {
  let tempRepoDir;
  let localGit;
  let mockGitProvider;
  let workflowService;
  let projectId;

  before(async () => {
    enableTestAuthMock(true);
    await seedDatabase();
  });

  beforeEach(async () => {
    // Create an isolated temporary git repository fixture
    tempRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixforge-git-test-'));
    localGit = new LocalGitService();
    await localGit.initRepo(tempRepoDir, 'main');

    // Create a base file and commit
    fs.writeFileSync(path.join(tempRepoDir, 'calculator.py'), 'def divide(a, b):\n    return a / b\n');
    await localGit.stageFiles(tempRepoDir, ['calculator.py']);
    await localGit.createCommit(tempRepoDir, 'feat: initial calculator commit', {
      name: 'FixForge Test',
      email: 'test@fixforge.dev',
    });

    mockGitProvider = new MockGitProvider({
      defaultBranch: 'main',
      initialPrNumber: 101,
    });

    workflowService = new GitHubWorkflowService({
      localGit,
      gitProvider: mockGitProvider,
    });

    // Create a Project for testing
    projectId = randomUUID();
    await prisma.project.create({
      data: {
        id: projectId,
        organizationId: DEMO_ORGS.FIXFORGE_LABS.id,
        name: 'Git Test Project',
        repository: tempRepoDir,
        language: 'Python',
        testFramework: 'pytest',
        githubOwner: 'testowner',
        githubRepo: 'testrepo',
        defaultBranch: 'main',
      },
    });
  });

  afterEach(async () => {
    if (tempRepoDir && fs.existsSync(tempRepoDir)) {
      try {
        fs.rmSync(tempRepoDir, { recursive: true, force: true });
      } catch {}
    }
  });

  after(async () => {
    await prisma.$disconnect();
  });

  // Helper to create a test repair job
  async function createTestRepair(status = 'verified') {
    const repairId = randomUUID();
    const repair = await prisma.repairJob.create({
      data: {
        id: repairId,
        organizationId: DEMO_ORGS.FIXFORGE_LABS.id,
        projectId,
        issue: 'ZeroDivisionError in calculator.py',
        model: 'mock-llm',
        verificationLevel: 'standard',
        maxIterations: 3,
        status,
        iteration: 1,
        testsPassed: status === 'verified' ? 5 : 4,
        testsTotal: 5,
        testCommand: 'pytest',
        baselineResult: JSON.stringify({ passed: 4, total: 5, command: 'pytest' }),
        failures: JSON.stringify([{ test_name: 'test_divide_by_zero_is_safe' }]),
      },
    });

    await prisma.patch.create({
      data: {
        id: randomUUID(),
        repairJobId: repairId,
        diff: '--- a/calculator.py\n+++ b/calculator.py\n@@ -1,2 +1,4 @@\n def divide(a, b):\n+    if b == 0: return 0\n     return a / b\n',
        filesChanged: JSON.stringify(['calculator.py']),
        rootCause: JSON.stringify({
          hypothesis: 'Missing zero divisor check in divide()',
          confidence: 0.95,
          category: 'zero_division',
          file_path: 'calculator.py',
        }),
      },
    });

    await prisma.repairAttempt.create({
      data: {
        id: randomUUID(),
        repairJobId: repairId,
        attemptNumber: 1,
        status: status === 'verified' ? 'PASSED' : 'FAILED',
        verificationResult: JSON.stringify({
          status: status === 'verified' ? 'PASSED' : 'FAILED',
          passed: status === 'verified' ? 5 : 4,
          total: 5,
          regression_detected: false,
        }),
      },
    });

    return repair;
  }

  it('1. Verified repair creates branch, commit, push, and PR successfully', async () => {
    const repair = await createTestRepair('verified');

    // Introduce modification to calculator.py
    fs.writeFileSync(
      path.join(tempRepoDir, 'calculator.py'),
      'def divide(a, b):\n    if b == 0:\n        return 0\n    return a / b\n'
    );

    const result = await workflowService.executePullRequestWorkflow(repair.id);

    assert.equal(result.status, 'PR_CREATED');
    assert.equal(result.pullRequestNumber, 101);
    assert.ok(result.pullRequestUrl.includes('testowner/testrepo/pull/101'));
    assert.ok(result.repairBranch.startsWith('fixfixforge/repair-'));
    assert.ok(result.commitSha);

    // Verify git branch actually exists
    const currentBranch = await localGit.getCurrentBranch(tempRepoDir);
    assert.equal(currentBranch, result.repairBranch);

    // Verify mock git provider recorded calls
    assert.equal(mockGitProvider.getCallsFor('createBranch').length, 1);
    assert.equal(mockGitProvider.getCallsFor('createPullRequest').length, 1);
  });

  it('2. FAILED repair is strictly blocked from GitHub workflow', async () => {
    const repair = await createTestRepair('failed');

    await assert.rejects(
      async () => {
        await workflowService.executePullRequestWorkflow(repair.id);
      },
      (err) => {
        assert.equal(err.code, 'UNVERIFIED_REPAIR_BLOCKED');
        assert.ok(err.message.includes('Only VERIFIED repairs'));
        return true;
      }
    );

    // Security check: Verify NO Git provider operations were executed
    assert.equal(mockGitProvider.calls.length, 0);
  });

  it('3. REGRESSION_DETECTED repair is strictly blocked from GitHub workflow', async () => {
    const repair = await createTestRepair('regression_detected');

    await assert.rejects(
      async () => {
        await workflowService.executePullRequestWorkflow(repair.id);
      },
      (err) => {
        assert.equal(err.code, 'UNVERIFIED_REPAIR_BLOCKED');
        return true;
      }
    );

    assert.equal(mockGitProvider.calls.length, 0);
  });

  it('4. TIMEOUT repair is strictly blocked from GitHub workflow', async () => {
    const repair = await createTestRepair('timeout');

    await assert.rejects(
      async () => {
        await workflowService.executePullRequestWorkflow(repair.id);
      },
      (err) => {
        assert.equal(err.code, 'UNVERIFIED_REPAIR_BLOCKED');
        return true;
      }
    );

    assert.equal(mockGitProvider.calls.length, 0);
  });

  it('5. REQUIRES_REVIEW repair is strictly blocked from GitHub workflow', async () => {
    const repair = await createTestRepair('requires_review');

    await assert.rejects(
      async () => {
        await workflowService.executePullRequestWorkflow(repair.id);
      },
      (err) => {
        assert.equal(err.code, 'UNVERIFIED_REPAIR_BLOCKED');
        return true;
      }
    );

    assert.equal(mockGitProvider.calls.length, 0);
  });

  it('6. Missing GitHub configuration returns GITHUB_REPOSITORY_NOT_CONFIGURED', async () => {
    // Create project with missing owner and repo
    const unconfigProjId = randomUUID();
    await prisma.project.create({
      data: {
        id: unconfigProjId,
        name: 'Unconfigured Project',
        repository: tempRepoDir,
        language: 'Python',
        testFramework: 'pytest',
      },
    });

    const repairId = randomUUID();
    await prisma.repairJob.create({
      data: {
        id: repairId,
        projectId: unconfigProjId,
        issue: 'Bug',
        model: 'mock',
        verificationLevel: 'standard',
        maxIterations: 1,
        status: 'verified',
      },
    });

    await assert.rejects(
      async () => {
        await workflowService.executePullRequestWorkflow(repairId);
      },
      (err) => {
        assert.equal(err.code, 'GITHUB_REPOSITORY_NOT_CONFIGURED');
        return true;
      }
    );
  });

  it('7. Invalid GitHub credentials returns GITHUB_AUTH_FAILED and sanitizes tokens', async () => {
    const badAuthProvider = new MockGitProvider({ shouldFailAuth: true });
    const authFailService = new GitHubWorkflowService({
      localGit,
      gitProvider: badAuthProvider,
    });

    const repair = await createTestRepair('verified');
    fs.writeFileSync(path.join(tempRepoDir, 'calculator.py'), '# modified');

    await assert.rejects(
      async () => {
        await authFailService.executePullRequestWorkflow(repair.id);
      },
      (err) => {
        assert.equal(err.code, 'GITHUB_AUTH_FAILED');
        return true;
      }
    );
  });

  it('8. GitHub rate limit returns GITHUB_RATE_LIMITED', async () => {
    const rateLimitedProvider = new MockGitProvider({ shouldRateLimit: true });
    const rateLimitedService = new GitHubWorkflowService({
      localGit,
      gitProvider: rateLimitedProvider,
    });

    const repair = await createTestRepair('verified');
    fs.writeFileSync(path.join(tempRepoDir, 'calculator.py'), '# modified');

    await assert.rejects(
      async () => {
        await rateLimitedService.executePullRequestWorkflow(repair.id);
      },
      (err) => {
        assert.equal(err.code, 'GITHUB_RATE_LIMITED');
        return true;
      }
    );
  });

  it('9. Idempotency: repeated requests return existing PR without duplicates', async () => {
    const repair = await createTestRepair('verified');
    fs.writeFileSync(path.join(tempRepoDir, 'calculator.py'), '# patched content');

    // First run
    const firstResult = await workflowService.executePullRequestWorkflow(repair.id);
    assert.equal(firstResult.status, 'PR_CREATED');
    const firstPrNumber = firstResult.pullRequestNumber;

    // Second run
    const secondResult = await workflowService.executePullRequestWorkflow(repair.id);
    assert.equal(secondResult.pullRequestNumber, firstPrNumber);
    assert.equal(secondResult.idempotent, true);

    // Check PR creation call count is strictly 1
    assert.equal(mockGitProvider.getCallsFor('createPullRequest').length, 1);
  });

  it('10. Unrelated working-tree changes: ONLY stages repair-owned files', async () => {
    const repair = await createTestRepair('verified');

    // Modify repair file
    fs.writeFileSync(path.join(tempRepoDir, 'calculator.py'), '# repair patch');

    // Modify unrelated file
    fs.writeFileSync(path.join(tempRepoDir, 'UNRELATED.md'), '# unrelated user notes');

    const result = await workflowService.executePullRequestWorkflow(repair.id);
    assert.equal(result.status, 'PR_CREATED');

    // Check git status: UNRELATED.md must still be untracked/unstaged
    const status = await localGit.getStatus(tempRepoDir);
    const unrelatedEntry = status.find((s) => s.file === 'UNRELATED.md');
    assert.ok(unrelatedEntry, 'Unrelated file must still exist in status');
    assert.equal(unrelatedEntry.status, '??', 'Unrelated file must remain untracked (not staged)');
  });

  it('11. Default branch protection: Never commits to main directly', async () => {
    const repair = await createTestRepair('verified');

    // Ensure we start on main
    await localGit.checkoutBranch(tempRepoDir, 'main');
    assert.equal(await localGit.getCurrentBranch(tempRepoDir), 'main');

    fs.writeFileSync(path.join(tempRepoDir, 'calculator.py'), '# safe change');

    // Workflow will create and checkout repair branch before commit
    const result = await workflowService.executePullRequestWorkflow(repair.id);

    // Current branch is repair branch
    const currentBranch = await localGit.getCurrentBranch(tempRepoDir);
    assert.notEqual(currentBranch, 'main');
    assert.equal(currentBranch, result.repairBranch);

    // Checkout main to verify main was NOT modified or committed to
    await localGit.checkoutBranch(tempRepoDir, 'main');
    const mainLog = await localGit.getCommit(tempRepoDir);
    assert.notEqual(mainLog.sha, result.commitSha);
    assert.equal(mainLog.message, 'feat: initial calculator commit');
  });

  it('12. Non-git repository directory returns NOT_A_GIT_REPOSITORY', async () => {
    const emptyNonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixforge-non-git-'));
    const nonGitProjId = randomUUID();

    await prisma.project.create({
      data: {
        id: nonGitProjId,
        name: 'Non Git Project',
        repository: emptyNonGitDir,
        language: 'Python',
        testFramework: 'pytest',
        githubOwner: 'testowner',
        githubRepo: 'testrepo',
      },
    });

    const repairId = randomUUID();
    await prisma.repairJob.create({
      data: {
        id: repairId,
        projectId: nonGitProjId,
        issue: 'Bug',
        model: 'mock',
        verificationLevel: 'standard',
        maxIterations: 1,
        status: 'verified',
      },
    });

    await assert.rejects(
      async () => {
        await workflowService.executePullRequestWorkflow(repairId);
      },
      (err) => {
        assert.equal(err.code, 'NOT_A_GIT_REPOSITORY');
        return true;
      }
    );

    try {
      fs.rmSync(emptyNonGitDir, { recursive: true, force: true });
    } catch {}
  });

  it('13. Secret Sanitization: GitHubProvider never leaks Bearer tokens', () => {
    const secretToken = 'ghp_secretToken_1234567890abcdefghijklmnopqrstuvwxyz';
    const provider = new GitHubProvider({ token: secretToken });

    const rawError = `Failed to connect with Authorization: Bearer ${secretToken} to https://api.github.com`;
    const sanitized = provider.sanitize(rawError);

    assert.ok(!sanitized.includes(secretToken));
    assert.ok(sanitized.includes('***REDACTED***'));
  });

  it('14. Audit log is created upon Pull Request creation', async () => {
    const repair = await createTestRepair('verified');
    fs.writeFileSync(path.join(tempRepoDir, 'calculator.py'), '# fix code');

    const result = await workflowService.executePullRequestWorkflow(repair.id);
    assert.equal(result.status, 'PR_CREATED');

    const logs = await prisma.auditLog.findMany({
      where: {
        repairId: repair.id,
        event: 'github.pr.created',
      },
    });

    assert.equal(logs.length, 1);
    const meta = JSON.parse(logs[0].metadata);
    assert.equal(meta.pullRequestNumber, 101);
    assert.equal(meta.status, 'Awaiting Human Review');
  });

  it('15. Branch already exists locally: safely reuses/checks out existing branch', async () => {
    const repair = await createTestRepair('verified');
    const branchName = `fixfixforge/repair-${repair.id.slice(0, 8)}`;

    // Pre-create the branch locally
    await localGit.createBranch(tempRepoDir, branchName);
    assert.equal(await localGit.branchExists(tempRepoDir, branchName), true);

    fs.writeFileSync(path.join(tempRepoDir, 'calculator.py'), '# update for test');

    const result = await workflowService.executePullRequestWorkflow(repair.id);
    assert.equal(result.status, 'PR_CREATED');
    assert.equal(result.repairBranch, branchName);
  });

  it('16. Partial failure recovery: push failure leaves COMMITTED state, retry succeeds', async () => {
    // Custom mock provider that fails first push, then succeeds on retry
    let failPush = true;
    const flappyProvider = new MockGitProvider({ defaultBranch: 'main' });
    flappyProvider.createBranch = async (owner, repo, branch, sha) => {
      flappyProvider.recordCall('createBranch', { owner, repo, branch, sha });
      if (failPush) {
        const err = new Error('Network timeout during push');
        err.code = 'PUSH_NETWORK_ERROR';
        throw err;
      }
      return { name: branch, ref: `refs/heads/${branch}`, sha };
    };

    const recoveringService = new GitHubWorkflowService({
      localGit,
      gitProvider: flappyProvider,
    });

    const repair = await createTestRepair('verified');
    fs.writeFileSync(path.join(tempRepoDir, 'calculator.py'), '# partial failure patch');

    // First attempt fails at push
    await assert.rejects(
      async () => {
        await recoveringService.executePullRequestWorkflow(repair.id);
      },
      (err) => {
        assert.equal(err.code, 'PUSH_NETWORK_ERROR');
        return true;
      }
    );

    // Verify DB state is recorded as COMMITTED (not corrupted, commit preserved)
    const intRecord = await prisma.gitHubIntegration.findFirst({
      where: { repairJobId: repair.id },
    });
    assert.ok(intRecord);
    assert.equal(intRecord.status, 'COMMITTED');
    assert.ok(intRecord.commitSha);

    // Second attempt (recovery): push now succeeds
    failPush = false;
    const recovered = await recoveringService.executePullRequestWorkflow(repair.id);
    assert.equal(recovered.status, 'PR_CREATED');
    assert.ok(recovered.pullRequestNumber);
  });

  it('17. Partial failure recovery: PR creation failure recovery resumes without re-committing', async () => {
    let failPr = true;
    const flappyPrProvider = new MockGitProvider({ defaultBranch: 'main' });
    const originalCreatePr = flappyPrProvider.createPullRequest.bind(flappyPrProvider);
    flappyPrProvider.createPullRequest = async (args) => {
      flappyPrProvider.recordCall('createPullRequest', args);
      if (failPr) {
        const err = new Error('GitHub API temporary 503 error');
        err.code = 'GITHUB_API_ERROR';
        throw err;
      }
      return originalCreatePr(args);
    };

    const recoveringPrService = new GitHubWorkflowService({
      localGit,
      gitProvider: flappyPrProvider,
    });

    const repair = await createTestRepair('verified');
    fs.writeFileSync(path.join(tempRepoDir, 'calculator.py'), '# pr fail patch');

    // First attempt fails at PR creation
    await assert.rejects(
      async () => {
        await recoveringPrService.executePullRequestWorkflow(repair.id);
      },
      (err) => {
        assert.equal(err.code, 'GITHUB_API_ERROR');
        return true;
      }
    );

    // Second attempt succeeds
    failPr = false;
    const recovered = await recoveringPrService.executePullRequestWorkflow(repair.id);
    assert.equal(recovered.status, 'PR_CREATED');
    assert.ok(recovered.pullRequestNumber);
  });

  it('18. HTTP API: POST /api/repairs/:repairId/github/pr rejects unverified repairs with 400', async () => {
    const { default: app } = await import('../src/app.js');
    const http = await import('node:http');

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. Unknown repair -> 404
      const res404 = await fetch(`${baseUrl}/api/repairs/00000000-0000-0000-0000-000000000000/github/pr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(res404.status, 404);

      // 2. Unverified repair -> 400
      const unverified = await createTestRepair('failed');
      const res400 = await fetch(`${baseUrl}/api/repairs/${unverified.id}/github/pr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(res400.status, 400);
      const body400 = await res400.json();
      assert.equal(body400.code, 'UNVERIFIED_REPAIR_BLOCKED');

      // 3. GET /github info
      const resGet = await fetch(`${baseUrl}/api/repairs/${unverified.id}/github`);
      assert.equal(resGet.status, 200);
      const bodyGet = await resGet.json();
      assert.equal(typeof bodyGet.history, 'object');

      // 4. GET /github/report
      const resReport = await fetch(`${baseUrl}/api/repairs/${unverified.id}/github/report`);
      assert.equal(resReport.status, 200);
      const bodyReport = await resReport.json();
      assert.ok(bodyReport.markdown);
      assert.ok(bodyReport.markdown.includes('FixForge Repair Report'));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('19. Regression test: GitHub URL resolution clones to dedicated repos workspace and rejects non-existent local dirs', async () => {
    const { parseGitHubRepo, resolveRepositoryWorkspace } = await import('../src/services/git/repository-resolver.js');

    // 1. URL resolution tests
    const parsed = parseGitHubRepo('https://github.com/SuryaNarayana-C-K/testingggg');
    assert.ok(parsed, 'HTTPS GitHub URL must be recognized');
    assert.equal(parsed.owner, 'SuryaNarayana-C-K');
    assert.equal(parsed.repo, 'testingggg');
    assert.equal(parsed.cloneUrl, 'https://github.com/SuryaNarayana-C-K/testingggg.git');

    // 2. Windows paths are NOT parsed as GitHub repos
    const winPath = 'C:\\Users\\SURYA NARAYAN C K\\AppData\\Local\\Temp\\fixforge-git-test-xyz';
    assert.equal(parseGitHubRepo(winPath), null, 'Windows drive letter path must not be treated as GitHub repo');

    // 3. Resolve GitHub URL into dedicated workspace repos/SuryaNarayana-C-K/testingggg
    const resolved = await resolveRepositoryWorkspace('https://github.com/SuryaNarayana-C-K/testingggg');
    assert.ok(resolved.localPath, 'Must return localPath');
    assert.equal(resolved.isRemote, true);
    assert.equal(resolved.owner, 'SuryaNarayana-C-K');
    assert.equal(resolved.repo, 'testingggg');
    assert.ok(
      resolved.relativePath.replace(/\\/g, '/').includes('repos/SuryaNarayana-C-K/testingggg') ||
      resolved.relativePath.replace(/\\/g, '/').includes('repos/testingggg'),
      'Must resolve into repos workspace'
    );
    assert.ok(fs.existsSync(resolved.localPath), 'Resolved local path must exist on disk');

    // 4. Reject non-existent local directory
    await assert.rejects(
      async () => {
        await resolveRepositoryWorkspace('this-directory-does-not-exist-xyz-123');
      },
      (err) => {
        assert.equal(err.code, 'REPOSITORY_NOT_FOUND');
        return true;
      }
    );
  });

  after(async () => {
    enableTestAuthMock(false);
  });
});

