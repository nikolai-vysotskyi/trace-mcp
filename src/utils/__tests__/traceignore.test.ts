/**
 * Coverage for `TraceignoreMatcher.getSkippedTopLevelDirs` — the "which
 * folders got skipped" summary surfaced after indexing (#124 / TRA-68).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceignoreMatcher } from '../traceignore.js';

describe('TraceignoreMatcher.getSkippedTopLevelDirs', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'traceignore-test-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function mkdirs(...names: string[]): void {
    for (const name of names) fs.mkdirSync(path.join(root, name));
  }

  it('reports top-level dirs matched by default skip dirs', () => {
    mkdirs('src', 'node_modules', 'vendor');
    const matcher = new TraceignoreMatcher(root);
    expect(matcher.getSkippedTopLevelDirs(root)).toEqual(['node_modules', 'vendor']);
  });

  it('reports dirs added via config.directories', () => {
    mkdirs('src', 'k8s');
    const matcher = new TraceignoreMatcher(root, { directories: ['k8s'] });
    expect(matcher.getSkippedTopLevelDirs(root)).toEqual(['k8s']);
  });

  it('returns nothing when no top-level dir is skipped', () => {
    mkdirs('src', 'app');
    const matcher = new TraceignoreMatcher(root);
    expect(matcher.getSkippedTopLevelDirs(root)).toEqual([]);
  });
});
