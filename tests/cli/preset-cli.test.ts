import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { resolvePresetName } from '../../src/server/tool-filter.js';
import { loadConfig } from '../../src/config.js';
import { resolvePreset, listPresets, TOOL_PRESETS } from '../../src/tools/project/presets.js';

describe('CLI --preset option & env integration (TRA-603)', () => {
  it('parses --preset flag on serve command definition', () => {
    let capturedPreset: string | undefined;

    const program = new Command();
    program
      .command('serve', { isDefault: true })
      .option('--preset <name>', 'Tool preset')
      .action((opts: { preset?: string }) => {
        capturedPreset = opts.preset;
      });

    program.parse(['node', 'trace-mcp', 'serve', '--preset', 'review']);
    expect(capturedPreset).toBe('review');
  });

  it('parses --preset flag when serve is invoked as default command', () => {
    let capturedPreset: string | undefined;

    const program = new Command();
    program
      .command('serve', { isDefault: true })
      .option('--preset <name>', 'Tool preset')
      .action((opts: { preset?: string }) => {
        capturedPreset = opts.preset;
      });

    program.parse(['node', 'trace-mcp', '--preset', 'security']);
    expect(capturedPreset).toBe('security');
  });

  it('resolves all role presets in resolvePreset', () => {
    const roles = [
      'dev',
      'security',
      'design',
      'perf',
      'review',
      'architecture',
      'minimal',
      'standard',
    ];
    for (const role of roles) {
      const resolved = resolvePreset(role);
      expect(resolved).toBeInstanceOf(Set);
      expect((resolved as Set<string>).size).toBeGreaterThan(0);
      expect((resolved as Set<string>).has('search')).toBe(true);
      expect((resolved as Set<string>).has('batch')).toBe(true);
      expect((resolved as Set<string>).has('register_edit')).toBe(true);
      expect((resolved as Set<string>).has('get_symbol')).toBe(true);
    }
  });

  it('lists all role presets in listPresets', () => {
    const list = listPresets();
    const names = list.map((p) => p.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'minimal',
        'standard',
        'full',
        'review',
        'dev',
        'security',
        'design',
        'perf',
        'architecture',
      ]),
    );
  });

  it('TRACE_MCP_PRESET env var overrides config in loadConfig and resolvePresetName', async () => {
    const oldEnv = process.env.TRACE_MCP_PRESET;
    try {
      process.env.TRACE_MCP_PRESET = 'perf';
      const configRes = await loadConfig();
      expect(configRes.isOk()).toBe(true);
      if (configRes.isOk()) {
        expect(configRes.value.tools?.preset).toBe('perf');
        expect(resolvePresetName(configRes.value)).toBe('perf');
      }
    } finally {
      if (oldEnv === undefined) {
        delete process.env.TRACE_MCP_PRESET;
      } else {
        process.env.TRACE_MCP_PRESET = oldEnv;
      }
    }
  });
});
