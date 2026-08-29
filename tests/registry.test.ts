import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { announceDbHolder } from '../src/db-holders.js';
import { EPHEMERAL_INDEX_DIR, ensureGlobalDirs, REGISTRY_PATH } from '../src/global.js';
import {
  findEphemeralProjects,
  findOverlapForNewRoot,
  findOverlappingProjects,
  findUnregisteredNestedRepos,
  getProject,
  listProjects,
  registerProject,
  resolveRegisteredAncestor,
  sweepEphemeralDbs,
} from '../src/registry.js';

let savedRegistry: string | null = null;

beforeEach(() => {
  ensureGlobalDirs();
  savedRegistry = fs.existsSync(REGISTRY_PATH) ? fs.readFileSync(REGISTRY_PATH, 'utf8') : null;
  // Start with empty registry for each test.
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify({ version: 1, projects: {} }, null, 2));
});

afterEach(() => {
  if (savedRegistry !== null) {
    fs.writeFileSync(REGISTRY_PATH, savedRegistry);
  } else {
    fs.rmSync(REGISTRY_PATH, { force: true });
  }
});

function makeTmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-resolve-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  return dir;
}

/** A path shaped like a one-shot Multica agent-run checkout (TRA-94). */
function makeEphemeralWorkdir(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-ephemeral-'));
  const dir = path.join(base, 'multica_workspaces_test.multica.ai', 'ws-123', 'run-456', 'workdir');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  return dir;
}

/**
 * Write a registry row for an ephemeral workdir the way versions before
 * TRA-396 did. `registerProject` no longer persists these at all, but field
 * registries are full of them and `findEphemeralProjects` is what drains them.
 */
function registerLegacyEphemeral(root: string, ageHours: number): void {
  const reg = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  reg.projects[root] = {
    name: path.basename(root),
    root,
    dbPath: path.join(os.tmpdir(), `${path.basename(root)}.db`),
    lastIndexed: null,
    addedAt: new Date(Date.now() - ageHours * 60 * 60 * 1000).toISOString(),
  };
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2));
}

function setAddedAt(root: string, iso: string): void {
  const reg = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  reg.projects[root].addedAt = iso;
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2));
}

describe('registry cache invalidation', () => {
  // TRA-326: loadRegistry caches by mtime. Windows' filesystem timestamp
  // granularity (~15ms) is coarse enough that two writes land on the same
  // mtime, which made a test see the previous test's registry. utimesSync
  // reproduces that collision deterministically on every platform.
  it('does not serve a stale registry when a rewrite reuses the same mtime', () => {
    const workdir = makeEphemeralWorkdir();
    registerLegacyEphemeral(workdir, 48);
    const sameTick = Math.floor(Date.now() / 1000) - 3600; // whole seconds: exact on every fs
    fs.utimesSync(REGISTRY_PATH, sameTick, sameTick);
    expect(findEphemeralProjects()).toHaveLength(1); // populates the cache

    fs.writeFileSync(REGISTRY_PATH, JSON.stringify({ version: 1, projects: {} }, null, 2));
    fs.utimesSync(REGISTRY_PATH, sameTick, sameTick);

    expect(findEphemeralProjects()).toEqual([]);
  });
});

