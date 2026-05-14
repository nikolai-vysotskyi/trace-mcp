/**
 * Behavioural coverage for the `check_claudemd_drift` MCP tool, implemented
 * via `auditConfig()` with the `driftOnly` flag. The existing
 * tests/tools/audit-config-drift.test.ts covers each drift category in
 * isolation; this file complements it by asserting:
 *
 *  - cross-category interaction: tool refs AND skill refs in one file each
 *    surface their own drift category (one CLAUDE.md, two findings).
 *  - back-compat: without `includeDrift`/`driftOnly`, drift categories are
 *    silent.
 *  - `driftOnly: true` filters non-drift categories (stale_symbol, dead_path)
 *    out of the response.
 *  - clean fixture (every reference is known) emits zero drift.
 */

import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../../src/db/schema.js';
import { Store } from '../../../src/db/store.js';
import { auditConfig } from '../../../src/tools/quality/audit-config.js';
import { createTmpDir, removeTmpDir } from '../../test-utils.js';

const DRIFT_CATEGORIES = new Set([
  'dead_tool_ref',
  'dead_skill_ref',
  'dead_command_ref',
  'oversized_section',
]);

describe('check_claudemd_drift — behavioural contract', () => {
  let db: Database.Database;
  let store: Store;
  let tmpDir: string;

  beforeAll(() => {
    db = initializeDatabase(':memory:');
    store = new Store(db);
    tmpDir = createTmpDir('check-drift-behav-');
  });

  afterAll(() => {
    removeTmpDir(tmpDir);
  });

  it('emits BOTH dead_tool_ref and dead_skill_ref when one file references both', () => {
    const configPath = path.join(tmpDir, 'CLAUDE-cross.md');
    fs.writeFileSync(
      configPath,
      [
        '# Mixed drift',
        'Always call the `not_a_real_tool` MCP tool first.',
        'Then dispatch to the `skills/ghost-skill` skill for the rest.',
        'Genuine tool: `search` — should not be flagged.',
        'Genuine skill: `skills/real-skill` — should not be flagged.',
      ].join('\n'),
    );

    const result = auditConfig(store, tmpDir, {
      configFiles: [configPath],
      includeDrift: true,
      registeredTools: new Set(['search', 'get_outline']),
      installedSkills: new Set(['real-skill']),
      fixSuggestions: false,
    });

    const toolDrift = result.issues.filter((i) => i.category === 'dead_tool_ref');
    const skillDrift = result.issues.filter((i) => i.category === 'dead_skill_ref');
    expect(toolDrift.length).toBeGreaterThan(0);
    expect(skillDrift.length).toBeGreaterThan(0);
    expect(toolDrift.some((i) => i.issue.includes('not_a_real_tool'))).toBe(true);
    expect(skillDrift.some((i) => i.issue.includes('ghost-skill'))).toBe(true);
    // Genuine references must stay silent.
    expect(toolDrift.every((i) => !i.issue.includes('`search`'))).toBe(true);
    expect(skillDrift.every((i) => !i.issue.includes('`real-skill`'))).toBe(true);
  });

  it('without includeDrift or driftOnly, no drift category is emitted (back-compat)', () => {
    const configPath = path.join(tmpDir, 'CLAUDE-nodrift.md');
    fs.writeFileSync(
      configPath,
      [
        '# Tool routing',
        // Drift candidates that would fire under includeDrift.
        'Use `imaginary_tool` for cleanup.',
        'Run the `skills/phantom-skill` skill.',
      ].join('\n'),
    );

    const result = auditConfig(store, tmpDir, {
      configFiles: [configPath],
      registeredTools: new Set(['search']),
      installedSkills: new Set(['real-skill']),
      fixSuggestions: false,
    });

    const drift = result.issues.filter((i) => DRIFT_CATEGORIES.has(i.category));
    expect(drift).toHaveLength(0);
  });

  it('driftOnly:true filters out non-drift categories (stale_symbol, redundancy, bloat)', () => {
    const configPath = path.join(tmpDir, 'CLAUDE-drifty.md');
    // Big body → would normally fire bloat (non-drift). Bogus tool → drift.
    fs.writeFileSync(
      configPath,
      [
        '# Bigfile',
        'Use the `not_a_tool` MCP tool here.',
        // Pad to trigger bloat heuristic.
        'x'.repeat(20000),
      ].join('\n'),
    );

    const result = auditConfig(store, tmpDir, {
      configFiles: [configPath],
      driftOnly: true,
      registeredTools: new Set(['search']),
      fixSuggestions: false,
    });

    for (const issue of result.issues) {
      expect(DRIFT_CATEGORIES.has(issue.category) || issue.category === 'dead_path').toBe(true);
    }
    // Specifically: no stale_symbol, no bloat, no redundancy in the response.
    expect(result.issues.some((i) => i.category === 'bloat')).toBe(false);
    expect(result.issues.some((i) => i.category === 'stale_symbol')).toBe(false);
    expect(result.issues.some((i) => i.category === 'redundancy')).toBe(false);
  });

  it('clean fixture with every reference known emits zero drift findings', () => {
    const configPath = path.join(tmpDir, 'CLAUDE-clean.md');
    fs.writeFileSync(
      configPath,
      ['# Tool routing', 'Use the `search` MCP tool and the `skills/real-skill` skill.'].join('\n'),
    );

    const result = auditConfig(store, tmpDir, {
      configFiles: [configPath],
      driftOnly: true,
      registeredTools: new Set(['search']),
      installedSkills: new Set(['real-skill']),
      fixSuggestions: false,
    });

    const drift = result.issues.filter((i) => DRIFT_CATEGORIES.has(i.category));
    expect(drift).toHaveLength(0);
  });
});
