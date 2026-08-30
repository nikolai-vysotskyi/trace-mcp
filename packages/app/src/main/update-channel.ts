/**
 * Which self-update mechanism this platform is allowed to use.
 *
 *   - `electron-updater` (macOS and Windows): the packaged target plus its
 *     channel file (`latest-mac.yml` / `latest.yml`) published on the GitHub
 *     release. The updater downloads in the background and installs on quit or
 *     on an explicit restart.
 *   - `none` (Linux and anything else): no packaged target exists today.
 *
 * macOS used to run a second mechanism — an npm postinstall that downloaded the
 * release zip and swapped the `.app` bundle itself — because Squirrel.Mac
 * validates the replacement bundle's code signature and our builds were ad-hoc
 * signed. Builds are Developer ID signed and notarized since TRA-436, so the
 * real updater works and the bundle-swapping path is gone (TRA-437).
 *
 * See docs/development.md § "Desktop app update channels".
 */
export type UpdateChannel = 'electron-updater' | 'none';

export function updateChannelFor(platform: NodeJS.Platform): UpdateChannel {
  if (platform === 'darwin' || platform === 'win32') return 'electron-updater';
  return 'none';
}
