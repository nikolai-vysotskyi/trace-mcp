/**
 * TRA-538 / TRA-711: silent rewrite of the presets we once shipped as THE
 * default — `full` (pre-TRA-402) and `standard` (between the two).
 *
 * Configs written before the default moved still pin every session to the old
 * surface — the key is present, so the additive config migration never touched
 * it. The rewrite has to be silent, one-shot per retired default, and unable to
 * undo a deliberate re-selection, which is what these tests pin down.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('tools.preset default migration (TRA-538)', () => {
  let tmpHome: string;
  let configPath: string;
  let configJsonc: typeof import('../config-jsonc.js');
  let shippedPreset: string;

  const writeConfig = (text: string) => fs.writeFileSync(configPath, text);
  const readPreset = () => {
    const parsed = parseJsonc(fs.readFileSync(configPath, 'utf8')) as {
      tools?: { preset?: string; preset_default_migrated?: boolean | number };
    };
    return parsed.tools ?? {};
  };

  beforeEach(async () => {
    tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-preset-')));
    vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
    vi.resetModules();
    const global = await import('../global.js');
    configJsonc = await import('../config-jsonc.js');
    configPath = global.GLOBAL_CONFIG_PATH;
    global.ensureGlobalDirs();
    shippedPreset = (parseJsonc(global.DEFAULT_CONFIG_JSONC) as { tools: { preset: string } }).tools
      .preset;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('rewrites our old default to the shipped one and marks the config', () => {
    writeConfig('{\n  "tools": {\n    // keep me\n    "preset": "full"\n  }\n}\n');

    const result = configJsonc.migrateGlobalConfig();

    expect(result.changed).toBe(true);
    expect(readPreset().preset).toBe(shippedPreset);
    expect(readPreset().preset_default_migrated).toBe(2);
    // Comments survive — this is a JSONC file a user edits by hand.
    expect(fs.readFileSync(configPath, 'utf8')).toContain('// keep me');
  });

  it('leaves a user-chosen preset untouched', () => {
    writeConfig('{\n  "tools": {\n    "preset": "review"\n  }\n}\n');

    configJsonc.migrateGlobalConfig();

    expect(readPreset().preset).toBe('review');
  });

  it('is idempotent, and never reverts a deliberate re-selection of full', () => {
    writeConfig('{\n  "tools": {\n    "preset": "full"\n  }\n}\n');
    configJsonc.migrateGlobalConfig();
    expect(readPreset().preset).toBe(shippedPreset);

    // Second run changes nothing.
    const before = fs.readFileSync(configPath, 'utf8');
    expect(configJsonc.migrateGlobalConfig().changed).toBe(false);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);

    // The user goes back to `full` on purpose; a later upgrade must respect it.
    configJsonc.modifyGlobalConfigJsonc(['tools', 'preset'], 'full');
    configJsonc.migrateGlobalConfig();
    expect(readPreset().preset).toBe('full');
  });

  // TRA-711: the field symptom was a developer machine advertising 55 tools
  // where `minimal` advertises 28 — a config still pinned to `standard`, the
  // default between `full` and `minimal`. The v1 rewrite only looked at
  // `full`, and its boolean marker then blocked any later one.
  it('rewrites the stale "standard" default even when the v1 rewrite already ran', () => {
    writeConfig(
      '{\n  "tools": {\n    "preset": "standard",\n    "preset_default_migrated": true\n  }\n}\n',
    );

    expect(configJsonc.migrateGlobalConfig().changed).toBe(true);

    expect(readPreset().preset).toBe(shippedPreset);
    expect(readPreset().preset_default_migrated).toBe(2);
  });

  it('never reverts a deliberate re-selection of standard', () => {
    writeConfig('{\n  "tools": {\n    "preset": "standard"\n  }\n}\n');
    configJsonc.migrateGlobalConfig();
    expect(readPreset().preset).toBe(shippedPreset);

    configJsonc.modifyGlobalConfigJsonc(['tools', 'preset'], 'standard');
    configJsonc.migrateGlobalConfig();
    expect(readPreset().preset).toBe('standard');
  });

  it('does not re-run the v1 rewrite on a config already at the latest marker', () => {
    writeConfig(
      '{\n  "tools": {\n    "preset": "full",\n    "preset_default_migrated": 2\n  }\n}\n',
    );

    configJsonc.migrateGlobalConfig();

    expect(readPreset().preset).toBe('full');
  });

  it('marks a config that has no tools section, so its later choice survives', () => {
    writeConfig('{\n  "version": 1\n}\n');

    configJsonc.migrateGlobalConfig();

    // The additive migration inserts the shipped tools section...
    expect(readPreset().preset).toBe(shippedPreset);
    expect(readPreset().preset_default_migrated).toBe(2);

    // ...so opting into `full` afterwards is a choice, not our old default.
    configJsonc.modifyGlobalConfigJsonc(['tools', 'preset'], 'full');
    configJsonc.migrateGlobalConfig();
    expect(readPreset().preset).toBe('full');
  });
});
