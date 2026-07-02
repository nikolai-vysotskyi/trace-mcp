import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findSubprojectRootForPath } from '../resolve.js';

/**
 * findSubprojectRootForPath picks the DEEPEST registered subproject repo_root
 * that is an ancestor-or-self of a session cwd. This is what lets a session in
 * `the/fair/fair-front` bind to fair-front's own scoped index instead of the
 * `the` container blob (#209 — "ругается на зонтик").
 */
let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'subproj-resolve-'));
  dbPath = join(dir, 'topology.db');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE subprojects (id INTEGER PRIMARY KEY, repo_root TEXT NOT NULL)');
  const ins = db.prepare('INSERT INTO subprojects (repo_root) VALUES (?)');
  ins.run('/repos/the');
  ins.run('/repos/the/fair/fair-front');
  ins.run('/repos/the/thewed/thewed-laravel');
  ins.run('/repos/other');
  db.close();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('findSubprojectRootForPath', () => {
  it('returns the deepest subproject that is an ancestor of the cwd', () => {
    // A file deep inside fair-front → the fair-front subproject, NOT `the`.
    expect(
      findSubprojectRootForPath('/repos/the/fair/fair-front/app/pages/index.vue', dbPath),
    ).toBe('/repos/the/fair/fair-front');
  });

  it('returns the repo_root itself when cwd equals it', () => {
    expect(findSubprojectRootForPath('/repos/the/fair/fair-front', dbPath)).toBe(
      '/repos/the/fair/fair-front',
    );
  });

  it('falls back to the container subproject when no deeper one matches', () => {
    // Under `the` but not under any registered nested subproject.
    expect(findSubprojectRootForPath('/repos/the/some-other-dir/x', dbPath)).toBe('/repos/the');
  });

  it('returns null when no subproject covers the path', () => {
    expect(findSubprojectRootForPath('/repos/unrelated/pkg', dbPath)).toBeNull();
  });

  it('does not match a sibling whose name is a string prefix (path-boundary safe)', () => {
    // `/repos/the-x` must NOT match repo_root `/repos/the` (prefix, not ancestor).
    expect(findSubprojectRootForPath('/repos/the-x/src', dbPath)).toBeNull();
  });

  it('returns null (best-effort) when the topology db is missing', () => {
    expect(
      findSubprojectRootForPath('/repos/the/fair/fair-front', join(dir, 'nope.db')),
    ).toBeNull();
  });
});
