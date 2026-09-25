import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveServeRoots } from '../../src/project-root.js';

// GH#1371 edge 1 / TRA-1915: dist/proxy.js (src/proxy-entry.ts) — the path the
// shim (~/.trace/bin/trace) uses — must resolve the session root exactly like
// `trace-mcp serve` (src/cli.ts): via resolveServeRoots, honouring
// TRACE_MCP_REPO_ROOT. Previously proxy main() bound projectRoot to
// process.cwd() while only serve honoured the env var.
describe('proxy/serve session-root parity (TRA-1915)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-proxy-roots-')));
    vi.stubEnv('TRACE_MCP_REPO_ROOT', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('resolveServeRoots honours TRACE_MCP_REPO_ROOT over cwd (shared by serve + proxy)', () => {
    const repo = path.join(tmp, 'repo');
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(repo, 'package.json'), '{}');
    vi.stubEnv('TRACE_MCP_REPO_ROOT', repo);

    const r = resolveServeRoots(elsewhere);
    expect(r.projectRoot).toBe(repo);
    expect(r.indexRoot).toBe(repo);
    expect(r.envOverride).toBe(repo);
  });

  it('src/proxy-entry.ts resolves the session root via resolveServeRoots (not cwd)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'proxy-entry.ts'), 'utf8');
    // Both entry points share the same resolver.
    expect(src).toContain('resolveServeRoots()');
    expect(src).toContain("from './project-root.js'");
    // Regression guard: the old binding this edge reported.
    expect(src).not.toContain('const projectRoot = process.cwd()');
    // Full parity with serve: worktree sharing + env-override logging.
    expect(src).toContain('worktreeMainRoot');
    expect(src).toContain('envOverride');
  });
});
