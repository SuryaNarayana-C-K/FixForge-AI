import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Finds the workspace root directory (where package.json, examples/, artifacts/ reside).
 * @param {string} [startDir]
 * @returns {string}
 */
export function findWorkspaceRoot(startDir = __dirname) {
  let cur = path.resolve(startDir);
  while (cur !== path.dirname(cur)) {
    if (
      fs.existsSync(path.join(cur, 'package.json')) &&
      (fs.existsSync(path.join(cur, 'artifacts')) || fs.existsSync(path.join(cur, 'examples')))
    ) {
      return cur;
    }
    cur = path.dirname(cur);
  }
  // Fallback 4 levels up from this file
  return path.resolve(__dirname, '../../../../');
}

/**
 * Parses a GitHub repository string into owner, repo, and clean clone URL.
 * Handles HTTPS, HTTP, SSH, git://, domain prefix, or owner/repo shorthand.
 * @param {string} input
 * @returns {{ owner: string, repo: string, cloneUrl: string } | null}
 */
export function parseGitHubRepo(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim().replace(/\\/g, '/');

  // If input starts with a Windows drive letter (e.g. C:/) or absolute/relative path prefixes, it's definitely a local path
  if (/^[a-zA-Z]:\//i.test(trimmed) || /^\.?\.?\//.test(trimmed)) {
    return null;
  }

  // Explicit URL schemes or domain
  const isExplicitUrl = /^(https?:\/\/|git@|git:\/\/|github\.com)/i.test(trimmed);

  if (isExplicitUrl) {
    const urlMatch = trimmed.match(
      /(?:https?:\/\/|git:\/\/)?(?:[^@/\s]+@)?(?:www\.)?github\.com[:/]([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git|\/)?$/i
    );
    if (urlMatch) {
      const owner = urlMatch[1];
      const repo = urlMatch[2].replace(/\.git$/i, '');
      return {
        owner,
        repo,
        cloneUrl: `https://github.com/${owner}/${repo}.git`,
      };
    }
    return null;
  }

  // Shorthand owner/repo pattern (e.g. "SuryaNarayana-C-K/testingggg")
  // Must NOT contain multiple slashes
  const shorthandMatch = trimmed.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git|\/)?$/);
  if (shorthandMatch) {
    const owner = shorthandMatch[1];
    const repo = shorthandMatch[2].replace(/\.git$/i, '');

    // Prevent matching known local folder names as owner
    const reserved = [
      'examples', 'lib', 'artifacts', 'sandbox', 'node_modules', 'dist', 'src',
      'repos', 'database', 'scripts', 'app', 'tests', 'temp', 'tmp'
    ];
    if (reserved.includes(owner.toLowerCase())) {
      return null;
    }

    return {
      owner,
      repo,
      cloneUrl: `https://github.com/${owner}/${repo}.git`,
    };
  }

  return null;
}

/**
 * Check if a string is a remote repository URL or shorthand.
 * @param {string} input
 * @returns {boolean}
 */
export function isRemoteRepository(input) {
  return parseGitHubRepo(input) !== null;
}

/**
 * Resolves a repository (remote URL or local path) into a valid local workspace directory.
 * If remote, finds existing clone or clones into the workspace.
 *
 * @param {string} repoInput
 * @param {object} [options]
 * @param {string} [options.workspaceRoot]
 * @param {boolean} [options.allowClone=true]
 * @returns {Promise<{
 *   localPath: string,
 *   relativePath: string,
 *   isRemote: boolean,
 *   owner: string | null,
 *   repo: string | null,
 *   cloneUrl: string | null
 * }>}
 */
export async function resolveRepositoryWorkspace(repoInput, options = {}) {
  if (!repoInput || typeof repoInput !== 'string') {
    const err = new Error('Repository path or URL is required.');
    err.code = 'INVALID_REPOSITORY_INPUT';
    err.status = 400;
    throw err;
  }

  const raw = repoInput.trim();
  const workspaceRoot = options.workspaceRoot || findWorkspaceRoot();
  const parsedRemote = parseGitHubRepo(raw);

  if (parsedRemote) {
    const { owner, repo, cloneUrl } = parsedRemote;

    // Dedicated local workspace: repos/${owner}/${repo}
    const targetDir = path.join(workspaceRoot, 'repos', owner, repo);
    const legacyDir = path.join(workspaceRoot, 'repos', repo);

    // 1. Check if repo is already cloned in dedicated workspace repos/${owner}/${repo}
    if (fs.existsSync(targetDir) && fs.statSync(targetDir).isDirectory() && fs.readdirSync(targetDir).length > 0) {
      return {
        localPath: targetDir,
        relativePath: path.relative(workspaceRoot, targetDir).replace(/\\/g, '/'),
        isRemote: true,
        owner,
        repo,
        cloneUrl,
      };
    }

    // 2. Check if repo is already cloned in legacy repos/${repo}
    if (fs.existsSync(legacyDir) && fs.statSync(legacyDir).isDirectory() && fs.readdirSync(legacyDir).length > 0) {
      return {
        localPath: legacyDir,
        relativePath: path.relative(workspaceRoot, legacyDir).replace(/\\/g, '/'),
        isRemote: true,
        owner,
        repo,
        cloneUrl,
      };
    }

    // 3. Clone repository if allowed into dedicated local workspace using safe subprocess argument array
    if (options.allowClone !== false) {
      fs.mkdirSync(path.dirname(targetDir), { recursive: true });

      try {
        await execFileAsync('git', ['clone', cloneUrl, targetDir], {
          windowsHide: true,
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
          },
        });

        return {
          localPath: targetDir,
          relativePath: path.relative(workspaceRoot, targetDir).replace(/\\/g, '/'),
          isRemote: true,
          owner,
          repo,
          cloneUrl,
        };
      } catch (cloneErr) {
        const err = new Error(
          `Failed to clone repository from '${cloneUrl}': ${cloneErr.message || cloneErr}`
        );
        err.code = 'GIT_CLONE_FAILED';
        err.status = 502;
        err.details = cloneErr.stderr || cloneErr.message;
        throw err;
      }
    }

    const err = new Error(`Remote repository '${raw}' is not cloned locally.`);
    err.code = 'REPOSITORY_NOT_FOUND';
    err.status = 404;
    throw err;
  }

  // Local directory resolution
  // Handle absolute path
  if (path.isAbsolute(raw)) {
    if (fs.existsSync(raw) && fs.statSync(raw).isDirectory()) {
      return {
        localPath: raw,
        relativePath: path.relative(workspaceRoot, raw).replace(/\\/g, '/'),
        isRemote: false,
        owner: null,
        repo: path.basename(raw),
        cloneUrl: null,
      };
    }
    const err = new Error(`Local repository directory does not exist: ${raw}`);
    err.code = 'REPOSITORY_NOT_FOUND';
    err.status = 400;
    throw err;
  }

  // Handle relative paths from workspaceRoot or cwd
  const candidates = [
    path.resolve(workspaceRoot, raw),
    path.resolve(process.cwd(), raw),
    path.resolve(process.cwd(), '../..', raw),
  ];

  for (const cand of candidates) {
    if (fs.existsSync(cand) && fs.statSync(cand).isDirectory()) {
      return {
        localPath: cand,
        relativePath: path.relative(workspaceRoot, cand).replace(/\\/g, '/'),
        isRemote: false,
        owner: null,
        repo: path.basename(cand),
        cloneUrl: null,
      };
    }
  }

  const err = new Error(`Repository directory does not exist: ${raw}`);
  err.code = 'REPOSITORY_NOT_FOUND';
  err.status = 400;
  throw err;
}
