/**
 * GitProvider - Base interface / abstraction for Git hosting providers.
 * Decouples FixForge repair engine from specific Git hosting platforms.
 */
export class GitProvider {
  /**
   * Check if repository exists and retrieve info.
   * @param {string} owner
   * @param {string} repo
   * @returns {Promise<{ owner: string, repo: string, defaultBranch: string }>}
   */
  async getRepository(owner, repo) {
    throw new Error('getRepository must be implemented by subclass');
  }

  /**
   * Check if a remote branch exists.
   * @param {string} owner
   * @param {string} repo
   * @param {string} branchName
   * @returns {Promise<boolean>}
   */
  async branchExists(owner, repo, branchName) {
    throw new Error('branchExists must be implemented by subclass');
  }

  /**
   * Create a remote branch reference if needed.
   * @param {string} owner
   * @param {string} repo
   * @param {string} branchName
   * @param {string} baseSha
   * @returns {Promise<{ name: string, ref: string }>}
   */
  async createBranch(owner, repo, branchName, baseSha) {
    throw new Error('createBranch must be implemented by subclass');
  }

  /**
   * Find an existing pull request for a given head branch.
   * @param {string} owner
   * @param {string} repo
   * @param {string} headBranch
   * @param {string} baseBranch
   * @returns {Promise<{ number: number, url: string, title: string, state: string } | null>}
   */
  async findPullRequest(owner, repo, headBranch, baseBranch) {
    throw new Error('findPullRequest must be implemented by subclass');
  }

  /**
   * Create a new pull request.
   * @param {object} params
   * @param {string} params.owner
   * @param {string} params.repo
   * @param {string} params.title
   * @param {string} params.body
   * @param {string} params.head
   * @param {string} params.base
   * @returns {Promise<{ number: number, url: string, title: string, state: string }>}
   */
  async createPullRequest(params) {
    throw new Error('createPullRequest must be implemented by subclass');
  }
}
