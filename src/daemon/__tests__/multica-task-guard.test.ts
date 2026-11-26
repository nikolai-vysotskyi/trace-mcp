import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findMulticaTaskRoot, multicaTaskDaemonRefusal } from '../multica-task-guard.js';

describe('Multica task daemon guard', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function task(): { root: string; entry: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-multica-task-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, '.task_owner'), JSON.stringify({ task_id: 'task-123' }));
    const entry = path.join(root, 'workdir', 'trace-mcp', 'dist', 'cli.js');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    return { root, entry };
  }

  it('refuses a task-local checkout before it can bind a port', () => {
    const { root, entry } = task();
    expect(findMulticaTaskRoot(entry, '/')).toBe(root);
    expect(multicaTaskDaemonRefusal(entry, '/', false)).toMatch(/cannot run directly/);
  });

  it('also catches a stable CLI launched from a task working directory', () => {
    const { root, entry } = task();
    expect(findMulticaTaskRoot('/stable/cli.js', path.dirname(entry))).toBe(root);
    expect(multicaTaskDaemonRefusal('/stable/cli.js', path.dirname(entry), false)).not.toBeNull();
  });

  it('allows a deliberate opt-in and non-task launches', () => {
    const { entry } = task();
    expect(multicaTaskDaemonRefusal(entry, '/', true)).toBeNull();
    expect(multicaTaskDaemonRefusal('/stable/cli.js', '/', false)).toBeNull();
  });
});
