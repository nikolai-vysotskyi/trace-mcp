import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveServeRoots } from '../project-root.js';

// TRA-1087: serve's session root. The override has to replace cwd for the whole
// session — it previously reached only the auto-register check, so a client
// launched in the wrong directory kept serving that directory silently.
describe('resolveServeRoots', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-serve-roots-')));
    vi.stubEnv('TRACE_MCP_REPO_ROOT', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('falls back to cwd with no override and no worktree', () => {
    const r = resolveServeRoots(tmp);
    expect(r).toMatchObject({ cwd: tmp, projectRoot: tmp, indexRoot: tmp, envOverride: null });
  });

  it('serves the override instead of cwd', () => {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(tmp, 'elsewhere'), { recursive: true });
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, 'package.json'), '{}');
    vi.stubEnv('TRACE_MCP_REPO_ROOT', repo);

    const r = resolveServeRoots(path.join(tmp, 'elsewhere'));
    expect(r.projectRoot).toBe(repo);
    expect(r.indexRoot).toBe(repo);
    expect(r.envOverride).toBe(repo);
  });
});
