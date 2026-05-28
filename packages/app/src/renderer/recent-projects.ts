/**
 * Recent projects — localStorage-backed list of the project roots the
 * user has opened. Lives in its own module so consumers (App.tsx and
 * the Indexes tab) can share it without forming an import cycle.
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
