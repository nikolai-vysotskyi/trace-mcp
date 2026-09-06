/**
 * update.log has a ceiling (TRA-707). Without one it only ever grew: each entry
 * carries a full stdout/stderr capture, so a handful of failing updates move it
 * by megabytes and nothing ever trims it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendUpdateLog, UPDATE_LOG_MAX_BYTES, updateLogPath } from '../update-log';

let traceHome: string;
let logPath: string;

beforeEach(() => {
  traceHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-update-log-'));
  vi.stubEnv('TRACE_HOME', traceHome);
  logPath = updateLogPath();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(traceHome, { recursive: true, force: true });
});

describe('appendUpdateLog', () => {
  it('appends while under the ceiling', () => {
    appendUpdateLog({ event: 'one' });
    appendUpdateLog({ event: 'two' });

    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]).event).toBe('two');
    expect(fs.existsSync(`${logPath}.1`)).toBe(false);
  });

  it('rotates once past the ceiling instead of growing forever', () => {
    fs.writeFileSync(logPath, 'x'.repeat(UPDATE_LOG_MAX_BYTES + 1));

    appendUpdateLog({ event: 'after-rotation' });

    // Oversized content moved aside; the live log restarts from the new entry.
    expect(fs.statSync(`${logPath}.1`).size).toBe(UPDATE_LOG_MAX_BYTES + 1);
    const live = fs.readFileSync(logPath, 'utf-8').trim();
    expect(live.split('\n')).toHaveLength(1);
    expect(JSON.parse(live).event).toBe('after-rotation');
  });

  it('keeps one generation — a second rotation discards the older one', () => {
    fs.writeFileSync(logPath, 'first'.padEnd(UPDATE_LOG_MAX_BYTES + 1, 'x'));
    appendUpdateLog({ event: 'gen-2' });
    fs.appendFileSync(logPath, 'y'.repeat(UPDATE_LOG_MAX_BYTES));
    appendUpdateLog({ event: 'gen-3' });

    expect(fs.readFileSync(`${logPath}.1`, 'utf-8')).toContain('gen-2');
    expect(fs.readFileSync(`${logPath}.1`, 'utf-8')).not.toContain('first');
    expect(fs.readFileSync(logPath, 'utf-8')).toContain('gen-3');
  });

  it('never throws when the log cannot be written', () => {
    // A file where the directory has to be — mkdir and append both fail.
    fs.rmSync(traceHome, { recursive: true, force: true });
    fs.writeFileSync(traceHome, 'not a directory');

    expect(() => appendUpdateLog({ event: 'doomed' })).not.toThrow();

    fs.rmSync(traceHome, { force: true });
    fs.mkdirSync(traceHome);
  });
});
