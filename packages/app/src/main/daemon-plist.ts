/**
 * The LaunchAgent property list the app writes when it installs the daemon
 * (TRA-438).
 *
 * Its own file for one reason: `scripts/check-i18n.mjs` reads `<key>Label</key>`
 * as a JSX text node, and a plist is the one thing in `src/main` that is markup
 * without being prose. Keeping it here lets that check stay strict about
 * daemon-install.ts, which does carry user-facing text.
 *
 * The output MUST mirror `scripts/postinstall-control-plane.mjs::generatePlist`
 * byte for byte, including the version marker: a plist written by the npm
 * postinstall has to read as current to the app, or an npm-installed machine
 * gets its working LaunchAgent booted out and rewritten on every launch.
 */

import path from 'node:path';

/**
 * MUST match `PLIST_VERSION` in `scripts/postinstall-control-plane.mjs` and
 * `src/daemon/lifecycle.ts`. `tests/scripts/postinstall-plist-version.test.ts`
 * keeps them in sync.
 */
export const PLIST_VERSION = 4;
export const PLIST_LABEL = 'com.trace-mcp.server';
export const PLIST_MARKER = `trace-mcp plist v${PLIST_VERSION}`;
/** Seconds launchd waits after SIGTERM before SIGKILL (TRA-421). */
const PLIST_EXIT_TIMEOUT_SEC = 30;
export const DEFAULT_DAEMON_PORT = 3741;

export function generatePlist(shimPath: string, home: string, port = DEFAULT_DAEMON_PORT): string {
  const envPath = `${path.dirname(process.execPath)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- ${PLIST_MARKER} -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${shimPath}</string>
    <string>serve-http</string>
    <string>--port</string>
    <string>${port}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${envPath}</string>
    <key>TRACE_MCP_MANAGED_BY</key>
    <string>launchd</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ExitTimeOut</key>
  <integer>${PLIST_EXIT_TIMEOUT_SEC}</integer>
  <key>StandardOutPath</key>
  <string>${path.join(home, 'daemon.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(home, 'daemon.log')}</string>
  <key>WorkingDirectory</key>
  <string>${home}</string>
</dict>
</plist>
`;
}
