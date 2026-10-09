/**
 * A stdio proxy that routes a linked worktree to its canonical project binds
 * the daemon session to the canonical root, which loses the worktree identity.
 * It forwards the worktree path as `?worktree=` so the session can flag results
 * for files the branch changed (GH #1481). Anything else keeps the old URL.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProxyBackend, type ProxyTransport } from '../../src/daemon/router/proxy-backend.js';
import { REGISTRY_PATH } from '../../src/global.js';
import { createTmpDir, removeTmpDir } from '../test-utils.js';

function runGit(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  });
}

class NullTransport implements ProxyTransport {
  onmessage?: (msg: JSONRPCMessage) => void;
  onerror?: (err: Error) => void;
  async start(): Promise<void> {}
  async close(): Promise<void> {}
  async send(): Promise<void> {}
}

describe.skipIf(process.platform === 'win32')('ProxyBackend worktree hint', () => {
  let tmpDir: string;
  let savedRegistry: string | null;
  let urls: string[];

  beforeEach(() => {
    tmpDir = fs.realpathSync(createTmpDir('proxy-worktree-'));
    savedRegistry = fs.existsSync(REGISTRY_PATH) ? fs.readFileSync(REGISTRY_PATH, 'utf-8') : null;
    urls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    removeTmpDir(tmpDir);
    if (savedRegistry !== null) fs.writeFileSync(REGISTRY_PATH, savedRegistry);
    else if (fs.existsSync(REGISTRY_PATH)) fs.rmSync(REGISTRY_PATH);
  });

  function register(root: string): void {
    fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
    fs.writeFileSync(
      REGISTRY_PATH,
      JSON.stringify({
        version: 1,
        projects: {
          [root]: {
            name: 'main-repo',
            root,
            dbPath: path.join(root, '.trace-mcp', 'index.db'),
            lastIndexed: null,
            addedAt: new Date().toISOString(),
          },
        },
      }),
    );
  }

  async function startFor(projectRoot: string): Promise<string> {
    const backend = new ProxyBackend({
      daemonUrl: 'http://127.0.0.1:65535',
      projectRoot,
      clientId: 'test-client',
      transportFactory: (mcpUrl) => {
        urls.push(mcpUrl);
        return new NullTransport();
      },
    });
    await backend.start();
    return urls[0];
  }

  function makeMainWithWorktree(): { main: string; linked: string } {
    const main = path.join(tmpDir, 'main');
    fs.mkdirSync(main);
    runGit(main, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(main, 'README.md'), '# main\n');
    runGit(main, 'add', '.');
    runGit(main, 'commit', '-q', '-m', 'init');
    register(main);
    const linked = path.join(tmpDir, 'wt-feature');
    runGit(main, 'worktree', 'add', '-q', '-b', 'feature', linked);
    return { main, linked };
  }

  it('binds to the canonical root and forwards the worktree path', async () => {
    const { main, linked } = makeMainWithWorktree();
    const url = new URL(await startFor(linked));
    expect(url.searchParams.get('project')).toBe(main);
    expect(url.searchParams.get('worktree')).toBe(linked);
  });

  it('forwards the worktree toplevel when the session starts in a subdirectory', async () => {
    const { main, linked } = makeMainWithWorktree();
    fs.mkdirSync(path.join(linked, 'src'));
    const url = new URL(await startFor(path.join(linked, 'src')));
    expect(url.searchParams.get('project')).toBe(main);
    expect(url.searchParams.get('worktree')).toBe(linked);
  });

  it('forwards the hint for a worktree nested inside the registered main checkout', async () => {
    const { main } = makeMainWithWorktree();
    const nested = path.join(main, '.claude', 'worktrees', 'inner');
    runGit(main, 'worktree', 'add', '-q', '-b', 'inner', nested);
    const url = new URL(await startFor(nested));
    // The registered main is an ordinary ancestor of the nested worktree.
    expect(url.searchParams.get('project')).toBe(main);
    expect(url.searchParams.get('worktree')).toBe(nested);
  });

  it('sends no worktree hint for a registered main checkout', async () => {
    const { main } = makeMainWithWorktree();
    const url = new URL(await startFor(main));
    expect(url.searchParams.get('project')).toBe(main);
    expect(url.searchParams.has('worktree')).toBe(false);
  });
});
