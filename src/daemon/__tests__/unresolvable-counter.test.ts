import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { STATUS_DIR } from '../../global.js';
import {
  __resetUnresolvableCounterForTests,
  readUnresolvableState,
  recordUnresolvableResolution,
  unresolvableFilePath,
} from '../unresolvable-counter.js';

// TRA-1791: the daemon exposes unroutable /mcp resolutions (ambiguous /
// no-projects, notably cwd=/ hints dropped as dangerous) to the guard hook
// via a daemon-wide counter file — those requests never reach a per-project
// session, so no consultation marker can ever be earned.

afterEach(() => {
  __resetUnresolvableCounterForTests();
});

describe('unresolvable-counter', () => {
  it('starts empty when no file exists', () => {
    const state = readUnresolvableState();
    expect(state.total).toBe(0);
    expect(state.last_at).toBeNull();
  });

  it('counts ambiguous resolutions', () => {
    recordUnresolvableResolution({ kind: 'ambiguous' });
    recordUnresolvableResolution({ kind: 'ambiguous' });
    const state = readUnresolvableState();
    expect(state.total).toBe(2);
    expect(state.ambiguous).toBe(2);
    expect(state.no_projects).toBe(0);
    expect(state.last_kind).toBe('ambiguous');
    expect(state.last_at).not.toBeNull();
  });

  it('counts no-projects and dangerous-hint drops with hint detail', () => {
    recordUnresolvableResolution({
      kind: 'ambiguous',
      ignoredDangerousHint: { projectRoot: '/', reason: 'filesystem root', via: 'query' },
    });
    const state = readUnresolvableState();
    expect(state.total).toBe(1);
    expect(state.dangerous_hint_dropped).toBe(1);
    expect(state.last_hint).toBe('/');
    expect(state.last_reason).toBe('filesystem root');
    expect(state.last_via).toBe('query');
  });

  it('ignores resolved requests', () => {
    recordUnresolvableResolution({ kind: 'resolved' });
    expect(readUnresolvableState().total).toBe(0);
    expect(fs.existsSync(unresolvableFilePath())).toBe(false);
  });

  it('writes inside STATUS_DIR', () => {
    recordUnresolvableResolution({ kind: 'no-projects' });
    expect(path.dirname(unresolvableFilePath())).toBe(STATUS_DIR);
    expect(fs.existsSync(unresolvableFilePath())).toBe(true);
  });
});
