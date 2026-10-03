import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { spikeParseSqlSource } from '../../src/indexer/plugins/language/sql/spike-parse.js';
import groundTruth from './brightchamps-ground-truth.json';
import { corpusFile, resolveBrightchampsCorpusRoot } from './resolve-corpus-root.js';

describe('Phase 2 — tree-sitter-sql spike (corpus fixtures)', () => {
  const root = resolveBrightchampsCorpusRoot();
  if (!root) {
    it.skip('corpus not found — set TRACE_SQL_CORPUS_ROOT', () => {});
    return;
  }

  for (const fixture of groundTruth.fixtures) {
    it(`${fixture.id}: extracts expected CTEs`, async () => {
      const full = corpusFile(fixture.path);
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

  it('parent_etl: MATERIALIZED CTEs and :: casts parse clean', async () => {
    const full = corpusFile('parent_etl.sql');
    expect(full).toBeTruthy();
    const result = await spikeParseSqlSource(fs.readFileSync(full!, 'utf8'));
    expect(result.status).not.toBe('failed');
    expect(result.ctes.map((c) => c.name).sort()).toEqual(
      ['all_transactions', 'parent_collections'].sort(),
    );
  });

  it('lead_assignment: split-line DISTINCT ON parses clean', async () => {
    const full = corpusFile('lead_assignment_queries/lead_assignment.sql');
    expect(full).toBeTruthy();
    const result = await spikeParseSqlSource(fs.readFileSync(full!, 'utf8'));
    expect(result.status).toBe('ok');
    expect(result.ctes.map((c) => c.name)).toEqual(['pay']);
  });

  it('uri_probability_features: Python {format} slot does not break parse', async () => {
    const full = corpusFile('uri_probability_features.sql');
    expect(full).toBeTruthy();
    const result = await spikeParseSqlSource(fs.readFileSync(full!, 'utf8'));
    expect(result.preprocess.formatSlots.map((s) => s.name)).toContain('pool_date_filter');
    expect(result.status).not.toBe('failed');
    expect(result.ctes.length).toBeGreaterThan(0);
  });

  it('communication_etl_incremental: parses after AT TIME ZONE normalization', async () => {
    const full = corpusFile('communication_etl_queries/communication_etl_incremental.sql');
    expect(full).toBeTruthy();
    const result = await spikeParseSqlSource(fs.readFileSync(full!, 'utf8'));
    expect(result.status).toBe('ok');
    expect(result.ctes.map((c) => c.name).sort()).toEqual([
      'bookings',
      'communication_logs',
      'crat',
    ]);
  });

  it('base_ownership: template slots preserved', async () => {
    const full = corpusFile('booking_etl_queries/base_ownership.sql');
    expect(full).toBeTruthy();
    const result = await spikeParseSqlSource(fs.readFileSync(full!, 'utf8'));
    expect(result.preprocess.templates.map((t) => t.name)).toContain('SCHEMA_NAME');
    expect(result.preprocess.bindParams).toEqual(expect.arrayContaining(['run_mode', 'id_list']));
  });
});
