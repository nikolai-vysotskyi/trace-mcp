/**
 * Which self-update mechanism this platform is allowed to use.
 *
 * The two mechanisms are mutually exclusive by construction — exactly one
 * channel per platform, decided here and nowhere else:
 *
 *   - `zip-staged` (macOS): npm postinstall (`scripts/postinstall-app.mjs`)
 *     drops a verified zip next to the .app and a detached helper swaps the
 *     bundle on exit. macOS cannot use electron-updater: Squirrel.Mac
 *     validates the replacement bundle's code signature and we ship ad-hoc
 *     signed (`Signature=adhoc`, `TeamIdentifier=not set`), which would
 *     require a paid Apple Developer ID.
 *   - `electron-updater` (Windows): NSIS + `latest.yml` published on the
 *     GitHub release. Windows has no signature requirement for the swap, so
 *     the real thing works unsigned.
 *   - `none` (Linux and anything else): no packaged target exists today.
 *
 * See docs/development.md § "Desktop app update channels".
 */
export type UpdateChannel = 'zip-staged' | 'electron-updater' | 'none';

export function updateChannelFor(platform: NodeJS.Platform): UpdateChannel {
  if (platform === 'darwin') return 'zip-staged';
  if (platform === 'win32') return 'electron-updater';
  return 'none';
}
