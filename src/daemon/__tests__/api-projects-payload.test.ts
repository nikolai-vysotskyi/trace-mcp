import { describe, expect, it } from 'vitest';
import { buildApiProjectsList } from '../api-projects-payload.js';

// TRA-1996: GET /api/projects reports index-readiness (last-known `ready`
// for idle-unloaded roots, TRA-1052), while GET /health reports residency
// (`unloaded` for the same root). Both surfaces carry `resident` so callers
// correlate via that flag instead of comparing `status`.

describe('buildApiProjectsList', () => {
  it('marks resident projects with their live status', () => {
    const out = buildApiProjectsList([{ root: '/a', status: 'ready' }], [{ root: '/a' }]);
    expect(out).toEqual([{ root: '/a', status: 'ready', error: undefined, resident: true }]);
  });

  it('reports idle-unloaded roots as last-known ready with resident:false', () => {
    const out = buildApiProjectsList([], [{ root: '/evicted' }]);
    expect(out).toEqual([{ root: '/evicted', status: 'ready', resident: false }]);
  });

  it('keeps unregistered-but-resident subprojects visible', () => {
    const out = buildApiProjectsList([{ root: '/ephemeral', status: 'indexing' }], []);
    expect(out).toEqual([
      { root: '/ephemeral', status: 'indexing', error: undefined, resident: true },
    ]);
  });

  it('mixes resident, unloaded, and ephemeral roots', () => {
    const out = buildApiProjectsList(
      [
        { root: '/live', status: 'ready' },
        { root: '/ephemeral', status: 'error', error: 'boom' },
      ],
      [{ root: '/live' }, { root: '/evicted' }],
    );
    expect(out).toEqual([
      { root: '/live', status: 'ready', error: undefined, resident: true },
      { root: '/evicted', status: 'ready', resident: false },
      { root: '/ephemeral', status: 'error', error: 'boom', resident: true },
    ]);
  });
});
