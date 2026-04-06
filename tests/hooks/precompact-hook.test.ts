import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const HOOK_SCRIPT = path.resolve('hooks/trace-mcp-precompact.sh');
const TRACE_MCP_HOME = path.join(os.homedir(), '.trace-mcp');

describe('trace-mcp-precompact.sh', () => {
  // Use realpath to match what pwd -L returns from within execSync
  const testProjectDir = path.join(fs.realpathSync(os.tmpdir()), `trace-mcp-hook-test-${Date.now()}`);
  let projectHash: string;
  let snapshotPath: string;

  function getProjectHash(dir: string): string {
    return crypto.createHash('sha256').update(dir).digest('hex').slice(0, 12);
  }

  afterEach(() => {
    // Clean up snapshot file
    if (snapshotPath && fs.existsSync(snapshotPath)) {
      fs.unlinkSync(snapshotPath);
    }
    if (fs.existsSync(testProjectDir)) {
      fs.rmSync(testProjectDir, { recursive: true });
    }
  });

  it('exits silently when no snapshot file exists', () => {
    fs.mkdirSync(testProjectDir, { recursive: true });
    const result = execSync(`bash ${HOOK_SCRIPT}`, {
      cwd: testProjectDir,
      encoding: 'utf-8',
      timeout: 5000,
    });
    // Should produce no output
    expect(result.trim()).toBe('');
  });

  it('outputs systemMessage when snapshot file exists', () => {
    fs.mkdirSync(testProjectDir, { recursive: true });
    projectHash = getProjectHash(testProjectDir);
    const sessionsDir = path.join(TRACE_MCP_HOME, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    snapshotPath = path.join(sessionsDir, `${projectHash}-snapshot.json`);

    const snapshotData = {
      timestamp: Date.now(),
      markdown: '## Session Snapshot (trace-mcp)\n**Duration:** 5m | **Files explored:** 10 | **Tool calls:** 25',
      structured: { total_calls: 25, files_explored: 10 },
      estimated_tokens: 50,
    };
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshotData));

    const result = execSync(`bash ${HOOK_SCRIPT}`, {
      cwd: testProjectDir,
      encoding: 'utf-8',
      timeout: 5000,
    });

    const output = JSON.parse(result.trim());
    expect(output.systemMessage).toContain('Session Snapshot (trace-mcp)');
    expect(output.systemMessage).toContain('Files explored:** 10');
  });

  it('skips stale snapshot files (older than 10 minutes)', () => {
    fs.mkdirSync(testProjectDir, { recursive: true });
    projectHash = getProjectHash(testProjectDir);
    const sessionsDir = path.join(TRACE_MCP_HOME, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    snapshotPath = path.join(sessionsDir, `${projectHash}-snapshot.json`);

    const snapshotData = {
      timestamp: Date.now() - 700_000, // 11+ minutes ago
      markdown: '## Old snapshot',
      structured: {},
      estimated_tokens: 10,
    };
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshotData));

    // Touch the file to make it old (set mtime to 11 minutes ago)
    const oldTime = new Date(Date.now() - 700_000);
    fs.utimesSync(snapshotPath, oldTime, oldTime);

    const result = execSync(`bash ${HOOK_SCRIPT}`, {
      cwd: testProjectDir,
      encoding: 'utf-8',
      timeout: 5000,
    });

    // Should produce no output (stale file)
    expect(result.trim()).toBe('');
  });
});
