/**
 * Single source of truth for the GitHub repository that hosts the COMPILED
 * trace-mcp desktop app release assets (the mac/win zip + .exe + .sha256).
 *
 * The app source lives in this same repo (`packages/app`). Its release CI
 * builds the binaries and publishes them as assets on this repo's own
 * Releases, so the core can fetch "the latest app" anonymously via the
 * GitHub Releases API (`GET /repos/<repo>/releases/latest`).
 *
 * Both install paths in the core read this:
 *   - scripts/postinstall-app.mjs  (auto-update on `npm install -g trace-mcp`)
 *   - src/cli/install-app.ts       (`trace-mcp install-app` / first install)
 *
 * Override via the TRACE_MCP_APP_DIST_REPO env var (forks, staging, testing).
 * A malformed override is ignored in favour of the default.
 */

/**
 * Default distribution repo (owner/name form).
 *
 * Override via TRACE_MCP_APP_DIST_REPO for forks/staging/testing.
 */
export const DEFAULT_APP_DIST_REPO = 'nikolai-vysotskyi/trace-mcp';

const REPO_SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * Resolve the `owner/name` slug of the app distribution repo.
 * @returns {string}
 */
export function getAppDistRepo() {
  const override = process.env.TRACE_MCP_APP_DIST_REPO?.trim();
  if (override && REPO_SLUG_RE.test(override)) return override;
  return DEFAULT_APP_DIST_REPO;
}
