/**
 * Pins the invariant the POST /api/projects bare-container guard relies on
 * (cli.ts): a directory that merely CONTAINS repositories — no manifest /
 * VCS marker of its own — is NOT a project root, so it must not be
 * auto-registered (that pulls every nested repo into one giant blob and
 * starves the daemon, #209). A directory with its own marker IS a project.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasRootMarkers } from '../project-root.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'root-markers-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('hasRootMarkers (bare-container guard basis)', () => {
  it('is false for a bare container of repos (no marker of its own)', () => {
    // Simulate ~/PhpstormProjects: holds child repos but has no top-level manifest.
    mkdirSync(join(dir, 'repo-a'));
    writeFileSync(join(dir, 'repo-a', 'package.json'), '{}');
    mkdirSync(join(dir, 'repo-b'));
    writeFileSync(join(dir, 'repo-b', 'go.mod'), 'module b\n');

    expect(hasRootMarkers(dir)).toBe(false);
  });

  it('is true for a real project root (has its own package.json)', () => {
    writeFileSync(join(dir, 'package.json'), '{"name":"x"}');
    expect(hasRootMarkers(dir)).toBe(true);
  });
});
