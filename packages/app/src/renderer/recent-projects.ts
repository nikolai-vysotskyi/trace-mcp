/**
 * Recent projects — localStorage-backed list of the project roots the
 * user has opened. Lives in its own module so consumers (App.tsx and
 * the Workspace tab) can share it without forming an import cycle.
 */

const RECENT_KEY = 'trace-mcp:recent-projects';
const MAX_RECENT = 8;

export function getRecentProjects(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
  } catch {
    return [];
  }
}

export function addRecentProject(root: string): void {
  const recent = getRecentProjects().filter((r) => r !== root);
  recent.unshift(root);
  localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, MAX_RECENT)));
}

export function removeRecentProject(root: string): void {
  const recent = getRecentProjects().filter((r) => r !== root);
  localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
}

/**
 * Disambiguates project roots that share a basename (TRA-1058) — a project
 * name is only the last path segment, and two different checkouts (or two
 * agent workdirs) regularly share one, e.g. multiple `.../<task-id>/workdir`.
 * Grows each colliding label one more parent segment at a time, the way
 * Finder and IDE tabs do, until every label in the set is unique.
 * Returns one label per input root, in order, `parent / … / name` joined.
 */
export function disambiguateProjectLabels(roots: string[]): string[] {
  const segsOf = (r: string) => r.split(/[/\\]/).filter(Boolean);
  const allSegs = roots.map(segsOf);
  const labelSegs = allSegs.map((segs) => segs.slice(-1));

  for (;;) {
    const joined = labelSegs.map((segs) => segs.join(' / '));
    const counts = new Map<string, number>();
    for (const s of joined) counts.set(s, (counts.get(s) ?? 0) + 1);

    let grew = false;
    joined.forEach((s, i) => {
      if ((counts.get(s) ?? 0) <= 1) return;
      const segs = allSegs[i];
      if (labelSegs[i].length >= segs.length) return; // out of parent segments
      labelSegs[i] = segs.slice(-(labelSegs[i].length + 1));
      grew = true;
    });
    if (!grew) break;
  }

  return labelSegs.map((segs) => segs.join(' / '));
}
