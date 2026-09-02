import type { AppUpdater } from 'electron-updater';

/**
 * electron-updater's dynamic-import interop sometimes lands the named
 * `autoUpdater` export under `.default` instead of on the module namespace
 * directly (bundler-dependent). Missing that shape used to throw
 * `Cannot set properties of undefined (setting 'autoDownload')` deep inside
 * the update flow instead of here, at the one place that actually knows what
 * shape it expected (TRA-687, fixed by #707).
 */
export function resolveAutoUpdaterExport(mod: {
  autoUpdater?: AppUpdater;
  default?: { autoUpdater?: AppUpdater };
}): AppUpdater {
  const autoUpdater = mod.autoUpdater ?? mod.default?.autoUpdater;
  if (!autoUpdater) {
    throw new Error('electron-updater did not export autoUpdater');
  }
  return autoUpdater;
}
