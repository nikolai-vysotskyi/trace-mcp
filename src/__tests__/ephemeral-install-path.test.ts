/**
 * TRA-1807: the live daemon must never run from an ephemeral install.
 * `isEphemeralInstallPath` is the shared classifier behind the `serve-http`
 * fail-closed guard (src/cli.ts) and the postinstall refusal
 * (scripts/postinstall-control-plane.mjs, mirrored regexes — keep in sync).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDevCheckoutEntry, isEphemeralInstallPath } from '../global.js';

describe('isEphemeralInstallPath (TRA-1807)', () => {
  it('refuses the exact incident shape: sandbox task dir install', () => {
    expect(
      isEphemeralInstallPath(
        '/private/tmp/multica-task-3847237843/pinned-latest/node_modules/trace-mcp/dist/cli.js',
      ),
    ).toBe(true);
    expect(
      isEphemeralInstallPath(
        '/private/tmp/multica-task-3847237843/pinned/node_modules/trace-mcp/dist/cli.js',
      ),
    ).toBe(true);
  });

  it('refuses shared tmp roots', () => {
    expect(isEphemeralInstallPath('/tmp/trace-mcp/dist/cli.js')).toBe(true);
    expect(isEphemeralInstallPath('/private/tmp/trace-mcp/dist/cli.js')).toBe(true);
    expect(isEphemeralInstallPath('/tmp')).toBe(true);
    expect(isEphemeralInstallPath('/private/tmp')).toBe(true);
  });

  it('refuses one-shot workdir checkouts and scratchpads', () => {
    expect(
      isEphemeralInstallPath(
        '/Users/n/multica_workspaces/tracemcp-abc/tra-1-xyz/workdir/node_modules/trace-mcp',
      ),
    ).toBe(true);
    expect(
      isEphemeralInstallPath('/private/tmp/claude-501/abc/def/scratchpad/node_modules/trace-mcp'),
    ).toBe(true);
  });

  it('does not confuse lookalikes (/tmpfoo, unbracketed multica-task)', () => {
    expect(isEphemeralInstallPath('/tmpfoo/trace-mcp')).toBe(false);
    expect(isEphemeralInstallPath('/private/tmp-backup/trace-mcp')).toBe(false);
    // The task-dir pattern keys on a numeric run id + trailing separator —
    // a user directory merely named "multica-task" is not ephemeral.
    expect(isEphemeralInstallPath('/Users/n/multica-task/dist/cli.js')).toBe(false);
  });

  it('accepts stable installs', () => {
    expect(
      isEphemeralInstallPath('/Users/nikolai/.hermes/node/lib/node_modules/trace-mcp/dist/cli.js'),
    ).toBe(false);
    expect(
      isEphemeralInstallPath(
        '/Users/nikolai/Library/Application Support/Herd/config/nvm/versions/node/v22.22.2/lib/node_modules/trace-mcp/dist/cli.js',
      ),
    ).toBe(false);
    expect(isEphemeralInstallPath('/usr/local/lib/node_modules/trace-mcp/dist/cli.js')).toBe(false);
    expect(isEphemeralInstallPath('/Users/nikolai/.trace/bin/trace')).toBe(false);
    expect(isEphemeralInstallPath('/Users/nikolai/PhpstormProjects/trace-mcp')).toBe(false);
  });
});

describe('isDevCheckoutEntry (TRA-1807 serve-http exemption)', () => {
  it('exempts entries under a .git checkout', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-1807-dev-'));
    try {
      fs.mkdirSync(path.join(root, '.git'));
      const entry = path.join(root, 'dist', 'cli.js');
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.writeFileSync(entry, '// fake\n');
      expect(isDevCheckoutEntry(entry)).toBe(true);
      // src-layout entry (tsx src/cli.ts) is covered by the same walk.
      expect(isDevCheckoutEntry(path.join(root, 'src', 'cli.ts'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not exempt npm-installed trees without .git', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-1807-npm-'));
    try {
      const entry = path.join(root, 'node_modules', 'trace-mcp', 'dist', 'cli.js');
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.writeFileSync(entry, '// fake\n');
      expect(isDevCheckoutEntry(entry)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