describe('resolveRegisteredAncestor', () => {
  it('returns null when no registered project covers the path', () => {
    const dir = makeTmpRepo();
    expect(resolveRegisteredAncestor(dir)).toBeNull();
  });

  it('returns self when the path is registered directly', () => {
    const repo = makeTmpRepo();
    registerProject(repo);
    const entry = resolveRegisteredAncestor(repo);
    expect(entry?.root).toBe(repo);
  });

  it('returns the registered ancestor for a nested subdirectory', () => {
    const repo = makeTmpRepo();
    registerProject(repo);
    const nested = path.join(repo, 'packages', 'app');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'package.json'), '{}');

    const entry = resolveRegisteredAncestor(nested);
    expect(entry?.root).toBe(repo);
  });

  it('prefers an exact registered match over an ancestor', () => {
    const repo = makeTmpRepo();
    const nested = path.join(repo, 'packages', 'app');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'package.json'), '{}');
    registerProject(repo);
    registerProject(nested);

    const entry = resolveRegisteredAncestor(nested);
    expect(entry?.root).toBe(nested);
  });

  it('matches a multi-root parent that lists the path as a child', () => {
    const parent = makeTmpRepo();
    const child = path.join(parent, 'svc-a');
    fs.mkdirSync(child, { recursive: true });
    fs.writeFileSync(path.join(child, 'package.json'), '{}');
    registerProject(parent, { type: 'multi-root', children: [child] });

    const entry = resolveRegisteredAncestor(child);
    expect(entry?.root).toBe(parent);
  });
});

describe('findOverlappingProjects', () => {
  it('returns empty for disjoint roots', () => {
    registerProject(makeTmpRepo());
    registerProject(makeTmpRepo());
    expect(findOverlappingProjects()).toEqual([]);
  });

  it('reports a container registered alongside a nested project', () => {
    const container = makeTmpRepo();
    const nested = path.join(container, 'my-app');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'package.json'), '{}');
    registerProject(container);
    registerProject(nested);

    const overlaps = findOverlappingProjects();
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].ancestor.root).toBe(container);
    expect(overlaps[0].descendant.root).toBe(nested);
  });

  it('does not report declared multi-root children', () => {
    const parent = makeTmpRepo();
    const child = path.join(parent, 'svc-a');
    fs.mkdirSync(child, { recursive: true });
    fs.writeFileSync(path.join(child, 'package.json'), '{}');
    registerProject(parent, { type: 'multi-root', children: [child] });
    registerProject(child);

    expect(findOverlappingProjects()).toEqual([]);
  });

  it('does not confuse sibling dirs sharing a name prefix', () => {
    const base = makeTmpRepo();
    const a = path.join(base, 'app');
    const b = path.join(base, 'app-laravel');
    for (const d of [a, b]) {
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'package.json'), '{}');
    }
    registerProject(a);
    registerProject(b);

    expect(findOverlappingProjects()).toEqual([]);
  });
});

describe('findUnregisteredNestedRepos', () => {
  it('returns empty when a registered root has no nested repos', () => {
    registerProject(makeTmpRepo());
    expect(findUnregisteredNestedRepos()).toEqual([]);
  });

  it('flags a sibling repo with its own .git that was never registered', () => {
    const parent = makeTmpRepo();
    const sibling = path.join(parent, 'assetfeed-frontend');
    fs.mkdirSync(path.join(sibling, '.git'), { recursive: true });
    registerProject(parent);

    const found = findUnregisteredNestedRepos();
    expect(found).toHaveLength(1);
    expect(found[0].parentRoot).toBe(parent);
    expect(found[0].nestedRepoRoot).toBe(sibling);
  });

  it('does not flag a nested repo that is itself registered', () => {
    const parent = makeTmpRepo();
    const sibling = path.join(parent, 'assetfeed-frontend');
    fs.mkdirSync(path.join(sibling, '.git'), { recursive: true });
    registerProject(parent);
    registerProject(sibling);

    expect(findUnregisteredNestedRepos()).toEqual([]);
  });

  it('does not descend past a nested repo boundary (no nested-in-nested duplicates)', () => {
    const parent = makeTmpRepo();
    const sibling = path.join(parent, 'assetfeed-frontend');
    const innerGit = path.join(sibling, 'vendor', 'some-lib');
    fs.mkdirSync(path.join(sibling, '.git'), { recursive: true });
    fs.mkdirSync(path.join(innerGit, '.git'), { recursive: true });
    registerProject(parent);

    const found = findUnregisteredNestedRepos();
    expect(found).toHaveLength(1);
    expect(found[0].nestedRepoRoot).toBe(sibling);
  });

  it('skips node_modules/vendor/.git while scanning', () => {
    const parent = makeTmpRepo();
    fs.mkdirSync(path.join(parent, 'node_modules', 'some-pkg', '.git'), { recursive: true });
    registerProject(parent);

    expect(findUnregisteredNestedRepos()).toEqual([]);
  });
});

