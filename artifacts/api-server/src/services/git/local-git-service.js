import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * LocalGitService - Handles safe local Git repository operations.
 * Strictly uses argument arrays with child_process.execFile (no shell strings).
 */
export class LocalGitService {
  constructor(options = {}) {
    this.gitPath = options.gitPath || 'git';
  }

  /**
   * Executes a safe git command using argument arrays.
   * @param {string} repoPath
   * @param {string[]} args
   * @returns {Promise<{ stdout: string, stderr: string }>}
   */
  async execGit(repoPath, args) {
    if (!repoPath || !fs.existsSync(repoPath)) {
      const err = new Error(`Repository path does not exist: ${repoPath}`);
      err.code = 'REPOSITORY_PATH_NOT_FOUND';
      throw err;
    }

    try {
      const { stdout, stderr } = await execFileAsync(this.gitPath, args, {
        cwd: repoPath,
        windowsHide: true,
        env: {
          ...process.env,
          // Prevent Git from asking for interactive passwords in CLI
          GIT_TERMINAL_PROMPT: '0',
        },
      });
      return { stdout: stdout.trim(), stderr: stderr.trim() };
    } catch (error) {
      const sanitizedMsg = (error.message || '').replace(/Bearer\s+[^\s]+/gi, 'Bearer ***');
      const err = new Error(`Git error: ${sanitizedMsg}`);
      err.code = error.code || 'GIT_EXECUTION_ERROR';
      err.stderr = (error.stderr || '').trim();
      err.stdout = (error.stdout || '').trim();
      throw err;
    }
  }

  /**
   * Check if a directory is a valid git repository.
   * @param {string} repoPath
   * @returns {Promise<boolean>}
   */
  async isGitRepo(repoPath) {
    try {
      const { stdout } = await this.execGit(repoPath, ['rev-parse', '--is-inside-work-tree']);
      return stdout === 'true';
    } catch {
      return false;
    }
  }

  /**
   * Get current checked out branch name.
   * @param {string} repoPath
   * @returns {Promise<string>}
   */
  async getCurrentBranch(repoPath) {
    const { stdout } = await this.execGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return stdout;
  }

  /**
   * Check if git user name and email are configured.
   * @param {string} repoPath
   * @returns {Promise<{ configured: boolean, name?: string, email?: string }>}
   */
  async checkGitIdentity(repoPath) {
    let name = '';
    let email = '';
    try {
      const resName = await this.execGit(repoPath, ['config', 'user.name']);
      name = resName.stdout;
    } catch {}

    try {
      const resEmail = await this.execGit(repoPath, ['config', 'user.email']);
      email = resEmail.stdout;
    } catch {}

    // Fallback to process.env if available
    name = name || process.env.GIT_AUTHOR_NAME || process.env.GIT_COMMITTER_NAME || '';
    email = email || process.env.GIT_AUTHOR_EMAIL || process.env.GIT_COMMITTER_EMAIL || '';

    const configured = Boolean(name && email);
    return { configured, name, email };
  }

