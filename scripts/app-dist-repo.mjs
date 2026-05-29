/**
 * Single source of truth for the GitHub repository that hosts the COMPILED
 * trace-mcp desktop app release assets (the mac/win zip + .exe + .sha256).
 *
 * The app SOURCE lives in a separate PRIVATE repository. Its CI builds the
 * binaries and publishes them to this PUBLIC distribution repo's Releases, so
 * the open-source core can fetch "the latest app" anonymously via the GitHub
 * Releases API (`GET /repos/<repo>/releases/latest`) — exactly as it did when
 * the app lived in the core repo, just pointed at the dist repo now.
 *
 * Both install paths in the core read this:
 *   - scripts/postinstall-app.mjs  (auto-update on `npm install -g trace-mcp`)
 *   - src/cli/install-app.ts       (`trace-mcp install-app` / first install)
 *
 * Override via the TRACE_MCP_APP_DIST_REPO env var (forks, staging, testing).
 * A malformed override is ignored in favour of the default.
 */

/**
 * Default public distribution repo (owner/name form).
 *
 * PHASE A (current): still points at the core repo, which is where the app
 * binaries live today — this keeps behaviour identical while the env override
 * mechanism is introduced, so it is safe to ship in any release.
 *
 * PHASE C (cutover): flip this to the dedicated public dist repo
 * (`nikolai-vysotskyi/trace-mcp-app-dist`) ONLY after that repo exists and has
 * a populated `releases/latest`. Until then, the env override can be used to
 * test against the dist repo without changing the shipped default.
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
