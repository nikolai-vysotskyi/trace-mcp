/**
 * E14 — CLAUDE.md drift detection tests.
 *
 * Covers the four drift categories the audit picks up when `includeDrift`
 * or `driftOnly` is set: dead_path (already covered by the base suite),
 * dead_tool_ref, dead_skill_ref, dead_command_ref, oversized_section.
 * Each test feeds a synthetic CLAUDE.md fixture into auditConfig and
 * asserts the relevant category surfaces in `issues`.
 */

import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { beforeAll, describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { auditConfig } from '../../src/tools/quality/audit-config.js';
import { createTmpDir } from '../test-utils.js';

describe('Audit Config — E14 drift detection', () => {
  let db: Database.Database;
  let store: Store;
  let tmpDir: string;

  beforeAll(() => {
    db = initializeDatabase(':memory:');
    store = new Store(db);
    tmpDir = createTmpDir('audit-drift-');
  });

  it('emits no drift categories when includeDrift is false (back-compat)', () => {
    const configPath = path.join(tmpDir, 'CLAUDE.md');
    fs.writeFileSync(
      configPath,
      [
        '# Rules',
        'Use the `nonexistent_tool` MCP tool for everything.',
        'Run `pnpm run absolutely-not-a-real-script`.',
      ].join('\n'),
    );

    const result = auditConfig(store, tmpDir, {
      configFiles: [configPath],
      fixSuggestions: false,
    });

    const drift = result.issues.filter((i) =>
      ['dead_tool_ref', 'dead_skill_ref', 'dead_command_ref', 'oversized_section'].includes(
        i.category,
      ),
    );
    expect(drift).toHaveLength(0);
  });

  it('detects dead_tool_ref when includeDrift + registeredTools provided', () => {
    const configPath = path.join(tmpDir, 'CLAUDE-tools.md');
    fs.writeFileSync(
      configPath,
      [
        '# Tool routing',
        'Use the `nonexistent_tool` MCP tool for everything.',
        'Also call `search` for navigation.',
      ].join('\n'),
    );

    const result = auditConfig(store, tmpDir, {
      configFiles: [configPath],
      includeDrift: true,
      registeredTools: new Set(['search', 'get_outline', 'get_symbol']),
      fixSuggestions: false,
    });

    const dead = result.issues.filter((i) => i.category === 'dead_tool_ref');
    expect(dead.length).toBeGreaterThan(0);
    expect(dead.some((i) => i.issue.includes('nonexistent_tool'))).toBe(true);
    // `search` is registered — must NOT be flagged.
    expect(dead.every((i) => !i.issue.includes('`search`'))).toBe(true);
  });

  it('detects oversized_section when a heading body exceeds the bloat threshold', () => {
    const configPath = path.join(tmpDir, 'CLAUDE-bloat.md');
    // Build a fixture where one H2 dominates the file.
    const bigParagraph = 'lorem ipsum dolor sit amet '.repeat(800); // ~ 4kB
    fs.writeFileSync(
      configPath,
      [
        '# Project',
        '## Quickstart',
        'Short and tight.',
        '## Architecture',
        bigParagraph,
        '## Conclusion',
        'Done.',
      ].join('\n\n'),
    );

    const result = auditConfig(store, tmpDir, {
      configFiles: [configPath],
      includeDrift: true,
      fixSuggestions: false,
    });

    const oversized = result.issues.filter((i) => i.category === 'oversized_section');
    expect(oversized.length).toBeGreaterThan(0);
    expect(oversized[0].file).toBe(configPath);
  });

  it('detects dead_skill_ref when includeDrift + installedSkills provided', () => {
    const configPath = path.join(tmpDir, 'CLAUDE-skills.md');
    fs.writeFileSync(
      configPath,
      [
        '# Skills',
        'Use the `skills/nonexistent-skill` skill for cleanup.',
        'Also rely on `skills/real-skill` for the heavy lifting.',
      ].join('\n'),
    );

    const result = auditConfig(store, tmpDir, {
      configFiles: [configPath],
      includeDrift: true,
      installedSkills: new Set(['real-skill']),
      fixSuggestions: false,
    });

    const dead = result.issues.filter((i) => i.category === 'dead_skill_ref');
    expect(dead.length).toBeGreaterThan(0);
    expect(dead.some((i) => i.issue.includes('nonexistent-skill'))).toBe(true);
    // `real-skill` is in installedSkills — must NOT be flagged.
    expect(dead.every((i) => !i.issue.includes('`real-skill`'))).toBe(true);
  });

  it('detects dead_command_ref when includeDrift + command sets provided', () => {
    const configPath = path.join(tmpDir, 'CLAUDE-commands.md');
    fs.writeFileSync(
      configPath,
      [
        '# Commands',
        'Run `pnpm run nonexistent-script` to bootstrap.',
        'Then run `pnpm run build` to compile.',
        'Use `trace-mcp imaginary-cmd` for cleanup.',
        'Use `trace-mcp serve` to start the server.',
      ].join('\n'),
    );

    const result = auditConfig(store, tmpDir, {
      configFiles: [configPath],
      includeDrift: true,
      registeredCliCommands: new Set(['serve', 'index']),
      pnpmScripts: new Set(['build', 'test']),
      fixSuggestions: false,
    });

    const dead = result.issues.filter((i) => i.category === 'dead_command_ref');
    expect(dead.length).toBeGreaterThan(0);
    expect(dead.some((i) => i.issue.includes('nonexistent-script'))).toBe(true);
    expect(dead.some((i) => i.issue.includes('imaginary-cmd'))).toBe(true);
    // `build` is a known script — must NOT be flagged.
    expect(dead.every((i) => !i.issue.includes('pnpm build`'))).toBe(true);
    // `serve` is a known CLI command — must NOT be flagged.
    expect(dead.every((i) => !i.issue.includes('trace-mcp serve`'))).toBe(true);
  });

  it('driftOnly restricts output to drift categories only', () => {
    // A fixture that would normally also trigger dead_path (non-drift) plus
    // dead_tool_ref (drift). With driftOnly:true the non-drift category
    // should be filtered out OF the surfaced issues.
    const configPath = path.join(tmpDir, 'CLAUDE-mixed.md');
    fs.writeFileSync(
      configPath,
      [
        '# Mixed',
        'Use the `not_a_real_tool` MCP tool here.',
        // Reference to a non-existent symbol so dead_path / stale_symbol
        // would normally fire in the base audit.
        '`FloatingPointVortexCalculator` handles the math.',
      ].join('\n'),
    );

    const result = auditConfig(store, tmpDir, {
      configFiles: [configPath],
      driftOnly: true,
      registeredTools: new Set(['search']),
      fixSuggestions: false,
    });

    const nonDrift = result.issues.filter(
      (i) =>
        ![
          'dead_path',
          'dead_tool_ref',
          'dead_skill_ref',
          'dead_command_ref',
          'oversized_section',
        ].includes(i.category),
    );
    expect(nonDrift).toHaveLength(0);
  });
});
