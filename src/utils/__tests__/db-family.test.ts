/**
 * TRA-1864: the daemon deleted ephemeral index DBs without their WAL/SHM
 * companions, stranding ~1.5 GB of stem-less `.db-wal` / `.db-shm` orphans in
 * `index/` that no sweep could see (every sweep walks base `.db` files).
 *
 * These tests pin the two halves of the fix:
 * - `deleteDbFamily` removes the whole family (base, WAL/SHM/journal,
 *   watcher snapshot, holders dir) — the helper every deletion site uses.
 * - `sweepOrphanDbSidecars` collects stem-less sidecars while leaving
 *   live-DB sidecars and live-holder stems alone.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeTmpDir, tmpRootOutsideTaskDir } from '../../../tests/test-utils.js';

describe('db-family (TRA-1864)', () => {
  let tmpHome: string;
  let indexDir: string;
  let ephemeralDir: string;
  let dbFamily: typeof import('../db-family.js');
  let holders: typeof import('../../db-holders.js');

  beforeEach(async () => {
    tmpHome = tmpRootOutsideTaskDir('trace-db-family-');
    vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
    vi.resetModules();
    dbFamily = await import('../db-family.js');
    holders = await import('../../db-holders.js');
    const paths = await import('../../shared/paths.js');
    const { EPHEMERAL_INDEX_DIR } = await import('../../global.js');
    indexDir = paths.INDEX_DIR;
    ephemeralDir = EPHEMERAL_INDEX_DIR;
    fs.mkdirSync(indexDir, { recursive: true });
    fs.mkdirSync(ephemeralDir, { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    removeTmpDir(tmpHome);
  });

  function write(dir: string, name: string, content = 'x'): string {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return full;
  }

  describe('deleteDbFamily', () => {
    it('removes the base, every sidecar, the snapshot and the holders dir', () => {
      const base = write(indexDir, 'proj-abcdef123456.db');
      write(indexDir, 'proj-abcdef123456.db-wal', 'wal-bytes');
      write(indexDir, 'proj-abcdef123456.db-shm', 'shm');
      write(indexDir, 'proj-abcdef123456.db-journal', 'journal');
      write(indexDir, 'proj-abcdef123456.db.watcher-snapshot', 'snap');
      fs.mkdirSync(`${base}.holders`, { recursive: true });
      write(indexDir, 'proj-abcdef123456.db.holders/dead.json', '{}');
      write(indexDir, 'unrelated.db', 'keep me');

      const { deleted, freedBytes } = dbFamily.deleteDbFamily(base);

      expect(deleted).toContain(base);
      expect(deleted).toContain(`${base}-wal`);
      expect(freedBytes).toBeGreaterThan(0);
      for (const suffix of ['', '-wal', '-shm', '-journal', '.watcher-snapshot']) {
        expect(fs.existsSync(base + suffix)).toBe(false);
      }
      expect(fs.existsSync(`${base}.holders`)).toBe(false);
      expect(fs.existsSync(path.join(indexDir, 'unrelated.db'))).toBe(true);
    });

    it('is idempotent on a missing base', () => {
      const base = path.join(indexDir, 'gone-abcdef123456.db');
      expect(dbFamily.deleteDbFamily(base)).toEqual({ deleted: [], freedBytes: 0 });
    });
  });

  describe('sweepOrphanDbSidecars', () => {
    it('deletes ghost WAL/SHM pairs whose stem .db is gone (top-level index dir)', () => {
      // Shape of the reported pile: workdir-*.db-wal/.db-shm without workdir-*.db.
      write(indexDir, 'workdir-f7cd0696b89e.db-wal', 'wal-1');
      write(indexDir, 'workdir-f7cd0696b89e.db-shm', 'shm-1');
      write(indexDir, 'workdir-61d67e42a393.db-wal', 'wal-2');
      write(indexDir, 'workdir-61d67e42a393.db-shm', 'shm-2');

      const { deleted, freedBytes } = dbFamily.sweepOrphanDbSidecars();

      expect(deleted).toHaveLength(4);
      expect(freedBytes).toBe('wal-1shm-1wal-2shm-2'.length);
      // Only the (empty) ephemeral subdir remains.
      expect(fs.readdirSync(indexDir)).toEqual(['ephemeral']);
    });

    it('also sweeps the ephemeral subdir', () => {
      write(ephemeralDir, 'run-abcdef123456.db-wal', 'wal');
      write(ephemeralDir, 'run-abcdef123456.db-shm', 'shm');

      const { deleted } = dbFamily.sweepOrphanDbSidecars();

      expect(deleted).toHaveLength(2);
      expect(fs.readdirSync(ephemeralDir)).toEqual([]);
    });

    it('keeps sidecars of a live DB and stem-less snapshots die with nothing to resume', () => {
      write(indexDir, 'live-abcdef123456.db', 'db');
      write(indexDir, 'live-abcdef123456.db-wal', 'wal');
      write(indexDir, 'live-abcdef123456.db-shm', 'shm');
      write(indexDir, 'ghost-abcdef123456.db.watcher-snapshot', 'snap');

      const { deleted } = dbFamily.sweepOrphanDbSidecars();

      expect(fs.existsSync(path.join(indexDir, 'live-abcdef123456.db-wal'))).toBe(true);
      expect(fs.existsSync(path.join(indexDir, 'live-abcdef123456.db-shm'))).toBe(true);
      expect(deleted).toEqual([path.join(indexDir, 'ghost-abcdef123456.db.watcher-snapshot')]);
    });

    it('does not touch a stem claimed by a live holder', () => {
      const stem = path.join(indexDir, 'held-abcdef123456.db');
      write(indexDir, 'held-abcdef123456.db-wal', 'wal');
      write(indexDir, 'held-abcdef123456.db-shm', 'shm');
      // A process holding an unlinked DB keeps writing its WAL through the
      // open handle; the marker is the only trace of that.
      holders.announceDbHolder(stem, path.join(tmpHome, 'some-live-root'));

      const { deleted } = dbFamily.sweepOrphanDbSidecars();

      expect(deleted).toEqual([]);
      expect(fs.existsSync(`${stem}-wal`)).toBe(true);
    });

    it('ignores non-sidecar files and missing dirs', () => {
      write(indexDir, 'notes.txt', 'not a db file');
      const { deleted } = dbFamily.sweepOrphanDbSidecars([path.join(tmpHome, 'no-such-dir')]);
      expect(deleted).toEqual([]);
      expect(fs.existsSync(path.join(indexDir, 'notes.txt'))).toBe(true);
    });
  });

  describe('findOrphanDbSidecars', () => {
    it('lists orphans without deleting (prune dry-run)', () => {
      write(indexDir, 'ghost-abcdef123456.db-wal', 'wal');
      write(indexDir, 'ghost-abcdef123456.db-journal', 'journal');

      const found = dbFamily.findOrphanDbSidecars();

      expect(found).toHaveLength(1);
      expect(found[0].stem).toBe(path.join(indexDir, 'ghost-abcdef123456.db'));
      expect(found[0].files).toHaveLength(2);
      expect(found[0].bytes).toBe('waljournal'.length);
      // Read-only: nothing removed.
      expect(fs.existsSync(path.join(indexDir, 'ghost-abcdef123456.db-wal'))).toBe(true);
    });
  });
});
