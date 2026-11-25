import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { initializeDatabase, reclaimFreePages } from '../../src/db/schema.js';

describe('reclaimFreePages', () => {
  it('shrinks an INCREMENTAL db once free pages pass a quarter, then no-ops', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-reclaim-'));
    const db = initializeDatabase(path.join(dir, 'x.db'));
    db.exec('CREATE TABLE junk (v TEXT)');
    const ins = db.prepare('INSERT INTO junk VALUES (?)');
    db.transaction(() => {
      for (let i = 0; i < 5000; i++) ins.run('x'.repeat(1000));
    })();
    db.exec('DELETE FROM junk');
    const before = db.pragma('page_count', { simple: true }) as number;

    // Bounded per call: a large freelist takes several calls, never one stall.
    expect(reclaimFreePages(db, 100)).toBe(100);
    while (reclaimFreePages(db, 100) > 0) {}
    const free = db.pragma('freelist_count', { simple: true }) as number;
    expect(free * 4).toBeLessThan(db.pragma('page_count', { simple: true }) as number);
    expect(db.pragma('page_count', { simple: true }) as number).toBeLessThan(before);
    expect(reclaimFreePages(db)).toBe(0);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('migration 37 — dead coupling snapshots', () => {
  it('drops coupling rows, keeps other snapshot types', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mig37-'));
    const file = path.join(dir, 'x.db');
    let db = initializeDatabase(file);
    const ins = db.prepare(
      'INSERT INTO graph_snapshots (commit_hash, snapshot_type, file_path, data) VALUES (?, ?, ?, ?)',
    );
    ins.run(null, 'coupling', 'a.ts', '{}');
    ins.run(null, 'coupling_summary', null, '{}');
    ins.run('abc', 'ci_quality_baseline', null, '{"k":1}');
    db.prepare("UPDATE schema_meta SET value = '36' WHERE key = 'schema_version'").run();
    db.close();

    db = initializeDatabase(file);
    const rows = db.prepare('SELECT snapshot_type, commit_hash, data FROM graph_snapshots').all();
    expect(rows).toEqual([
      { snapshot_type: 'ci_quality_baseline', commit_hash: 'abc', data: '{"k":1}' },
    ]);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
