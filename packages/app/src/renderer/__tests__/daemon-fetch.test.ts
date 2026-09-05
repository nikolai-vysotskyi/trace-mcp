/**
 * Guard: no renderer read of the local daemon may be unbounded (TRA-934).
 *
 * Measured 2026-09-05 with the daemon's socket accepting and never answering:
 * Overview and Activity never produced a useful frame inside 30 s, because a
 * `fetch` with no signal against a wedged socket neither resolves nor rejects.
 * Every screen behind one of those stayed on a skeleton for the life of the
 * window. Workspace, which already passed a signal, gave up at 8.06 s and
 * painted its degraded state.
 *
 * This is a source-level check on purpose. The failure it prevents is somebody
 * adding the fifty-eighth `fetch(`${BASE}/…`)` a year from now, and no runtime
 * test of the other fifty-seven would notice.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const RENDERER = path.resolve(__dirname, '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__') continue;
      out.push(...sourceFiles(p));
    } else if (/\.tsx?$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/** `fetch(` calls whose URL is the local daemon, however it is spelled. */
const DAEMON_FETCH = /(?<![.\w])fetch\(\s*\n?\s*(`\$\{BASE\}|'http:\/\/127\.0\.0\.1:3741|`http:\/\/127\.0\.0\.1:3741)/g;

describe('daemon reads are bounded', () => {
  it('no renderer file calls bare fetch() against the daemon', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(RENDERER)) {
      // daemon-fetch.ts is the one place allowed to call fetch directly.
      if (path.basename(file) === 'daemon-fetch.ts') continue;
      const src = fs.readFileSync(file, 'utf-8');
      for (const m of src.matchAll(DAEMON_FETCH)) {
        const line = src.slice(0, m.index).split('\n').length;
        offenders.push(`${path.relative(RENDERER, file)}:${line}`);
      }
    }
    expect(offenders, 'use daemonFetch() from src/renderer/daemon-fetch.ts').toEqual([]);
  });
});