describe('findOverlapForNewRoot', () => {
  it('returns null for a disjoint candidate', () => {
    registerProject(makeTmpRepo());
    expect(findOverlapForNewRoot(makeTmpRepo())).toBeNull();
  });

  it('flags a candidate nested inside an already-registered project', () => {
    const container = makeTmpRepo();
    const nested = path.join(container, 'my-app');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'package.json'), '{}');
    registerProject(container);

    const overlap = findOverlapForNewRoot(nested);
    expect(overlap?.relation).toBe('existing_contains_candidate');
    expect(overlap?.existing.root).toBe(container);
  });

  it('flags a candidate that would contain an already-registered project', () => {
    const container = makeTmpRepo();
    const nested = path.join(container, 'my-app');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'package.json'), '{}');
    registerProject(nested);

    const overlap = findOverlapForNewRoot(container);
    expect(overlap?.relation).toBe('candidate_contains_existing');
    expect(overlap?.existing.root).toBe(nested);
  });

  it('does not flag a declared multi-root child', () => {
    const parent = makeTmpRepo();
    const child = path.join(parent, 'svc-a');
    fs.mkdirSync(child, { recursive: true });
    fs.writeFileSync(path.join(child, 'package.json'), '{}');
    registerProject(parent, { type: 'multi-root', children: [child] });

    expect(findOverlapForNewRoot(child)).toBeNull();
  });
});

describe('findEphemeralProjects', () => {
  it('ignores projects whose root does not look like a one-shot Multica workdir', () => {
    const repo = makeTmpRepo();
    registerProject(repo);
    setAddedAt(repo, new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString());

    expect(findEphemeralProjects()).toEqual([]);
  });

  it('ignores a freshly-added ephemeral workdir (younger than minAgeHours)', () => {
    const workdir = makeEphemeralWorkdir();
    registerLegacyEphemeral(workdir, 0);

    expect(findEphemeralProjects()).toEqual([]);
  });

  it('flags an ephemeral workdir older than the default 24h threshold', () => {
    const workdir = makeEphemeralWorkdir();
    registerLegacyEphemeral(workdir, 48);

    const found = findEphemeralProjects();
    expect(found).toHaveLength(1);
    expect(found[0].root).toBe(workdir);
    expect(found[0].ageHours).toBeGreaterThanOrEqual(48);
  });

  it('respects a custom minAgeHours threshold', () => {
    const workdir = makeEphemeralWorkdir();
    registerLegacyEphemeral(workdir, 2);

    expect(findEphemeralProjects(24)).toEqual([]);
    expect(findEphemeralProjects(1)).toHaveLength(1);
  });
});

