import { describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema } from '../../src/config.js';
import { resolvePreset, TOOL_PRESETS } from '../../src/tools/project/presets.js';

describe('Tool config schema', () => {
  it('accepts descriptions override in tools config', () => {
    const result = TraceMcpConfigSchema.safeParse({
      tools: {
        preset: 'full',
        descriptions: {
          search: 'Find symbols by name.',
          get_outline: 'List symbols in a file.',
        },
      },
    });
    expect(result.success).toBe(true);
    expect(result.data?.tools?.descriptions).toEqual({
      search: 'Find symbols by name.',
      get_outline: 'List symbols in a file.',
    });
  });

  it('accepts exclude list in tools config', () => {
    const result = TraceMcpConfigSchema.safeParse({
      tools: {
        exclude: ['get_nova_resource', 'get_livewire_context'],
      },
    });
    expect(result.success).toBe(true);
    expect(result.data?.tools?.exclude).toEqual(['get_nova_resource', 'get_livewire_context']);
  });

  it('accepts include list in tools config', () => {
    const result = TraceMcpConfigSchema.safeParse({
      tools: {
        include: ['search', 'get_outline'],
      },
    });
    expect(result.success).toBe(true);
    expect(result.data?.tools?.include).toEqual(['search', 'get_outline']);
  });

  it('defaults to full preset', () => {
    const result = TraceMcpConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    // tools is optional, so undefined means full
  });

  it('rejects non-string values in descriptions', () => {
    const result = TraceMcpConfigSchema.safeParse({
      tools: {
        descriptions: { search: 123 },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('instructions_verbosity config', () => {
  it('accepts full/minimal/none', () => {
    for (const v of ['full', 'minimal', 'none'] as const) {
      const result = TraceMcpConfigSchema.safeParse({
        tools: { instructions_verbosity: v },
      });
      expect(result.success).toBe(true);
      expect(result.data?.tools?.instructions_verbosity).toBe(v);
    }
  });

  it('defaults to full', () => {
    const result = TraceMcpConfigSchema.safeParse({ tools: {} });
    expect(result.success).toBe(true);
    expect(result.data?.tools?.instructions_verbosity).toBe('full');
  });

  it('rejects invalid verbosity', () => {
    const result = TraceMcpConfigSchema.safeParse({
      tools: { instructions_verbosity: 'ultra' },
    });
    expect(result.success).toBe(false);
  });
});

describe('description_verbosity config', () => {
  it('accepts full/minimal/none', () => {
    for (const v of ['full', 'minimal', 'none'] as const) {
      const result = TraceMcpConfigSchema.safeParse({
        tools: { description_verbosity: v },
      });
      expect(result.success).toBe(true);
      expect(result.data?.tools?.description_verbosity).toBe(v);
    }
  });

  it('defaults to full', () => {
    const result = TraceMcpConfigSchema.safeParse({ tools: {} });
    expect(result.success).toBe(true);
    expect(result.data?.tools?.description_verbosity).toBe('full');
  });

  it('rejects invalid verbosity', () => {
    const result = TraceMcpConfigSchema.safeParse({
      tools: { description_verbosity: 'ultra' },
    });
    expect(result.success).toBe(false);
  });

  it('minimal strips to first sentence', () => {
    // Simulate the logic from server.ts
    function applyVerbosity(description: string, verbosity: string): string {
      if (verbosity === 'full') return description;
      if (verbosity === 'none') return '';
      const match = description.match(/^[^.]*\./);
      return match ? match[0] : description.split('\n')[0];
    }

    expect(
      applyVerbosity('Search symbols by name. Supports fuzzy matching and filters.', 'minimal'),
    ).toBe('Search symbols by name.');
    expect(applyVerbosity('Get outline\nMore details here', 'minimal')).toBe('Get outline');
    expect(applyVerbosity('No period at all', 'minimal')).toBe('No period at all');
    expect(applyVerbosity('Any description.', 'none')).toBe('');
  });

  it('minimal and none strip Zod param descriptions', () => {
    const { z } = require('zod');
    function stripParamDescriptions(schema: Record<string, unknown>): void {
      for (const val of Object.values(schema)) {
        if (val && typeof val === 'object' && '_def' in val) {
          const def = (val as { _def: Record<string, unknown> })._def;
          delete def.description;
          delete (val as Record<string, unknown>).description;
        }
      }
    }

    const schema = {
      query: z.string().describe('Search query text'),
      kind: z.string().optional().describe('Filter by kind'),
    };
    expect(schema.query.description).toBe('Search query text');
    expect(schema.kind.description).toBe('Filter by kind');

    stripParamDescriptions(schema);
    expect(schema.query.description).toBeUndefined();
    expect(schema.kind.description).toBeUndefined();
    expect(schema.query._def.description).toBeUndefined();
    expect(schema.kind._def.description).toBeUndefined();
    // Zod types still work after stripping
    expect(schema.query.safeParse('test').success).toBe(true);
  });
});

describe('meta_fields config', () => {
  it('accepts boolean true (all meta)', () => {
    const result = TraceMcpConfigSchema.safeParse({
      tools: { meta_fields: true },
    });
    expect(result.success).toBe(true);
    expect(result.data?.tools?.meta_fields).toBe(true);
  });

  it('accepts boolean false (no meta)', () => {
    const result = TraceMcpConfigSchema.safeParse({
      tools: { meta_fields: false },
    });
    expect(result.success).toBe(true);
    expect(result.data?.tools?.meta_fields).toBe(false);
  });

  it('accepts array of specific fields', () => {
    const result = TraceMcpConfigSchema.safeParse({
      tools: { meta_fields: ['_hints', '_budget_warning'] },
    });
    expect(result.success).toBe(true);
    expect(result.data?.tools?.meta_fields).toEqual(['_hints', '_budget_warning']);
  });

  it('rejects unknown meta field names', () => {
    const result = TraceMcpConfigSchema.safeParse({
      tools: { meta_fields: ['_hints', '_unknown'] },
    });
    expect(result.success).toBe(false);
  });

  it('defaults to true', () => {
    const result = TraceMcpConfigSchema.safeParse({ tools: {} });
    expect(result.success).toBe(true);
    expect(result.data?.tools?.meta_fields).toBe(true);
  });

  it('stripMetaFields removes all keys when false', () => {
    // Simulate the logic from server.ts
    const META_KEYS = [
      '_hints',
      '_budget_warning',
      '_budget_level',
      '_duplicate_warning',
      '_meta',
    ] as const;
    function stripMetaFields(
      obj: Record<string, unknown>,
      metaFieldsConfig: boolean | string[],
    ): void {
      if (metaFieldsConfig === true) return;
      if (metaFieldsConfig === false) {
        for (const key of META_KEYS) delete obj[key];
        return;
      }
      const allowed = new Set(metaFieldsConfig);
      for (const key of META_KEYS) {
        if (!allowed.has(key)) delete obj[key];
      }
    }

    const obj1 = {
      data: 'test',
      _hints: [{ tool: 'x' }],
      _budget_warning: 'high',
      _meta: { warnings: [] },
    };
    stripMetaFields(obj1, false);
    expect(obj1).toEqual({ data: 'test' });

    const obj2 = {
      data: 'test',
      _hints: [{ tool: 'x' }],
      _budget_warning: 'high',
      _meta: { warnings: [] },
    };
    stripMetaFields(obj2, ['_hints']);
    expect(obj2).toEqual({ data: 'test', _hints: [{ tool: 'x' }] });

    const obj3 = { data: 'test', _hints: [{ tool: 'x' }] };
    stripMetaFields(obj3, true);
    expect(obj3).toEqual({ data: 'test', _hints: [{ tool: 'x' }] }); // unchanged
  });
});

describe('Tool presets', () => {
  it('minimal preset includes search_text', () => {
    const minimal = TOOL_PRESETS.minimal;
    expect(Array.isArray(minimal)).toBe(true);
    expect((minimal as string[]).includes('search_text')).toBe(true);
  });

  it('standard preset includes search_text', () => {
    const standard = TOOL_PRESETS.standard;
    expect(Array.isArray(standard)).toBe(true);
    expect((standard as string[]).includes('search_text')).toBe(true);
  });

  it('resolvePreset returns set for known preset', () => {
    const result = resolvePreset('minimal');
    expect(result).toBeInstanceOf(Set);
    expect((result as Set<string>).has('search')).toBe(true);
  });

  it('resolvePreset returns "all" for full', () => {
    expect(resolvePreset('full')).toBe('all');
  });

  it('resolvePreset returns null for unknown', () => {
    expect(resolvePreset('nonexistent')).toBeNull();
  });

  it('toolAllowed logic: exclude takes precedence over include', () => {
    // Simulate the logic from server.ts
    const excludeSet = new Set(['search']);
    const includeSet = new Set(['search', 'get_outline']);
    const activePreset: Set<string> | 'all' = 'all';

    function toolAllowed(name: string): boolean {
      if (excludeSet.has(name)) return false;
      if (includeSet.has(name)) return true;
      if (activePreset === 'all') return true;
      return activePreset.has(name);
    }

    expect(toolAllowed('search')).toBe(false); // excluded wins
    expect(toolAllowed('get_outline')).toBe(true); // included
    expect(toolAllowed('get_symbol')).toBe(true); // not in exclude, preset=all
  });

  it('toolAllowed logic: preset restricts tools', () => {
    const excludeSet: Set<string> | null = null;
    const includeSet: Set<string> | null = null;
    const activePreset = new Set(['search', 'get_outline']);

    function toolAllowed(name: string): boolean {
      if (excludeSet?.has(name)) return false;
      if (includeSet?.has(name)) return true;
      if (activePreset === 'all') return true;
      return activePreset.has(name);
    }

    expect(toolAllowed('search')).toBe(true);
    expect(toolAllowed('get_outline')).toBe(true);
    expect(toolAllowed('predict_bugs')).toBe(false); // not in preset
  });
});
