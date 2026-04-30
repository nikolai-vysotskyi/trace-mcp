import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startHeartbeat } from '../../src/server/heartbeat.js';

const TMP_BASE = fs.realpathSync(os.tmpdir());

function projectHash(p: string): string {
  return crypto.createHash('sha256').update(path.resolve(p)).digest('hex').slice(0, 12);
}

describe('status sentinel (heartbeat)', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = path.join(
      TMP_BASE,
      `heartbeat-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(projectDir)) {
      const real = fs.realpathSync(projectDir);
      const status = path.join(TMP_BASE, `trace-mcp-status-${projectHash(real)}.json`);
      const legacy = path.join(TMP_BASE, `trace-mcp-alive-${projectHash(real)}`);
      fs.rmSync(status, { force: true });
      fs.rmSync(legacy, { force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('writes a JSON status file with required fields', () => {
    const handle = startHeartbeat(projectDir);
    try {
      expect(fs.existsSync(handle.path)).toBe(true);
      const status = JSON.parse(fs.readFileSync(handle.path, 'utf-8'));
      expect(status.schema).toBe(1);
      expect(status.pid).toBe(process.pid);
      expect(typeof status.started_at).toBe('string');
      expect(typeof status.last_heartbeat_at).toBe('string');
      expect(status.last_successful_tool_call_at).toBeNull();
      expect(status.tool_calls_total).toBe(0);
      expect(status.tool_calls_failed).toBe(0);
      expect(status.mcp_sessions_active).toBe(0);
    } finally {
      handle.stop();
    }
  });

  it('writes the legacy mtime sentinel for v0.7 hook backward compat', () => {
    const handle = startHeartbeat(projectDir);
    try {
      expect(fs.existsSync(handle.legacyPath)).toBe(true);
    } finally {
      handle.stop();
    }
  });

  it('recordToolCall(true) bumps total + last_successful_tool_call_at', () => {
    const handle = startHeartbeat(projectDir);
    try {
      handle.recordToolCall(true);
      handle.recordToolCall(true);
      handle.flush();
      const status = JSON.parse(fs.readFileSync(handle.path, 'utf-8'));
      expect(status.tool_calls_total).toBe(2);
      expect(status.tool_calls_failed).toBe(0);
      expect(status.last_successful_tool_call_at).not.toBeNull();
    } finally {
      handle.stop();
    }
  });

  it('recordToolCall(false) bumps failures + last_failed_tool_call_at', () => {
    const handle = startHeartbeat(projectDir);
    try {
      handle.recordToolCall(true);
      handle.recordToolCall(false);
      handle.recordToolCall(false);
      handle.flush();
      const status = JSON.parse(fs.readFileSync(handle.path, 'utf-8'));
      expect(status.tool_calls_total).toBe(3);
      expect(status.tool_calls_failed).toBe(2);
      expect(status.last_successful_tool_call_at).not.toBeNull();
      expect(status.last_failed_tool_call_at).not.toBeNull();
    } finally {
      handle.stop();
    }
  });

  it('getState() returns a snapshot of in-memory state', () => {
    const handle = startHeartbeat(projectDir);
    try {
      handle.recordToolCall(true);
      handle.setSessionsActive(2);
      const state = handle.getState();
      expect(state.tool_calls_total).toBe(1);
      expect(state.mcp_sessions_active).toBe(2);
      expect(state.last_successful_tool_call_at).not.toBeNull();
    } finally {
      handle.stop();
    }
  });

  it('stop() removes both status and legacy sentinel files', () => {
    const handle = startHeartbeat(projectDir);
    expect(fs.existsSync(handle.path)).toBe(true);
    expect(fs.existsSync(handle.legacyPath)).toBe(true);
    handle.stop();
    expect(fs.existsSync(handle.path)).toBe(false);
    expect(fs.existsSync(handle.legacyPath)).toBe(false);
  });
});
