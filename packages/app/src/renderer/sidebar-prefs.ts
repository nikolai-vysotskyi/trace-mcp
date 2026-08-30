/* sidebar-prefs.ts — sidebar geometry + the persistence of it (TRA-291).

   Width and collapsed state survive a relaunch (localStorage) and stay in sync
   across open windows: `storage` events cover same-process tabs, the existing
   `sync-sidebar-width` IPC covers separate BrowserWindows.

   Kept out of App.tsx so it is unit-testable without mounting the renderer. */

/** macOS NavigationSplitView sidebar: 220pt default, resizable 180–320. */
export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 320;
export const SIDEBAR_DEFAULT = 220;

export const SIDEBAR_WIDTH_KEY = 'trace-mcp-sidebar-width';
export const SIDEBAR_COLLAPSED_KEY = 'trace-mcp-sidebar-collapsed';

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT;
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(width)));
}

export function readSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (raw === null) return SIDEBAR_DEFAULT;
    return clampSidebarWidth(Number(raw));
  } catch {
    return SIDEBAR_DEFAULT;
  }
}

export function writeSidebarWidth(width: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clampSidebarWidth(width)));
  } catch {}
}

export function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {}
}

/**
 * Split a path into a truncatable directory part and the filename, which must
 * never be truncated.
 *
 * Splitting here rather than in CSS is what keeps the two parts independently
 * styleable in plain LTR. It replaced a `direction: rtl` truncation that
 * reordered a path's trailing punctuation under the bidi algorithm — that is
 * why `.idea/workspace.xml` rendered as `idea/workspace.xml.` and
 * `__external__/_root/php.synthetic` as `…l__/_root/php.synthetic__`.
 *
 * What a row actually shows is `name` followed by `parentDir()`, not `dir` —
 * see that function for why.
 */
export function splitPath(displayPath: string): { dir: string; name: string } {
  const idx = Math.max(displayPath.lastIndexOf('/'), displayPath.lastIndexOf('\\'));
  if (idx < 0) return { dir: '', name: displayPath };
  return { dir: displayPath.slice(0, idx + 1), name: displayPath.slice(idx + 1) };
}

/**
 * The location a file row shows *after* its filename: the last path segment
 * only, without separators.
 *
 * A sidebar row is 180–320px wide and a repo-relative path does not fit in it.
 * Putting the whole directory first cost up to 45% of the row and then spent
 * the remainder truncating the filename — the one token that identifies the
 * file — so `src/renderer/tabs/Settings.tsx` rendered as `src/render…Settings.t…`
 * (TRA-503). Quick open already showed the filename as the label and the
 * directory as the detail; this is the same order, and the leaf segment is the
 * part that distinguishes siblings (`types.ts` in `workspace/` from `types.ts`
 * in `tabs/`). Everything above the leaf stays in the row's tooltip.
 */
export function parentDir(displayPath: string): string {
  const { dir } = splitPath(displayPath);
  const segments = dir.split(/[/\\]/).filter(Boolean);
  return segments[segments.length - 1] ?? '';
}
