import { describe, expect, it } from 'vitest';
import { TOOL_PRESETS } from '../../tools/project/presets.js';
import { getLabArm, isLabArmId, LAB_ARMS } from '../arms.js';

describe('lab arms', () => {
  it('ships exactly the v1 surface: control plus our two presets', () => {
    expect(LAB_ARMS.map((a) => a.id)).toEqual(['file-reading', 'minimal', 'standard']);
  });

  it('the control arm touches no index tool', () => {
    expect(getLabArm('file-reading')?.tools).toEqual([]);
  });

  it('preset arms stay subsets of the shipped presets they are named after', () => {
    for (const id of ['minimal', 'standard'] as const) {
      const preset = TOOL_PRESETS[id];
      const armTools = getLabArm(id)?.tools ?? [];
      expect(Array.isArray(preset)).toBe(true);
      expect(armTools.length).toBeGreaterThan(0);
      for (const tool of armTools) {
        expect(preset as string[], `${id} arm tool ${tool}`).toContain(tool);
      }
    }
  });

  it('the drivers behind each arm are actually on that arm', () => {
    // driveMinimal uses search/search_text/query_decisions; driveStandard adds
    // get_symbol and packContext (get_context_bundle's engine). If a preset
    // ever drops one of these, the arm silently stops measuring what it says.
    const minimal = new Set(getLabArm('minimal')?.tools ?? []);
    for (const tool of ['search', 'search_text', 'query_decisions']) {
      expect(minimal.has(tool), `minimal carries ${tool}`).toBe(true);
    }
    const standard = new Set(getLabArm('standard')?.tools ?? []);
    for (const tool of ['search', 'get_symbol', 'get_context_bundle', 'query_decisions']) {
      expect(standard.has(tool), `standard carries ${tool}`).toBe(true);
    }
  });

  it('rejects unknown arm ids', () => {
    expect(getLabArm('codegraph')).toBeUndefined();
    expect(isLabArmId('codegraph')).toBe(false);
    expect(isLabArmId('minimal')).toBe(true);
  });
});
