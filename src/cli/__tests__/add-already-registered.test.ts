import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// GH #297 / TRA-55: `trace-mcp add .` on a registered project used to stop at
// "already registered" with no way forward except guessing. Both output modes
// now point at `trace-mcp index <dir>` (the usual intent) and `--force`.

describe('add: already-registered hint (TRA-55)', () => {
  let tmpHome: string;
  let projectDir: string;
  let registry: typeof import('../../registry.js');
  let add: typeof import('../add.js');

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-add-'));
    fs.mkdirSync(path.join(tmpHome, 'proj'), { recursive: true });
    projectDir = fs.realpathSync(path.join(tmpHome, 'proj'));
    fs.writeFileSync(path.join(projectDir, 'package.json'), '{"name":"proj"}');
    vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
    vi.resetModules();
    registry = await import('../../registry.js');
    add = await import('../add.js');
    registry.registerProject(projectDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('emits a reindex hint in --json output', async () => {
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((v) => void lines.push(String(v)));

    await add.addCommand.parseAsync(['node', 'add', projectDir, '--json']);

    log.mockRestore();
    const payload = JSON.parse(lines.join('\n'));
    expect(payload.status).toBe('already_registered');
    expect(payload.hint).toContain(`trace-mcp index ${projectDir}`);
    expect(payload.hint).toContain('--force');
  });
});
