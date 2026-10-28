import { GitProvider } from './git-provider.js';

/**
 * MockGitProvider - In-memory deterministic GitProvider for testing.
 * Records all invocations in `calls` array for assertion/spy testing.
 * Simulates GitHub behavior without requiring network requests or credentials.
 */
export class MockGitProvider extends GitProvider {
  constructor(options = {}) {
    super();
    this.options = options;
    this.calls = [];
    this.branches = new Set(options.initialBranches || ['main', 'master']);
    this.pullRequests = [...(options.initialPullRequests || [])];
    this.nextPrNumber = options.initialPrNumber || 42;

    // Simulation triggers
    this.shouldFailAuth = Boolean(options.shouldFailAuth);
    this.shouldRateLimit = Boolean(options.shouldRateLimit);
    this.shouldFailRepoNotFound = Boolean(options.shouldFailRepoNotFound);
    this.shouldFailValidation = Boolean(options.shouldFailValidation);
  }

  recordCall(method, args) {
    this.calls.push({ method, args, timestamp: new Date().toISOString() });
  }

  getCallsFor(method) {
    return this.calls.filter((c) => c.method === method);
  }

  resetCalls() {
    this.calls = [];
  }

  async getRepository(owner, repo) {
    this.recordCall('getRepository', { owner, repo });
    if (this.shouldFailAuth) {
      const err = new Error('Bad credentials');
      err.code = 'GITHUB_AUTH_FAILED';
      err.status = 401;
      throw err;
    }
    if (this.shouldRateLimit) {
      const err = new Error('API rate limit exceeded');
      err.code = 'GITHUB_RATE_LIMITED';
      err.status = 429;
      throw err;
    }
    if (this.shouldFailRepoNotFound) {
      const err = new Error(`Repository ${owner}/${repo} not found`);
      err.code = 'GITHUB_REPOSITORY_NOT_FOUND';
      err.status = 404;
      throw err;
    }

    return {
      owner,
      repo,
      defaultBranch: this.options.defaultBranch || 'main',
      htmlUrl: `https://github.com/${owner}/${repo}`,
      private: false,
    };
  }

  async branchExists(owner, repo, branchName) {
    this.recordCall('branchExists', { owner, repo, branchName });
    if (this.shouldFailAuth) {
      const err = new Error('Bad credentials');
      err.code = 'GITHUB_AUTH_FAILED';
      throw err;
    }
    return this.branches.has(branchName);
  }

  async createBranch(owner, repo, branchName, baseSha) {
    this.recordCall('createBranch', { owner, repo, branchName, baseSha });
    if (this.shouldFailAuth) {
      const err = new Error('Bad credentials');
      err.code = 'GITHUB_AUTH_FAILED';
      throw err;
    }
    this.branches.add(branchName);
    return {
      name: branchName,
      ref: `refs/heads/${branchName}`,
      sha: baseSha || 'mock-base-sha-123456',
    };
  }

  async findPullRequest(owner, repo, headBranch, baseBranch) {
    this.recordCall('findPullRequest', { owner, repo, headBranch, baseBranch });
    const match = this.pullRequests.find(
      (pr) => pr.head === headBranch && (!baseBranch || pr.base === baseBranch)
    );
    if (match) {
      return {
        number: match.number,
        url: match.url,
        title: match.title,
        state: match.state || 'open',
      };
    }
    return null;
  }

  async createPullRequest({ owner, repo, title, body, head, base }) {
    this.recordCall('createPullRequest', { owner, repo, title, body, head, base });
    if (this.shouldFailAuth) {
      const err = new Error('Bad credentials');
      err.code = 'GITHUB_AUTH_FAILED';
      throw err;
    }
    if (this.shouldRateLimit) {
      const err = new Error('API rate limit exceeded');
      err.code = 'GITHUB_RATE_LIMITED';
      err.status = 429;
      throw err;
    }

    // Check if PR for this head branch already exists in our mock
    const existing = await this.findPullRequest(owner, repo, head, base);
    if (existing) {
      return existing;
    }

    const prNumber = this.nextPrNumber++;
    const prUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}`;
    const newPr = {
      number: prNumber,
      url: prUrl,
      title,
      body,
      head,
      base,
      state: 'open',
    };
    this.pullRequests.push(newPr);
    return {
      number: newPr.number,
      url: newPr.url,
      title: newPr.title,
      state: newPr.state,
    };
  }
}
