/**
 * Tests for the day-bucketed JSONL audit logger and its DecisionStore
 * integration. Covers: file creation lazily, multi-line append, day
 * rollover (clock-mocked), failure containment, and store wiring for
 * add/update/invalidate.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AuditEntry,
  type AuditLogger,
  createAuditLogger,
} from '../../src/memory/decision-audit-log.js';
import { DecisionStore } from '../../src/memory/decision-store.js';

describe('createAuditLogger', () => {
  let baseDir: string;
  let logger: AuditLogger;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-log-'));
    logger = createAuditLogger({ dir: path.join(baseDir, 'decisions') });
  });

  afterEach(() => {
    logger.close();
    fs.rmSync(baseDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('creates the directory and a YYYY-MM-DD.jsonl file on first write', () => {
    const decisionsDir = path.join(baseDir, 'decisions');
    expect(fs.existsSync(decisionsDir)).toBe(false);
    logger.log({ op: 'add', decision_id: 1, title: 't', type: 'tech_choice' });
    expect(fs.existsSync(decisionsDir)).toBe(true);
    const files = fs.readdirSync(decisionsDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/);
  });

  it('appends newline-separated valid JSONL on repeated writes', () => {
    const decisionsDir = path.join(baseDir, 'decisions');
    logger.log({ op: 'add', decision_id: 1, title: 'a', type: 'preference' });
    logger.log({ op: 'update', decision_id: 1, title: 'a*', type: 'preference' });
    logger.log({ op: 'invalidate', decision_id: 1, title: 'a*', type: 'preference' });
    const [file] = fs.readdirSync(decisionsDir);
    const raw = fs.readFileSync(path.join(decisionsDir, file), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    const ops = lines.map((l) => (JSON.parse(l) as AuditEntry).op);
    expect(ops).toEqual(['add', 'update', 'invalidate']);
  });

  it('uses the caller-supplied ts when present and auto-fills otherwise', () => {
    const decisionsDir = path.join(baseDir, 'decisions');
    logger.log({ op: 'add', decision_id: 7, ts: '2030-01-01T00:00:00.000Z' });
    logger.log({ op: 'add', decision_id: 8 });
    const [file] = fs.readdirSync(decisionsDir);
    const lines = fs.readFileSync(path.join(decisionsDir, file), 'utf8').trim().split('\n');
    const parsed = lines.map((l) => JSON.parse(l) as AuditEntry);
    expect(parsed[0].ts).toBe('2030-01-01T00:00:00.000Z');
    expect(typeof parsed[1].ts).toBe('string');
    expect(parsed[1].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('rolls over to a new file when the UTC day changes', () => {
    const decisionsDir = path.join(baseDir, 'decisions');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-06-15T23:00:00.000Z'));
    logger.log({ op: 'add', decision_id: 1 });
    vi.setSystemTime(new Date('2030-06-16T01:00:00.000Z'));
    logger.log({ op: 'add', decision_id: 2 });
    const files = fs.readdirSync(decisionsDir).sort();
    expect(files).toEqual(['2030-06-15.jsonl', '2030-06-16.jsonl']);
  });
});

describe('DecisionStore + audit logger integration', () => {
  let tmpDir: string;
  let dbPath: string;
  let logDir: string;
  let logger: AuditLogger;
  let store: DecisionStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-store-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    logDir = path.join(tmpDir, 'auditlog');
    logger = createAuditLogger({ dir: logDir });
    store = new DecisionStore(dbPath, { auditLogger: logger });
  });

  afterEach(() => {
    store.close();
    logger.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function readAllEntries(): AuditEntry[] {
    if (!fs.existsSync(logDir)) return [];
    const files = fs.readdirSync(logDir).sort();
    const lines: string[] = [];
    for (const f of files) {
      lines.push(
        ...fs.readFileSync(path.join(logDir, f), 'utf8').trim().split('\n').filter(Boolean),
      );
    }
    return lines.map((l) => JSON.parse(l) as AuditEntry);
  }

  it('records audit entries for add/update/invalidate', () => {
    const d = store.addDecision({
      title: 'Use Redis',
      content: 'session storage',
      type: 'architecture_decision',
      project_root: '/proj',
    });
    store.updateDecision(d.id, { title: 'Use Redis (revised)' });
    store.invalidateDecision(d.id);

    const entries = readAllEntries();
    expect(entries.map((e) => e.op)).toEqual(['add', 'update', 'invalidate']);
    for (const e of entries) {
      expect(e.decision_id).toBe(d.id);
      expect(e.title).toBeTruthy();
      expect(e.type).toBe('architecture_decision');
    }
  });

  it('survives an audit-logger that throws and still performs the SQLite mutation', () => {
    const failing: AuditLogger = {
      log: () => {
        throw new Error('disk full');
      },
      close: () => undefined,
    };
    const failingStore = new DecisionStore(path.join(tmpDir, 'fail.db'), {
      auditLogger: failing,
    });
    try {
      const d = failingStore.addDecision({
        title: 't',
        content: 'c',
        type: 'preference',
        project_root: '/proj',
      });
      expect(d.id).toBeGreaterThan(0);
      // Mutation persisted despite audit failure.
      expect(failingStore.getDecision(d.id)?.title).toBe('t');
    } finally {
      failingStore.close();
    }
  });
});

describe('DecisionStore without audit logger', () => {
  it('works unchanged when no audit logger is supplied', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-none-'));
    const store = new DecisionStore(path.join(tmpDir, 'decisions.db'));
    try {
      const d = store.addDecision({
        title: 't',
        content: 'c',
        type: 'discovery',
        project_root: '/proj',
      });
      expect(d.id).toBeGreaterThan(0);
      expect(store.invalidateDecision(d.id)).toBe(true);
    } finally {
      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
