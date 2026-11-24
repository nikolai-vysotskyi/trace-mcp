import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { isServerRunning } from '../../progress.js';
import { writeServerPidOffThread } from '../pid-registration.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('keeps the event loop responsive while several projects register against held writers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trace-pid-registration-'));
  dirs.push(dir);
  const databases = Array.from({ length: 3 }, (_, index) => {
    const dbPath = join(dir, `project-${index}.db`);
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE server_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.exec('BEGIN IMMEDIATE');
    return { db, dbPath };
  });

  try {
    const start = performance.now();
    const registrations = databases.map(({ dbPath }) => writeServerPidOffThread(dbPath));
    let timerLag = 0;
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        timerLag = performance.now() - start;
        resolve();
      }, 150);
    });
    expect(timerLag).toBeLessThan(2_000);
    for (const { db } of databases) {
      expect(db.prepare("SELECT value FROM server_state WHERE key = 'pid'").get()).toBeUndefined();
      db.exec('COMMIT');
    }
    await Promise.all(registrations);
    for (const { db } of databases) expect(isServerRunning(db)).toBe(true);
  } finally {
    for (const { db } of databases) {
      if (db.inTransaction) db.exec('ROLLBACK');
      db.close();
    }
  }
}, 10_000);
