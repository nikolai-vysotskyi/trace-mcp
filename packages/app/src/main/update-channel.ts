/**
 * Which self-update mechanism this platform is allowed to use.
 *
 * The two mechanisms are mutually exclusive by construction — exactly one
 * channel per platform, decided here and nowhere else:
 *
 *   - `zip-staged` (macOS): npm postinstall (`scripts/postinstall-app.mjs`)
 *     drops a verified zip next to the .app and a detached helper swaps the
 *     bundle on exit. Historically macOS *could* not use electron-updater:
 *     Squirrel.Mac validates the replacement bundle's code signature and we
 *     shipped ad-hoc signed (`Signature=adhoc`, `TeamIdentifier=not set`).
 *     Builds are Developer ID signed and notarized since 2026-08-29 (TRA-436),
 *     so that blocker is gone — but the channel stays here until the unsigned
 *     builds already installed in the field have aged out, because flipping it
 *     means publishing `latest-mac.yml`, which those builds must never see.
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
