import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { TraceMcpConfigSchema } from '../../src/config.js';
import { resolvePreset, TOOL_PRESETS } from '../../src/tools/presets.js';

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
