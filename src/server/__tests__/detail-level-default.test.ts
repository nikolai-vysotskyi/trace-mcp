/**
 * `tools.default_detail_level` config knob (TRA-168 / GH #334 item 3) —
 * fills in `detail_level` from config only for tools that declare the param,
 * and only when the caller didn't already pass one explicitly.
 */
import { describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../config.js';
import { applyDetailLevelDefault, type GatedCallbackContext } from '../tool-gate-helpers.js';

function buildCtx(
  supportsDetailLevel: boolean,
  defaultDetailLevel: 'minimal' | 'default' | 'full' | undefined,
): GatedCallbackContext {
  return {
    name: 'search',
    config: { tools: { default_detail_level: defaultDetailLevel } } as TraceMcpConfig,
    supportsDetailLevel,
  } as unknown as GatedCallbackContext;
}

describe('applyDetailLevelDefault', () => {
  it('leaves params untouched when no config default is set', () => {
    const params: Record<string, unknown> = { query: 'foo' };
    applyDetailLevelDefault(buildCtx(true, undefined), params);
    expect(params.detail_level).toBeUndefined();
  });

  it('fills in the config default when the tool supports detail_level and the caller omitted it', () => {
    const params: Record<string, unknown> = { query: 'foo' };
    applyDetailLevelDefault(buildCtx(true, 'minimal'), params);
    expect(params.detail_level).toBe('minimal');
  });

  it('never overrides an explicit per-call detail_level', () => {
    const params: Record<string, unknown> = { query: 'foo', detail_level: 'full' };
    applyDetailLevelDefault(buildCtx(true, 'minimal'), params);
    expect(params.detail_level).toBe('full');
  });

  it('is a no-op for tools whose schema has no detail_level param', () => {
    const params: Record<string, unknown> = { query: 'foo' };
    applyDetailLevelDefault(buildCtx(false, 'minimal'), params);
    expect(params.detail_level).toBeUndefined();
  });
});
