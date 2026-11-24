/** Isolated diagnostic for TRA-3202. Never opens the configured data directory. */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const dir = mkdtempSync(join(tmpdir(), 'trace-pid-bench-'));
const dbPath = join(dir, 'index.db');
const db = new Database(dbPath);
const measure = (fn: () => void): number => {
  const start = performance.now();
  fn();
  return Math.round((performance.now() - start) * 100) / 100;
};

try {
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('wal_autocheckpoint = 0');
  db.exec('CREATE TABLE server_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.exec('CREATE TABLE payload (id INTEGER PRIMARY KEY, bytes BLOB NOT NULL)');
  const bytes = Buffer.alloc(48 * 1024 * 1024);
  const fill = db.prepare('INSERT OR REPLACE INTO payload (id, bytes) VALUES (1, ?)');
  const pid = db.prepare("INSERT OR REPLACE INTO server_state (key, value) VALUES ('pid', ?)");

  fill.run(bytes);
  const walMiB = Math.round((statSync(`${dbPath}-wal`).size / 1024 / 1024) * 10) / 10;
  const statementMs = measure(() => pid.run(String(process.pid)));
  const checkpointMs = measure(() => db.pragma('wal_checkpoint(PASSIVE)'));

  bytes[0] = 1;
  fill.run(bytes);
  db.pragma('wal_autocheckpoint = 1');
  const statementWithCheckpointMs = measure(() => pid.run(String(process.pid)));

  // A held write lock exercises busy_timeout separately from checkpoint I/O.
  const peer = new Database(dbPath);
  peer.pragma('busy_timeout = 250');
  db.exec('BEGIN IMMEDIATE');
  let lockWaitMs: number;
  try {
    lockWaitMs = measure(() => {
      try {
        peer.prepare("INSERT OR REPLACE INTO server_state (key, value) VALUES ('pid', ?)").run('0');
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('database is locked')) throw error;
      }
    });
  } finally {
    db.exec('ROLLBACK');
    peer.close();
  }
  process.stdout.write(
    JSON.stringify({ walMiB, statementMs, checkpointMs, statementWithCheckpointMs, lockWaitMs }) +
      '\n',
  );
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
