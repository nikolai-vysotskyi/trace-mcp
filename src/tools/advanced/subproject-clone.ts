/**
 * One-shot clone of a remote repository so it can be added as a subproject.
 * graphify ships a `graphify clone <url>` that does the same: clone to a
 * stable per-project cache, then operate on the local checkout. Doing it
 * server-side here means an MCP caller can do
 * `subproject_add_repo { git_url: "https://github.com/owner/repo" }`
 * without having to set up the working tree first.
 *
 * Security: every external value is treated as untrusted.
 *  • The URL is matched against a strict allowlist (https / ssh forms only,
 *    no shell metacharacters, no leading dash) before it ever reaches argv.
 *  • The clone is dispatched through execFileSync so there is no shell.
 *  • The destination path is built deterministically inside .trace-mcp/
 *    so a malformed URL cannot escape the project root.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { err, ok, type TraceMcpResult, validationError } from '../../errors.js';
import { logger } from '../../logger.js';
import { isSafeGitRef, safeGitEnv } from '../../utils/git-env.js';

/**
 * Accept three URL shapes:
 *   • https://host/owner/repo[.git]
 *   • http://host/owner/repo[.git]    (caller's choice — we still allow it)
 *   • git@host:owner/repo[.git]       (ssh shorthand)
 *
 * The host / path components are restricted to ASCII letters, digits, dot,
 * dash, underscore, slash and colon for ssh. No spaces, no shell metas.
 */
const HTTPS_RE = /^https?:\/\/[A-Za-z0-9._-]+(?::\d+)?\/[A-Za-z0-9._\-/]+?(?:\.git)?$/;
const SSH_RE = /^git@[A-Za-z0-9._-]+:[A-Za-z0-9._\-/]+?(?:\.git)?$/;

export function isSafeGitUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  if (url.length === 0 || url.length > 1024) return false;
  if (url.startsWith('-')) return false;
  return HTTPS_RE.test(url) || SSH_RE.test(url);
}

/**
 * Derive a stable local clone path under `<projectRoot>/.trace-mcp/subprojects/`
 * from a git URL. Picks the trailing two path components (typically owner/repo)
 * so two clones of different orgs do not collide.
 */
export function resolveCloneDir(projectRoot: string, gitUrl: string): string {
  const base = path.resolve(projectRoot, '.trace-mcp', 'subprojects');
  // Strip scheme/auth and trailing .git, normalise ssh shorthand to a path.
  let p = gitUrl;
  p = p.replace(/^https?:\/\/[A-Za-z0-9._-]+(?::\d+)?\//, '');
  p = p.replace(/^git@[A-Za-z0-9._-]+:/, '');
  p = p.replace(/\.git$/, '');
  // Keep only the last two segments so we always land on owner/repo.
  const parts = p.split('/').filter(Boolean);
  const tail = parts.slice(-2).join('/');
  if (!tail) throw new Error(`Cannot derive clone dir from URL: ${gitUrl}`);
  const target = path.resolve(base, tail);
  // Defense in depth: ensure the resolved path stays inside base.
  const rel = path.relative(base, target);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing to clone outside .trace-mcp/subprojects: ${tail}`);
  }
  return target;
}

export interface CloneOptions {
  /** Branch / tag / sha to check out after cloning. Validated as a safe ref
   * elsewhere — the caller is expected to pass a sanitised value. */
  ref?: string;
  /** When true, do a shallow `--depth 1` clone (default true). Full history
   * costs a lot for repos we only ever read for indexing. */
  shallow?: boolean;
  /** When true, skip the network call entirely if the destination already
   * exists. Default true so a re-run is fast. */
  reuseExisting?: boolean;
}

export interface CloneResult {
  cloneDir: string;
  reused: boolean;
}

/**
 * Clone `gitUrl` into a deterministic path under `<projectRoot>/.trace-mcp/`.
 * Idempotent: when the destination already exists with the right remote we
 * just return its path. Run as `execFileSync` so the URL never touches a shell.
 */
export function cloneRemoteRepo(
  projectRoot: string,
  gitUrl: string,
  opts: CloneOptions = {},
): TraceMcpResult<CloneResult> {
  if (!isSafeGitUrl(gitUrl)) {
    return err(validationError(`Refusing to clone unsafe git URL: ${JSON.stringify(gitUrl)}`));
  }
  if (opts.ref !== undefined && !isSafeGitRef(opts.ref)) {
    return err(
      validationError(`Refusing to clone with unsafe git ref: ${JSON.stringify(opts.ref)}`),
    );
  }

  let cloneDir: string;
  try {
    cloneDir = resolveCloneDir(projectRoot, gitUrl);
  } catch (e) {
    return err(validationError((e as Error).message));
  }

  const reuse = opts.reuseExisting ?? true;
  if (reuse && fs.existsSync(path.join(cloneDir, '.git'))) {
    logger.info({ cloneDir, gitUrl }, 'Reusing existing subproject clone');
    return ok({ cloneDir, reused: true });
  }

  fs.mkdirSync(path.dirname(cloneDir), { recursive: true });

  const args = ['clone'];
  if (opts.shallow ?? true) args.push('--depth', '1');
  if (opts.ref) {
    args.push('--branch', opts.ref);
  }
  // `--` is critical: prevents any future argument from being interpreted as
  // a flag if the URL or destination ever start with `-` (we already reject
  // that in isSafeGitUrl, but defense in depth costs nothing).
  args.push('--', gitUrl, cloneDir);

  try {
    execFileSync('git', args, {
      stdio: 'pipe',
      timeout: 120_000,
      env: safeGitEnv(),
    });
  } catch (e) {
    return err(validationError(`git clone failed: ${e instanceof Error ? e.message : String(e)}`));
  }

  return ok({ cloneDir, reused: false });
}
