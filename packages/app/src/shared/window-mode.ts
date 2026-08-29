/**
 * Who gets a Dock icon, and who runs as a background (accessory) process.
 *
 * macOS follows an app activation to the Space that app's window lives on, so
 * any run that becomes the active application drags whoever is at the keyboard
 * out of what they were in — out of a full-screen app, onto another desktop.
 * A shipped build is a real app and must keep its Dock icon and ⌘-Tab entry.
 * An unpackaged build is a development or agent-harness run, and those happen
 * on a machine somebody else is using, so they default to accessory.
 *
 * `TRACE_MCP_WINDOW_MODE=visible` is the opt-out: it asks for a normal app with
 * a Dock icon and ⌘-Tab, which is what a human debugging the dev build wants.
 * `hidden` forces accessory even in a packaged build, for capture runs against
 * the shipped artifact.
 */
export type WindowMode = 'hidden' | 'visible' | undefined;

export function parseWindowMode(raw: string | undefined): WindowMode {
  return raw === 'hidden' || raw === 'visible' ? raw : undefined;
}

export function shouldRunAsAccessory(mode: WindowMode, isPackaged: boolean): boolean {
  if (mode === 'hidden') return true;
  if (mode === 'visible') return false;
  return !isPackaged;
}
