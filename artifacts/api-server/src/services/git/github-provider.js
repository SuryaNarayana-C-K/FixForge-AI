import { GitProvider } from './git-provider.js';

/**
 * GitHubProvider - Official GitHub REST API implementation of GitProvider.
 * Interacts with https://api.github.com using standard fetch.
 * Strictly avoids logging or exposing secrets / GITHUB_TOKEN.
 */
export class GitHubProvider extends GitProvider {
  /**
   * @param {object} [options]
   * @param {string} [options.token] - GitHub Personal Access Token (defaults to process.env.GITHUB_TOKEN)
   * @param {string} [options.baseUrl] - Base API URL (defaults to https://api.github.com)
   */
  constructor(options = {}) {
    super();
    this.token = options.token || process.env.GITHUB_TOKEN || '';
    this.baseUrl = options.baseUrl || 'https://api.github.com';
  }

  /**
   * Sanitizes any potential secrets from error messages or logs.
   * @param {string} str
   * @returns {string}
   */
  sanitize(str) {
    if (!str || typeof str !== 'string') return str;
    let sanitized = str;
    if (this.token) {
      sanitized = sanitized.replaceAll(this.token, '***REDACTED***');
    }
    sanitized = sanitized.replace(/Bearer\s+[A-Za-z0-9_.-]+/gi, 'Bearer ***REDACTED***');
    sanitized = sanitized.replace(/token\s+[A-Za-z0-9_.-]+/gi, 'token ***REDACTED***');
    return sanitized;
  }

  /**
   * Safe fetch to GitHub API with error handling and sanitization.
   * @private
   */
  async _request(endpoint, options = {}) {
    if (!this.token) {
      const err = new Error('GITHUB_TOKEN is missing or not configured');
      err.code = 'GITHUB_TOKEN_MISSING';
      throw err;
    }

    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${this.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'FixForge-M6-Agent',
      ...(options.headers || {}),
    };

    let res;
    try {
      res = await fetch(url, {
        ...options,
        headers,
      });
    } catch (networkErr) {
      const err = new Error(this.sanitize(`GitHub network error: ${networkErr.message}`));
      err.code = 'GITHUB_NETWORK_ERROR';
      throw err;
    }

    // Rate limit check
    const rateLimitRemaining = res.headers.get('x-ratelimit-remaining');
    if (res.status === 403 && rateLimitRemaining === '0') {
      const resetTime = res.headers.get('x-ratelimit-reset');
      const err = new Error(`GitHub API rate limit exceeded. Resets at ${resetTime || 'unknown'}`);
      err.code = 'GITHUB_RATE_LIMITED';
      err.status = 429;
      throw err;
    }

    if (!res.ok) {
      let errorBody = {};
      try {
        errorBody = await res.json();
      } catch {
        errorBody = { message: res.statusText };
      }

      const safeMessage = this.sanitize(errorBody.message || res.statusText);
      const err = new Error(`GitHub API error (${res.status}): ${safeMessage}`);
      err.status = res.status;
      err.details = errorBody;

      if (res.status === 401 || (res.status === 403 && safeMessage.toLowerCase().includes('bad credentials'))) {
        err.code = 'GITHUB_AUTH_FAILED';
      } else if (res.status === 404) {
        err.code = 'GITHUB_REPOSITORY_NOT_FOUND';
      } else if (res.status === 422) {
        err.code = 'GITHUB_VALIDATION_FAILED';
      } else {
        err.code = 'GITHUB_API_ERROR';
      }
      throw err;
    }

    if (res.status === 204) {
      return null;
    }

    return await res.json();
  }

  async getRepository(owner, repo) {
    const data = await this._request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
    return {
      owner: data.owner?.login || owner,
      repo: data.name || repo,
      defaultBranch: data.default_branch || 'main',
      htmlUrl: data.html_url,
      private: Boolean(data.private),
    };
  }

  async branchExists(owner, repo, branchName) {
    try {
      await this._request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(branchName)}`);
      return true;
    } catch (err) {
      if (err.status === 404 || err.code === 'GITHUB_REPOSITORY_NOT_FOUND') {
        return false;
      }
      throw err;
    }
  }

  async createBranch(owner, repo, branchName, baseSha) {
    const data = await this._request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ref: `refs/heads/${branchName}`,
        sha: baseSha,
      }),
    });
    return {
      name: branchName,
      ref: data.ref,
      sha: data.object?.sha,
    };
  }

  async findPullRequest(owner, repo, headBranch, baseBranch) {
    // GitHub API allows filtering PRs by head (format: 'owner:branch' or 'branch')
    const query = new URLSearchParams({
      head: `${owner}:${headBranch}`,
      state: 'open',
    });
    const prs = await this._request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?${query.toString()}`);
    if (Array.isArray(prs) && prs.length > 0) {
      const match = prs[0];
      return {
        number: match.number,
        url: match.html_url,
        title: match.title,
        state: match.state,
      };
    }
    return null;
  }

  async createPullRequest({ owner, repo, title, body, head, base }) {
    try {
      const data = await this._request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          body,
          head,
          base,
        }),
      });

      return {
        number: data.number,
        url: data.html_url,
        title: data.title,
        state: data.state,
      };
    } catch (err) {
      // Check if PR already exists (GitHub returns 422 with message containing 'A pull request already exists')
      if (err.status === 422 && err.details?.errors) {
        const alreadyExists = err.details.errors.some((e) =>
          typeof e.message === 'string' && e.message.toLowerCase().includes('already exists')
        );
        if (alreadyExists) {
          const existing = await this.findPullRequest(owner, repo, head, base);
          if (existing) return existing;
        }
      }
      throw err;
    }
  }
}