// TRA-396: the checkout directory is never deleted by the runtime, so every
// presence-based signal reads an abandoned workdir as live. Not persisting it
// in the first place is what keeps it out of the daemon's reindex rotation —
// 77 of these on one machine pinned the daemon and timed out the app's
// metrics call.
describe('ephemeral workdirs are never persisted', () => {
  function registryProjects(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')).projects;
  }

  it('keeps a one-shot workdir out of registry.json', () => {
    const workdir = makeEphemeralWorkdir();
    registerProject(workdir);

    expect(registryProjects()).toEqual({});
    expect(listProjects()).toEqual([]);
  });

  it('still resolves the workdir for the run that registered it', () => {
    const workdir = makeEphemeralWorkdir();
    const entry = registerProject(workdir);

    expect(getProject(workdir)?.root).toBe(workdir);
    expect(resolveRegisteredAncestor(path.join(workdir, 'packages', 'app'))?.root).toBe(workdir);
    // Its DB lives in the ephemeral index dir so it stays collectable by age.
    expect(entry.dbPath.startsWith(EPHEMERAL_INDEX_DIR + path.sep)).toBe(true);
  });

  it('leaves the registry empty after a saturating burst of agent runs', () => {
    const workdirs = Array.from({ length: 80 }, () => makeEphemeralWorkdir());
    for (const w of workdirs) registerProject(w);

    // The daemon's cold start and its background rotation both read this map;
    // an empty one is what keeps a foreground metrics call off the queue.
    expect(Object.keys(registryProjects())).toHaveLength(0);
    expect(listProjects()).toEqual([]);
  });

  it('still persists a workdir-shaped root registered as an explicit multi-root', () => {
    const workdir = makeEphemeralWorkdir();
    const child = path.join(workdir, 'pkg');
    fs.mkdirSync(child, { recursive: true });
    registerProject(workdir, { type: 'multi-root', children: [child] });

    expect(Object.keys(registryProjects())).toEqual([workdir]);
  });

  it('does not report a non-persisted workdir as an eviction candidate', () => {
    const workdir = makeEphemeralWorkdir();
    registerProject(workdir);

    expect(findEphemeralProjects(0)).toEqual([]);
  });
});

// The case #487 missed: the checkout directory still exists, so nothing that
// keys on presence will ever reclaim its index. Age off the DB itself does.
describe('sweepEphemeralDbs', () => {
  function makeEphemeralDb(name: string, ageHours: number): string {
    fs.mkdirSync(EPHEMERAL_INDEX_DIR, { recursive: true });
    const db = path.join(EPHEMERAL_INDEX_DIR, `${name}.db`);
    fs.writeFileSync(db, 'x');
    const t = Date.now() / 1000 - ageHours * 3600;
    fs.utimesSync(db, t, t);
    return db;
  }

  afterEach(() => {
    fs.rmSync(EPHEMERAL_INDEX_DIR, { recursive: true, force: true });
  });

  it('deletes an abandoned DB whose checkout directory still exists', () => {
    const workdir = makeEphemeralWorkdir();
    expect(fs.existsSync(workdir)).toBe(true); // the runtime never cleans it up
    const db = makeEphemeralDb(`abandoned-${path.basename(path.dirname(workdir))}`, 48);

    expect(sweepEphemeralDbs(24)).toEqual([db]);
    expect(fs.existsSync(db)).toBe(false);
  });

  it('keeps a DB still inside the age window', () => {
    const db = makeEphemeralDb('recent', 2);

    expect(sweepEphemeralDbs(24)).toEqual([]);
    expect(fs.existsSync(db)).toBe(true);
  });

  it('keeps an old DB a live holder still has open', () => {
    const db = makeEphemeralDb('busy', 48);
    announceDbHolder(db, '/some/running/workdir');

    expect(sweepEphemeralDbs(24)).toEqual([]);
    expect(fs.existsSync(db)).toBe(true);
  });

  it('treats a fresh WAL sidecar as activity on an otherwise old DB', () => {
    const db = makeEphemeralDb('walwrites', 48);
    fs.writeFileSync(`${db}-wal`, 'x');

    expect(sweepEphemeralDbs(24)).toEqual([]);
    expect(fs.existsSync(db)).toBe(true);
  });

  it('deletes sidecars alongside the base DB', () => {
    const db = makeEphemeralDb('sidecars', 48);
    for (const suffix of ['-wal', '-shm']) {
      fs.writeFileSync(db + suffix, 'x');
      const t = Date.now() / 1000 - 48 * 3600;
      fs.utimesSync(db + suffix, t, t);
    }

    expect(sweepEphemeralDbs(24)).toEqual([db]);
    expect(fs.existsSync(`${db}-wal`)).toBe(false);
    expect(fs.existsSync(`${db}-shm`)).toBe(false);
  });
});
