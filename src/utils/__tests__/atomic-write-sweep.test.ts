/**
 * TRA-702 item 3: twelve orphaned `.daemon.pid.tmp.*` / `.registry.json.tmp.*`
 * files, the oldest from May, were sitting in ~/.trace-mcp. Each is a write
 * that died between `open` and `rename` — harmless individually, but nothing
 * ever collected them, so every crash leaked one permanently.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sweepOrphanTmpFiles, sweepOrphanTmpFilesUnderHome } from '../atomic-write.js';

let dir: string;

const DAY_MS = 24 * 60 * 60 * 1000;

function makeFile(name: string, ageMs: number): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, 'x');
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(p, t, t);
  return p;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-tmp-sweep-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('sweepOrphanTmpFiles (TRA-702)', () => {
  it('removes atomic-write leftovers older than the cutoff', () => {
    const old = makeFile('.daemon.pid.tmp.11094.3a8f308b3935', 3 * DAY_MS);
    makeFile('.registry.json.tmp.28982.4d09e49a857c', 5 * DAY_MS);

    const removed = sweepOrphanTmpFiles(dir, DAY_MS);

    expect(removed).toHaveLength(2);
    expect(fs.existsSync(old)).toBe(false);
  });

  it('leaves a tmp file young enough to belong to a write still in flight', () => {
    // A concurrent writer's tmp must survive — deleting it would turn another
    // process's atomic write into a spurious failure.
    const fresh = makeFile('.registry.json.tmp.999.abcdef012345', 60_000);

    expect(sweepOrphanTmpFiles(dir, DAY_MS)).toEqual([]);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('never touches real state files, however old', () => {
    const real = makeFile('registry.json', 30 * DAY_MS);
    const alsoReal = makeFile('.config.json', 30 * DAY_MS);
    const backup = makeFile('.config.json.bak.20260831143353', 30 * DAY_MS);

    expect(sweepOrphanTmpFiles(dir, DAY_MS)).toEqual([]);
    for (const p of [real, alsoReal, backup]) expect(fs.existsSync(p)).toBe(true);
  });

  it('returns empty for a directory that does not exist', () => {
    expect(sweepOrphanTmpFiles(path.join(dir, 'nope'), DAY_MS)).toEqual([]);
  });

  it('skips subdirectories that happen to match the tmp shape', () => {
    const d = path.join(dir, '.index.tmp.123.deadbeef');
    fs.mkdirSync(d);
    const t = new Date(Date.now() - 10 * DAY_MS);
    fs.utimesSync(d, t, t);

    expect(sweepOrphanTmpFiles(dir, DAY_MS)).toEqual([]);
    expect(fs.existsSync(d)).toBe(true);
  });

  // TRA-783: the sweep only ever ran on ~/.trace-mcp itself, and the pattern
  // required a leading dot — so pid-lock's `<name>.tmp.<pid>.<rand>` leftovers
  // could never be collected anywhere. A June orphan was still in
  // ~/.trace-mcp/sessions three months later.
  it('collects pid-lock leftovers, which carry no leading dot', () => {
    const lock = makeFile('4531cea08e4d-reindex.pid.tmp.65657.4eb982e9ac9d', 3 * DAY_MS);

    expect(sweepOrphanTmpFiles(dir, DAY_MS)).toEqual([lock]);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('sweeps the given directory only, not its children', () => {
    const sub = path.join(dir, 'sessions');
    fs.mkdirSync(sub);
    const nested = makeFile(
      path.join('sessions', '.9c8b895c63b7.json.tmp.65657.4eb982e9ac9d'),
      90 * DAY_MS,
    );

    expect(sweepOrphanTmpFiles(dir, DAY_MS)).toEqual([]);
    expect(fs.existsSync(nested)).toBe(true);
  });
});

describe('sweepOrphanTmpFilesUnderHome (TRA-783)', () => {
  // The startup path is what regressed, so assert on the directory set it
  // covers — a shallow sweep of the root alone would fail every case here.
  it.each(['sessions', 'locks', 'bundles', 'bin', 'index'])('collects orphans under %s/', (sub) => {
    fs.mkdirSync(path.join(dir, sub));
    const orphan = makeFile(path.join(sub, '.state.json.tmp.4242.4eb982e9ac9d'), 3 * DAY_MS);

    expect(sweepOrphanTmpFilesUnderHome(dir, DAY_MS)).toEqual([orphan]);
    expect(fs.existsSync(orphan)).toBe(false);
  });

  it('still collects orphans in the state root itself', () => {
    const orphan = makeFile('.registry.json.tmp.11.4eb982e9ac9d', 3 * DAY_MS);

    expect(sweepOrphanTmpFilesUnderHome(dir, DAY_MS)).toEqual([orphan]);
  });

  it('does not recurse past one level, and tolerates absent directories', () => {
    fs.mkdirSync(path.join(dir, 'index', 'ephemeral'), { recursive: true });
    const deep = makeFile(path.join('index', 'ephemeral', '.x.db.tmp.7.4eb982e9ac9d'), 9 * DAY_MS);

    // sessions/, locks/, bundles/, bin/ do not exist here — that must not throw.
    expect(sweepOrphanTmpFilesUnderHome(dir, DAY_MS)).toEqual([]);
    expect(fs.existsSync(deep)).toBe(true);
  });
});
