/**
 * @vitest-environment jsdom
 */
/* Contract tests for the Insights report flatteners, run against *recorded*
 * daemon wire responses (tests/fixtures/wire/*.json) rather than hand-built
 * mock objects.
 *
 * TRA-1068: five production bugs were a mapping reading a field name the
 * daemon never sends, and each one degraded silently into "0 rows" — the
 * exact same shape a genuinely empty project produces. A mock built by the
 * same person who wrote the mapping reproduces their assumption, not the
 * wire; only a real captured response can catch that class of bug. These
 * fixtures were captured from a live `serve-http` daemon indexing this repo
 * (see the tool responses quoted in TRA-1062/TRA-1064). To refresh: start a
 * daemon on a scratch project, call the tool, and copy `content[0].text`
 * (JSON.parse'd) into the matching fixture file.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  flattenDriftRows,
  flattenPagerankRows,
  flattenRiskHotspotRows,
} from '../insights-runtime.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const wireDir = path.resolve(here, '../../../../../../tests/fixtures/wire');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(wireDir, name), 'utf-8'));
}

describe('flattenPagerankRows — real get_pagerank wire shape', () => {
  it('reads the `{ data: [...] }` envelope the tool-gate layer actually sends', () => {
    const payload = loadFixture('get_pagerank.json');
    const { rows } = flattenPagerankRows(payload);
    expect(rows.length).toBe(6);
    expect(rows[0].primary).toBe('src/errors.ts');
    // Real score 0.039362 — not "?", not undefined.
    expect(rows[0].badge).toBe('0.039');
  });

  it('throws instead of silently emptying on a shape it does not recognise', () => {
    expect(() => flattenPagerankRows({ unexpected_field: 'x' })).toThrow();
  });

  it('treats a null/undefined payload as the real empty state', () => {
    expect(flattenPagerankRows(null)).toEqual({ rows: [] });
    expect(flattenPagerankRows(undefined)).toEqual({ rows: [] });
  });
});

describe('flattenRiskHotspotRows — real get_risk_hotspots wire shape', () => {
  it('reads `max_cyclomatic` and `assessment`, the fields the tool actually returns', () => {
    const payload = loadFixture('get_risk_hotspots.json');
    const { rows } = flattenRiskHotspotRows(payload);
    expect(rows.length).toBe(6);
    const first = rows[0];
    expect(first.primary).toBe('src/daemon/project-manager.ts');
    // Real max_cyclomatic is 175 — the old code read `.complexity` (undefined)
    // and printed "?" here.
    expect(first.secondary).toContain('175');
    // Real assessment is "high" — the old code showed `confidence_level`
    // ("medium") in this slot instead.
    expect(first.secondary).toContain('high');
    expect(first.secondary).not.toContain('medium');
  });

  it('treats the tool\'s own "no hotspots" shape as a real empty result, not a parse failure', () => {
    // Verbatim shape from src/tools/git/git-analysis.ts's zero-results branch:
    // no `hotspots` key at all, just a message + methodology notes.
    const payload = { message: 'No hotspots found (no complex files with git churn)' };
    expect(flattenRiskHotspotRows(payload)).toEqual({ rows: [] });
  });

  it('throws instead of silently emptying on a shape it does not recognise', () => {
    expect(() => flattenRiskHotspotRows({ unexpected_field: 'x' })).toThrow();
  });
});

describe('flattenDriftRows — real check_claudemd_drift wire shape', () => {
  it('throws instead of silently emptying when `issues` is missing', () => {
    expect(() => flattenDriftRows({ files_scanned: 3 })).toThrow();
  });

  it('treats a null/undefined payload as the real empty state', () => {
    expect(flattenDriftRows(null)).toEqual({ rows: [] });
  });
});
