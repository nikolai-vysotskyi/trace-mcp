import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionJournal } from '../../src/session-journal.js';

describe('SessionJournal — getSnapshot', () => {
  it('returns empty snapshot for fresh session', () => {
    const j = new SessionJournal();
    const snap = j.getSnapshot();

    expect(snap.snapshot).toContain('Session Snapshot (trace-mcp)');
    expect(snap.structured.total_calls).toBe(0);
    expect(snap.structured.files_explored).toBe(0);
    expect(snap.structured.focus_files).toHaveLength(0);
    expect(snap.structured.edited_files).toHaveLength(0);
    expect(snap.structured.key_searches).toHaveLength(0);
    expect(snap.structured.dead_ends).toHaveLength(0);
    expect(snap.estimated_tokens).toBeGreaterThan(0);
  });

  it('tracks focus files sorted by read count', () => {
    const j = new SessionJournal();

    // Read server.ts 3 times, config.ts once
    j.record('get_symbol', { symbol_id: 'src/server.ts::createServer#function' }, 1);
    j.record('get_outline', { path: 'src/server.ts' }, 10);
    j.record('get_symbol', { symbol_id: 'src/server.ts::jh#function' }, 1);
    j.record('get_outline', { path: 'src/config.ts' }, 5);

    const snap = j.getSnapshot();
    expect(snap.structured.focus_files.length).toBeGreaterThan(0);
    expect(snap.structured.focus_files[0].path).toBe('src/server.ts');
    expect(snap.structured.focus_files[0].reads).toBe(3);
    expect(snap.snapshot).toContain('src/server.ts');
    expect(snap.snapshot).toContain('3 reads');
  });

  it('tracks edited files via register_edit', () => {
    const j = new SessionJournal();
    j.record('register_edit', { file_path: 'src/server.ts' }, 1);
    j.record('register_edit', { file_path: 'src/config.ts' }, 1);
    j.record('register_edit', { file_path: 'src/server.ts' }, 1); // duplicate

    const snap = j.getSnapshot();
    expect(snap.structured.edited_files).toContain('src/server.ts');
    expect(snap.structured.edited_files).toContain('src/config.ts');
    expect(snap.structured.edited_files).toHaveLength(2); // deduped
    expect(snap.snapshot).toContain('Edited files');
  });

  it('tracks key searches with result counts', () => {
    const j = new SessionJournal();
    j.record('search', { query: 'createServer' }, 5);
    j.record('find_usages', { fqn: 'SessionJournal' }, 12);

    const snap = j.getSnapshot();
    expect(snap.structured.key_searches.length).toBe(2);
    expect(snap.structured.key_searches[0].results).toBe(5);
    expect(snap.snapshot).toContain('Key searches');
  });

  it('tracks dead ends (zero-result searches)', () => {
    const j = new SessionJournal();
    j.record('search', { query: 'nonexistentFunction' }, 0);
    j.record('search', { query: 'alsoMissing' }, 0);

    const snap = j.getSnapshot();
    expect(snap.structured.dead_ends.length).toBe(2);
    expect(snap.snapshot).toContain("Dead ends (don't re-search)");
    expect(snap.snapshot).toContain('nonexistentFunction');
  });

  it('excludes dead ends when includeNegativeEvidence=false', () => {
    const j = new SessionJournal();
    j.record('search', { query: 'missing' }, 0);

    const snap = j.getSnapshot({ includeNegativeEvidence: false });
    expect(snap.structured.dead_ends).toHaveLength(0);
    expect(snap.snapshot).not.toContain('Dead ends');
  });

  it('respects maxFiles limit', () => {
    const j = new SessionJournal();
    for (let i = 0; i < 20; i++) {
      j.record('get_outline', { path: `src/file${i}.ts` }, 5);
    }

    const snap = j.getSnapshot({ maxFiles: 3 });
    expect(snap.structured.focus_files).toHaveLength(3);
  });

  it('respects maxSearches limit', () => {
    const j = new SessionJournal();
    for (let i = 0; i < 10; i++) {
      j.record('search', { query: `query${i}` }, i + 1);
    }

    const snap = j.getSnapshot({ maxSearches: 2 });
    expect(snap.structured.key_searches).toHaveLength(2);
  });

  it('snapshot markdown stays under ~200 tokens for typical sessions', () => {
    const j = new SessionJournal();
    // Simulate a realistic session
    for (let i = 0; i < 5; i++) {
      j.record('get_outline', { path: `src/file${i}.ts` }, 10);
    }
    j.record('search', { query: 'handleRequest' }, 3);
    j.record('search', { query: 'middleware' }, 0);
    j.record('register_edit', { file_path: 'src/server.ts' }, 1);

    const snap = j.getSnapshot();
    // ~4 chars per token, 200 tokens = ~800 chars — allow some headroom
    expect(snap.estimated_tokens).toBeLessThan(300);
  });

  it('snapshot and structured data are consistent', () => {
    const j = new SessionJournal();
    j.record('get_symbol', { symbol_id: 'src/a.ts::Foo#class' }, 1);
    j.record('search', { query: 'bar' }, 3);

    const snap = j.getSnapshot();
    // structured says 2 calls → markdown mentions it
    expect(snap.structured.total_calls).toBe(2);
    expect(snap.snapshot).toContain('Tool calls:** 2');
  });
});

describe('SessionJournal — flushSnapshotFile', () => {
  const tmpDir = path.join(os.tmpdir(), `trace-mcp-snap-test-${Date.now()}`);
  const snapshotPath = path.join(tmpDir, 'snapshot.json');

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('writes snapshot file with correct structure', () => {
    const j = new SessionJournal();
    j.record('get_symbol', { symbol_id: 'src/a.ts::Foo#class' }, 1);
    j.record('search', { query: 'bar' }, 3);

    j.flushSnapshotFile(snapshotPath);

    expect(fs.existsSync(snapshotPath)).toBe(true);
    const data = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
    expect(data.timestamp).toBeTypeOf('number');
    expect(data.markdown).toContain('Session Snapshot');
    expect(data.structured.total_calls).toBe(2);
    expect(data.estimated_tokens).toBeGreaterThan(0);
  });

  it('does not write file for empty session', () => {
    const j = new SessionJournal();
    j.flushSnapshotFile(snapshotPath);
    expect(fs.existsSync(snapshotPath)).toBe(false);
  });

  it('creates parent directory if needed', () => {
    const j = new SessionJournal();
    j.record('search', { query: 'test' }, 1);

    const deepPath = path.join(tmpDir, 'sub', 'dir', 'snapshot.json');
    j.flushSnapshotFile(deepPath);
    expect(fs.existsSync(deepPath)).toBe(true);
  });
});

describe('SessionJournal — enablePeriodicSnapshot', () => {
  const tmpDir = path.join(os.tmpdir(), `trace-mcp-periodic-test-${Date.now()}`);
  const snapshotPath = path.join(tmpDir, 'snapshot.json');

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('flushes snapshot every N calls', () => {
    const j = new SessionJournal();
    j.enablePeriodicSnapshot(snapshotPath, 3);

    // 1st and 2nd calls — no flush yet
    j.record('search', { query: 'a' }, 1);
    j.record('search', { query: 'b' }, 1);
    expect(fs.existsSync(snapshotPath)).toBe(false);

    // 3rd call — triggers flush (entries.length === 3, 3 % 3 === 0)
    j.record('search', { query: 'c' }, 1);
    expect(fs.existsSync(snapshotPath)).toBe(true);

    const data = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
    expect(data.structured.total_calls).toBe(3);
  });
});
