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

  // TRA-869: the sentinel is a channel between two processes that do NOT share
  // $TMPDIR — the server is spawned by the MCP client, the guard hook by the
  // agent harness. Writing it only to os.tmpdir() made the hook report "server
  // not running" against a live session and fall back to Read/Grep.
  it('writes the sentinels under the state home, not only $TMPDIR', () => {
    const stateHome = process.env.TRACE_MCP_DATA_DIR;
    expect(stateHome, 'test setup must isolate the state home').toBeTruthy();
    const handle = startHeartbeat(projectDir);
    try {
      const statusDir = path.join(path.resolve(stateHome as string), 'status');
      expect(handle.path.startsWith(statusDir)).toBe(true);
      expect(handle.legacyPath.startsWith(statusDir)).toBe(true);
      expect(fs.existsSync(handle.path)).toBe(true);
      expect(fs.existsSync(handle.legacyPath)).toBe(true);
    } finally {
      handle.stop();
    }
  });

  it('still writes the $TMPDIR copies a pre-TRA-869 hook reads', () => {
    const real = fs.realpathSync(projectDir);
    const tmpStatus = path.join(TMP_BASE, `trace-mcp-status-${projectHash(real)}.json`);
    const tmpLegacy = path.join(TMP_BASE, `trace-mcp-alive-${projectHash(real)}`);
    const handle = startHeartbeat(projectDir);
    try {
      expect(fs.existsSync(tmpStatus)).toBe(true);
      expect(fs.existsSync(tmpLegacy)).toBe(true);
    } finally {
      handle.stop();
    }
    // stop() clears both locations, so a stopped server never looks alive.
    expect(fs.existsSync(tmpStatus)).toBe(false);
    expect(fs.existsSync(tmpLegacy)).toBe(false);
  });

  it('writes a JSON status file with required fields', () => {
    const handle = startHeartbeat(projectDir);
    try {
      expect(fs.existsSync(handle.path)).toBe(true);
      const status = JSON.parse(fs.readFileSync(handle.path, 'utf-8'));
      expect(status.schema).toBe(2);
      expect(status.pid).toBe(process.pid);
      expect(status.transport).toBe('stdio');
      expect(typeof status.started_at).toBe('string');
      expect(typeof status.last_heartbeat_at).toBe('string');
      expect(status.last_successful_tool_call_at).toBeNull();
      expect(status.tool_calls_total).toBe(0);
      expect(status.tool_calls_failed).toBe(0);
      // stdio: the client spawned this process and holds its pipes.
      expect(status.mcp_sessions_active).toBe(1);
    } finally {
      handle.stop();
    }
  });

  it('reports no attached session for a transport that tracks its own', () => {
    const handle = startHeartbeat(projectDir, 'http');
    try {
      const status = JSON.parse(fs.readFileSync(handle.path, 'utf-8'));
      expect(status.mcp_sessions_active).toBe(0);
    } finally {
      handle.stop();
    }
  });

  it('records the transport passed to startHeartbeat', () => {
    const handle = startHeartbeat(projectDir, 'http');
    try {
      const status = JSON.parse(fs.readFileSync(handle.path, 'utf-8'));
      expect(status.transport).toBe('http');
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
