import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface GuessedProject {
  path: string;
  name: string;
}

const PROJECT_MARKERS = [
  'package.json',
  '.git',
  'Cargo.toml',
  'pyproject.toml',
  'requirements.txt',
  'go.mod',
  'composer.json',
  'Gemfile',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  '.trace-mcp.json',
];

/**
 * Searches common development workspaces on the user's machine to propose a sensible
 * default project for the first-run onboarding wizard.
 */
export function guessFirstProject(customHome?: string): GuessedProject | null {
  const home = customHome ?? os.homedir();
  const searchDirs = [
    path.join(home, 'Projects'),
    path.join(home, 'Developer'),
    path.join(home, 'Development'),
    path.join(home, 'workspace'),
    path.join(home, 'workspaces'),
    path.join(home, 'code'),
    path.join(home, 'src'),
    path.join(home, 'Documents', 'GitHub'),
    path.join(home, 'Documents', 'Projects'),
    path.join(home, 'Desktop'),
  ];

  let bestMatch: { path: string; name: string; mtimeMs: number } | null = null;

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidatePath = path.join(dir, entry.name);
        try {
          const hasMarker = PROJECT_MARKERS.some((marker) =>
            fs.existsSync(path.join(candidatePath, marker)),
          );
          if (hasMarker) {
            const stat = fs.statSync(candidatePath);
            if (!bestMatch || stat.mtimeMs > bestMatch.mtimeMs) {
              bestMatch = {
                path: candidatePath,
                name: entry.name,
                mtimeMs: stat.mtimeMs,
              };
            }
          }
        } catch {
          // ignore unreadable subfolder
        }
      }
    } catch {
      // ignore unreadable searchDir
    }
  }

  if (bestMatch) {
    return { path: bestMatch.path, name: bestMatch.name };
  }
  return null;
}
