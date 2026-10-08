import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { spikeParseSqlSource } from '../../src/indexer/plugins/language/sql/spike-parse.js';
import groundTruth from './fixture-ground-truth.json';
import { fixtureFile } from './fixture-paths.js';

describe('tree-sitter-sql spike (public fixture pack)', () => {
  for (const fixture of groundTruth.fixtures) {
    it(`${fixture.id}: extracts expected CTEs`, async () => {
      const full = fixtureFile(fixture.path);
      expect(full).toBeTruthy();
      const original = fs.readFileSync(full!, 'utf8');
      const result = await spikeParseSqlSource(original);
      const expectedStatus = (fixture as { parse_status?: string }).parse_status;
      if (expectedStatus === 'partial') {
        expect(result.status).toBe('partial');
      } else {
        expect(result.status).not.toBe('failed');
      }
      const names = result.ctes.map((c) => c.name).sort();
      const expected = fixture.ctes.map((c) => c.name).sort();
      expect(names).toEqual(expected);
    });
  }

  it('materialized_union_sample: MATERIALIZED CTEs and :: casts parse clean', async () => {
    const full = fixtureFile('etl/materialized_union_sample.sql');
    expect(full).toBeTruthy();
    const result = await spikeParseSqlSource(fs.readFileSync(full!, 'utf8'));
    expect(result.status).not.toBe('failed');
    expect(result.ctes.map((c) => c.name).sort()).toEqual(
      ['all_transactions', 'parent_collections'].sort(),
    );
  });

  it('distinct_on_sample: DISTINCT ON parses clean', async () => {
    const full = fixtureFile('etl/distinct_on_sample.sql');
    expect(full).toBeTruthy();
    const result = await spikeParseSqlSource(fs.readFileSync(full!, 'utf8'));
    expect(result.status).not.toBe('failed');
    expect(result.ctes.map((c) => c.name)).toEqual(['pay']);
  });

  it('format_brace_slot: Python {format} slot does not break parse', async () => {
    const full = fixtureFile('standalone/format_brace_slot.sql');
    expect(full).toBeTruthy();
    const result = await spikeParseSqlSource(fs.readFileSync(full!, 'utf8'));
    expect(result.preprocess.formatSlots.map((s) => s.name)).toContain('pool_date_filter');
    expect(result.status).not.toBe('failed');
    expect(result.ctes.length).toBeGreaterThan(0);
  });

  it('timezone_chain_sample: parses after AT TIME ZONE normalization', async () => {
    const full = fixtureFile('standalone/timezone_chain_sample.sql');
    expect(full).toBeTruthy();
    const result = await spikeParseSqlSource(fs.readFileSync(full!, 'utf8'));
    expect(result.status).toBe('ok');
    expect(result.ctes.map((c) => c.name).sort()).toEqual(['crat', 'event_logs', 'events']);
  });

  it('two_cte_join_sample: template slots preserved', async () => {
    const full = fixtureFile('etl/two_cte_join_sample.sql');
    expect(full).toBeTruthy();
    const result = await spikeParseSqlSource(fs.readFileSync(full!, 'utf8'));
    expect(result.preprocess.templates.map((t) => t.name)).toContain('SCHEMA_NAME');
    expect(result.preprocess.bindParams).toEqual(expect.arrayContaining(['run_mode', 'id_list']));
  });
});
