import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getGuardMode,
  getGuardStatus,
  setBypass,
  setGuardMode,
} from '../../packages/app/src/main/guard-control.js';

const TMP_BASE = fs.realpathSync(os.tmpdir());

function projectHash(p: string): string {
  return crypto.createHash('sha256').update(path.resolve(p)).digest('hex').slice(0, 12);
}

describe('guard-control (app main process)', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = path.join(
      TMP_BASE,
      `guard-ctrl-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(projectDir)) {
      const real = fs.realpathSync(projectDir);
      const status = path.join(TMP_BASE, `trace-mcp-status-${projectHash(real)}.json`);
      const legacy = path.join(TMP_BASE, `trace-mcp-alive-${projectHash(real)}`);
      const bypass = path.join(TMP_BASE, `trace-mcp-bypass-${projectHash(real)}`);
      [status, legacy, bypass].forEach((f) => fs.rmSync(f, { force: true }));
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  // ─── Mode get/set ───────────────────────────────────────────────

  it('getGuardMode returns "strict" by default (no file)', () => {
    expect(getGuardMode(projectDir)).toBe('strict');
  });

  it('setGuardMode persists to .trace-mcp/guard-mode and getGuardMode reads it back', () => {
    setGuardMode(projectDir, 'coach');
    expect(getGuardMode(projectDir)).toBe('coach');
    setGuardMode(projectDir, 'off');
    expect(getGuardMode(projectDir)).toBe('off');
  });

  it('setGuardMode creates the .trace-mcp directory', () => {
    setGuardMode(projectDir, 'strict');
    expect(fs.existsSync(path.join(projectDir, '.trace-mcp', 'guard-mode'))).toBe(true);
  });

  // ─── Status: down (no sentinels) ────────────────────────────────

  it('getGuardStatus returns health=down when no sentinels exist', () => {
    const s = getGuardStatus(projectDir);
    expect(s.health).toBe('down');
    expect(s.mode).toBe('strict');
  });

  // ─── Status: ok with rich JSON ──────────────────────────────────

  it('getGuardStatus returns health=ok with fresh status JSON', () => {
    const real = fs.realpathSync(projectDir);
    const file = path.join(TMP_BASE, `trace-mcp-status-${projectHash(real)}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({
        schema: 1,
        pid: 12345,
        started_at: new Date().toISOString(),
        last_heartbeat_at: new Date().toISOString(),
        last_successful_tool_call_at: new Date().toISOString(),
        last_failed_tool_call_at: null,
        tool_calls_total: 5,
        tool_calls_failed: 0,
        mcp_sessions_active: 1,
      }),
    );
    const s = getGuardStatus(projectDir);
    expect(s.health).toBe('ok');
    expect(s.pid).toBe(12345);
    expect(s.toolCallsTotal).toBe(5);
  });

  it('getGuardStatus returns health=stalled when last_successful is old', () => {
    const real = fs.realpathSync(projectDir);
    const file = path.join(TMP_BASE, `trace-mcp-status-${projectHash(real)}.json`);
    const sixMinAgo = new Date(Date.now() - 360_000).toISOString();
    fs.writeFileSync(
      file,
      JSON.stringify({
        schema: 1,
        pid: 12345,
        started_at: new Date().toISOString(),
        last_heartbeat_at: new Date().toISOString(),
        last_successful_tool_call_at: sixMinAgo,
        last_failed_tool_call_at: null,
        tool_calls_total: 5,
        tool_calls_failed: 0,
        mcp_sessions_active: 1,
      }),
    );
    const s = getGuardStatus(projectDir);
    expect(s.health).toBe('stalled');
    expect(s.reason).toContain('quiet');
  });

  it('getGuardStatus returns health=down when heartbeat is stale', () => {
    const real = fs.realpathSync(projectDir);
    const file = path.join(TMP_BASE, `trace-mcp-status-${projectHash(real)}.json`);
    const oldTime = new Date(Date.now() - 60_000).toISOString();
    fs.writeFileSync(
      file,
      JSON.stringify({
        schema: 1,
        pid: 12345,
        started_at: oldTime,
        last_heartbeat_at: oldTime,
        last_successful_tool_call_at: oldTime,
        last_failed_tool_call_at: null,
        tool_calls_total: 5,
        tool_calls_failed: 0,
        mcp_sessions_active: 1,
      }),
    );
    const s = getGuardStatus(projectDir);
    expect(s.health).toBe('down');
  });

  // ─── Status: legacy heartbeat fallback ──────────────────────────

  it('getGuardStatus falls back to legacy heartbeat when no JSON', () => {
    const real = fs.realpathSync(projectDir);
    const legacy = path.join(TMP_BASE, `trace-mcp-alive-${projectHash(real)}`);
    fs.writeFileSync(legacy, String(Date.now()));
    const s = getGuardStatus(projectDir);
    expect(s.health).toBe('ok');
    expect(s.reason).toContain('Legacy heartbeat');
  });

  // ─── Bypass ─────────────────────────────────────────────────────

  it('setBypass(N) creates a future-mtime sentinel; getGuardStatus reports bypassUntil', () => {
    setBypass(projectDir, 10);
    const s = getGuardStatus(projectDir);
    expect(s.bypassUntil).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('setBypass(0) removes the sentinel', () => {
    setBypass(projectDir, 10);
    setBypass(projectDir, 0);
    const s = getGuardStatus(projectDir);
    expect(s.bypassUntil ?? 0).toBe(0);
  });
});
