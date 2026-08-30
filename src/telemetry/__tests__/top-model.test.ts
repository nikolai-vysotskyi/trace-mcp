import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { topModelLastDay } from '../top-model.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-top-model-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function seed(rows: Array<{ model: string; startedAt: string }>): string {
  const p = path.join(tmp, `a-${Math.random()}.db`);
  const db = new Database(p);
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT, started_at TEXT)');
  const ins = db.prepare('INSERT INTO sessions (id, model, started_at) VALUES (?, ?, ?)');
  rows.forEach((r, i) => ins.run(String(i), r.model, r.startedAt));
  db.close();
  return p;
}

const now = () => new Date().toISOString();
const longAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();

describe('topModelLastDay', () => {
  it('returns the most-used model of the last 24h', () => {
    const p = seed([
      { model: 'claude-opus-4-6', startedAt: now() },
      { model: 'claude-sonnet-4-6', startedAt: now() },
      { model: 'claude-sonnet-4-6', startedAt: now() },
    ]);
    expect(topModelLastDay(p)).toBe('claude-sonnet-4-6');
  });

  it('ignores sessions older than a day and empty models', () => {
    const p = seed([
      { model: 'claude-opus-4-6', startedAt: longAgo },
      { model: '', startedAt: now() },
    ]);
    expect(topModelLastDay(p)).toBeUndefined();
  });

  it('never creates the database when it is absent', () => {
    const missing = path.join(tmp, 'nope.db');
    expect(topModelLastDay(missing)).toBeUndefined();
    expect(fs.existsSync(missing)).toBe(false);
  });
});
