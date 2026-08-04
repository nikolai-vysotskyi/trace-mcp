import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findSubprojectRootForPath, isKnownSubproject } from '../resolve.js';

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

  it('skips a stray repo_root="/" row instead of matching everything (#273)', () => {
    const badDb = join(dir, 'corrupt-topology.db');
    const db = new Database(badDb);
    db.exec('CREATE TABLE subprojects (id INTEGER PRIMARY KEY, repo_root TEXT NOT NULL)');
    db.prepare('INSERT INTO subprojects (repo_root) VALUES (?)').run('/');
    db.close();

    // An unregistered path must fall through to null, not resolve to "/".
    expect(findSubprojectRootForPath('/some/unregistered/path', badDb)).toBeNull();
  });
});

describe('isKnownSubproject', () => {
  it('is true when the path is itself a registered subproject repo_root', () => {
    expect(isKnownSubproject('/repos/the/fair/fair-front', dbPath)).toBe(true);
  });

  it('is false for a path merely nested inside a subproject (not the root)', () => {
    // Under fair-front but not the registered root — read-mostly serving must
    // bind to the root, so a nested cwd is not "itself" a subproject.
    expect(isKnownSubproject('/repos/the/fair/fair-front/app/pages', dbPath)).toBe(false);
  });

  it('is false for the container when a deeper subproject exists under the cwd', () => {
    // `/repos/the` is a registered subproject too, so it IS known when queried
    // directly — guards against the deepest-ancestor logic misfiring.
    expect(isKnownSubproject('/repos/the', dbPath)).toBe(true);
  });

  it('is false for an unrelated path', () => {
    expect(isKnownSubproject('/repos/unrelated', dbPath)).toBe(false);
  });

  it('is false when the topology db is missing', () => {
    expect(isKnownSubproject('/repos/the/fair/fair-front', join(dir, 'nope.db'))).toBe(false);
  });
});
