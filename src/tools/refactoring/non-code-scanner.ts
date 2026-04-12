/**
 * Non-code file scanner — scans YAML, JSON, TOML, env files, Dockerfiles, etc.
 * for mentions of a renamed symbol. Returns suggestions (not auto-applied edits).
 */

import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import type { NonCodeMention } from './shared.js';
import { buildRenameRegex, SKIP_DIRS } from './shared.js';

const NON_CODE_PATTERNS = [
  '**/*.yaml', '**/*.yml',
  '**/*.json',
  '**/*.toml',
  '**/*.env', '**/.env*',
  '**/*.ini', '**/*.cfg',
  '**/Dockerfile', '**/Dockerfile.*',
  '**/docker-compose*.yml', '**/docker-compose*.yaml',
  '**/Makefile', '**/makefile',
  '**/*.conf',
  '**/*.properties',
];

// Skip patterns that are too noisy or auto-generated
const SKIP_FILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'composer.lock',
  'Pipfile.lock',
  'Cargo.lock',
  'go.sum',
]);

/**
 * Scan non-code files for mentions of `oldName`.
 * Returns suggestions with the line and what it would look like after replacement.
 */
export function scanNonCodeFiles(
  projectRoot: string,
  oldName: string,
  newName: string,
): NonCodeMention[] {
  const mentions: NonCodeMention[] = [];
  const regex = buildRenameRegex(oldName);

  let files: string[];
  try {
    files = fg.sync(NON_CODE_PATTERNS, {
      cwd: projectRoot,
      ignore: SKIP_DIRS.map((d) => `**/${d}/**`),
      onlyFiles: true,
      absolute: false,
    });
  } catch {
    return mentions;
  }

  // Filter out lock files and very large files
  files = files.filter((f) => !SKIP_FILES.has(path.basename(f)));

  for (const relPath of files) {
    const absPath = path.resolve(projectRoot, relPath);
    let content: string;
    try {
      const stat = fs.statSync(absPath);
      // Skip files > 1MB
      if (stat.size > 1_000_000) continue;
      content = fs.readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      regex.lastIndex = 0;
      if (regex.test(lines[i])) {
        regex.lastIndex = 0;
        const suggestion = lines[i].replace(regex, newName);
        if (suggestion !== lines[i]) {
          mentions.push({
            file: relPath,
            line: i + 1,
            text: lines[i].trimStart(),
            suggestion: suggestion.trimStart(),
          });
        }
        regex.lastIndex = 0;
      }
    }
  }

  return mentions;
}
