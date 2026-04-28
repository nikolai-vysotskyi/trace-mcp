import { describe, expect, it } from 'vitest';
import { listPresets, resolvePreset, TOOL_PRESETS } from '../../src/tools/project/presets.js';

describe('Tool Presets', () => {
  describe('resolvePreset', () => {
    it('returns "all" for the full preset', () => {
      expect(resolvePreset('full')).toBe('all');
    });

    it('returns a Set for named presets', () => {
      const result = resolvePreset('minimal');
      expect(result).toBeInstanceOf(Set);
      expect((result as Set<string>).has('search')).toBe(true);
      expect((result as Set<string>).has('get_outline')).toBe(true);
      expect((result as Set<string>).has('get_project_map')).toBe(true);
    });

    it('returns null for unknown preset', () => {
      expect(resolvePreset('nonexistent')).toBeNull();
    });

    it('standard preset is a superset of minimal', () => {
      const minimal = resolvePreset('minimal') as Set<string>;
      const standard = resolvePreset('standard') as Set<string>;
      for (const tool of minimal) {
        expect(standard.has(tool)).toBe(true);
      }
    });

    it('review preset contains core review tools', () => {
      const review = resolvePreset('review') as Set<string>;
      expect(review.has('get_change_impact')).toBe(true);
      expect(review.has('get_tests_for')).toBe(true);
      expect(review.has('check_rename')).toBe(true);
    });

    it('architecture preset contains architecture tools', () => {
      const arch = resolvePreset('architecture') as Set<string>;
      expect(arch.has('get_circular_imports')).toBe(true);
      expect(arch.has('get_coupling')).toBe(true);
      expect(arch.has('get_pagerank')).toBe(true);
      expect(arch.has('check_architecture')).toBe(true);
    });
  });

  describe('listPresets', () => {
    it('returns all preset names with tool counts', () => {
      const presets = listPresets();
      const names = presets.map((p) => p.name);
      expect(names).toContain('minimal');
      expect(names).toContain('standard');
      expect(names).toContain('full');
      expect(names).toContain('review');
      expect(names).toContain('architecture');
    });

    it('full preset reports "all" as toolCount', () => {
      const presets = listPresets();
      const full = presets.find((p) => p.name === 'full');
      expect(full?.toolCount).toBe('all');
    });

    it('minimal preset reports a numeric toolCount', () => {
      const presets = listPresets();
      const minimal = presets.find((p) => p.name === 'minimal');
      expect(typeof minimal?.toolCount).toBe('number');
      expect(minimal?.toolCount).toBeGreaterThan(0);
    });
  });

  describe('TOOL_PRESETS integrity', () => {
    it('no preset has duplicate tool names', () => {
      for (const [name, tools] of Object.entries(TOOL_PRESETS)) {
        if (tools === 'all') continue;
        const unique = new Set(tools);
        expect(unique.size, `Preset "${name}" has duplicates`).toBe(tools.length);
      }
    });
  });
});
