import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installCursorRules } from '../../src/init/ide-rules.js';
import { TRACE_ROUTING_BLOCK } from '../../src/init/md-block.js';

/**
 * The state tools (TRA-596) are deferred behind `load_tools`, so the generated
 * routing files are the only thing that tells an agent they exist. Two
 * generators write those files and they drift independently — this pins the
 * SKILL.state row into both.
 */
describe('SKILL.state routing', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const mustRoute = (text: string) => {
    expect(text).toContain('trace_state_init');
    expect(text).toContain('trace_state_patch');
    expect(text).toContain('trace_state_get');
    // Deferred outside `full`/`state`, so the escalation call has to be named
    // alongside the tools or the row points at something unreachable.
    expect(text).toContain('load_tools({preset:"state"})');
  };

  it('names the state tools in the CLAUDE.md / AGENTS.md block', () => {
    mustRoute(TRACE_ROUTING_BLOCK);
  });

  it('names the state tools in the Cursor/Windsurf rules', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-state-routing-'));
    tmpDirs.push(dir);

    const result = installCursorRules(dir, {});
    expect(result.action).toBe('created');
    mustRoute(fs.readFileSync(result.target, 'utf-8'));
  });
});