  /**
   * Check if a local branch exists.
   * @param {string} repoPath
   * @param {string} branchName
   * @returns {Promise<boolean>}
   */
  async branchExists(repoPath, branchName) {
    try {
      await this.execGit(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a new branch.
   * @param {string} repoPath
   * @param {string} branchName
   * @param {string} [startPoint]
   * @returns {Promise<void>}
   */
  async createBranch(repoPath, branchName, startPoint) {
    const args = ['branch', branchName];
    if (startPoint) {
      args.push(startPoint);
    }
    await this.execGit(repoPath, args);
  }

  /**
   * Checkout an existing branch.
   * @param {string} repoPath
   * @param {string} branchName
   * @returns {Promise<void>}
   */
  async checkoutBranch(repoPath, branchName) {
    await this.execGit(repoPath, ['checkout', branchName]);
  }

  /**
   * Get porcelain status.
   * @param {string} repoPath
   * @returns {Promise<Array<{ status: string, file: string }>>}
   */
  async getStatus(repoPath) {
    const { stdout } = await this.execGit(repoPath, ['status', '--porcelain']);
    if (!stdout) return [];
    return stdout.split('\n').filter(Boolean).map((line) => {
      const status = line.slice(0, 2).trim();
      const file = line.slice(3).trim();
      return { status, file };
    });
  }

  /**
   * Get list of changed file paths relative to repo root.
   * @param {string} repoPath
   * @returns {Promise<string[]>}
   */
  async getChangedFiles(repoPath) {
    const status = await this.getStatus(repoPath);
    return status.map((s) => s.file);
  }

  /**
   * Get unified diff of specific files or whole repo.
   * @param {string} repoPath
   * @param {string[]} [filePaths]
   * @returns {Promise<string>}
   */
  async getDiff(repoPath, filePaths = []) {
    const args = ['diff'];
    if (filePaths.length > 0) {
      args.push('--', ...filePaths);
    }
    const { stdout } = await this.execGit(repoPath, args);
    return stdout;
  }

  /**
   * Stage ONLY specified files (protects unrelated user modifications).
   * @param {string} repoPath
   * @param {string[]} filePaths
   * @returns {Promise<void>}
   */
  async stageFiles(repoPath, filePaths) {
    if (!filePaths || filePaths.length === 0) {
      const err = new Error('No files specified to stage');
      err.code = 'NO_FILES_TO_STAGE';
      throw err;
    }
    // Normalize paths to relative forward-slash paths
    const normalized = filePaths.map((f) => f.replace(/\\/g, '/'));
    await this.execGit(repoPath, ['add', '--', ...normalized]);
  }

  /**
   * Create commit with message and optional author.
   * @param {string} repoPath
   * @param {string} message
   * @param {object} [author]
   * @returns {Promise<string>} Commit SHA
   */
  async createCommit(repoPath, message, author) {
    const args = ['commit', '-m', message];
    if (author && author.name && author.email) {
      args.push(`--author=${author.name} <${author.email}>`);
    }
    try {
      await this.execGit(repoPath, args);
    } catch (err) {
      const msg = `${err.stdout || ''} ${err.stderr || ''} ${err.message || ''}`.toLowerCase();
      if (msg.includes('nothing to commit') || msg.includes('working tree clean')) {
        const { stdout } = await this.execGit(repoPath, ['rev-parse', 'HEAD']);
        return stdout;
      }
      throw err;
    }
    const { stdout } = await this.execGit(repoPath, ['rev-parse', 'HEAD']);
    return stdout;
  }

  /**
   * Get commit details by SHA or HEAD.
   * @param {string} repoPath
   * @param {string} [commitSha='HEAD']
   * @returns {Promise<{ sha: string, message: string, author: string, date: string }>}
   */
  async getCommit(repoPath, commitSha = 'HEAD') {
    const { stdout } = await this.execGit(repoPath, [
      'log',
      '-1',
      '--format=%H%x00%B%x00%an <%ae>%x00%ad',
      commitSha,
    ]);
    const [sha, message, author, date] = stdout.split('\x00');
    return {
      sha: sha ? sha.trim() : '',
      message: message ? message.trim() : '',
      author: author ? author.trim() : '',
      date: date ? date.trim() : '',
    };
  }

  /**
   * Push branch to remote.
   * @param {string} repoPath
   * @param {string} remote
   * @param {string} branchName
   * @param {object} [options]
   * @returns {Promise<void>}
   */
  async pushBranch(repoPath, remote = 'origin', branchName, options = {}) {
    const args = ['push', remote, branchName];
    if (options.force) {
      args.push('--force-with-lease');
    }
    if (options.setUpstream) {
      args.push('--set-upstream');
    }
    await this.execGit(repoPath, args);
  }

  /**
   * Helper to initialize a repository (used for test fixtures).
   * @param {string} repoPath
   * @param {string} [defaultBranch='main']
   */
  async initRepo(repoPath, defaultBranch = 'main') {
    await this.execGit(repoPath, ['init', '-b', defaultBranch]);
    await this.execGit(repoPath, ['config', 'user.name', 'FixForge Test']);
    await this.execGit(repoPath, ['config', 'user.email', 'test@fixforge.dev']);
  }
}
