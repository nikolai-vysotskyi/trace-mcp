/**
 * TRA-1534: the empty-index hint must name the session root and point at the
 * cross-project relay, so the agent doesn't narrate a vague "empty session
 * DB" on every call.
 */
import { describe, expect, it } from 'vitest';
import { emptyIndexHint } from '../../../src/tools/navigation/zero-index.js';

describe('emptyIndexHint()', () => {
  it('names the empty root and the capability', () => {
    const hint = emptyIndexHint('/Users/nikolai/workdir', 'full symbol search');
    expect(hint).toContain('/Users/nikolai/workdir');
    expect(hint).toContain('full symbol search');
  });

  it('points at list_projects + call_project_tool', () => {
    const hint = emptyIndexHint('/r', 'full symbol extraction');
    expect(hint).toContain('list_projects');
    expect(hint).toContain('call_project_tool');
  });

  it('mentions reindex for the local root', () => {
    expect(emptyIndexHint('/r', 'x')).toContain('reindex');
  });
});
