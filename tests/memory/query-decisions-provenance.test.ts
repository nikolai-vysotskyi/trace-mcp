/**
 * Provenance ranking in queryDecisions.
 *
 * A decision store can be >95% auto-mined; without provenance ranking the
 * handful of hand-authored decisions drown under the mined rows on recency.
 * These tests lock in that manual / explicitly-approved decisions rank ABOVE
 * mined ones by default, and that `rank_by_provenance: false` restores pure
 * recency ordering.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DecisionInput } from '../../src/memory/decision-store.js';
import { DecisionStore } from '../../src/memory/decision-store.js';

describe('queryDecisions — provenance ranking', () => {
  let store: DecisionStore;
  let dbPath: string;
  const project_root = '/projects/app';

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-prov-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  const mk = (over: Partial<DecisionInput>): DecisionInput => ({
    title: 'title',
    content: 'A complete decision summary sentence that carries real information.',
    type: 'tech_choice',
    project_root,
    ...over,
  });

  it('ranks a manual decision above a NEWER mined one by default', () => {
    // Mined row is newer (later valid_from) but lower provenance.
    store.addDecision(
      mk({
        title: 'Manual: pin Node 20 minimum',
        source: 'manual',
        valid_from: '2026-01-01T00:00:00.000Z',
      }),
    );
    store.addDecision(
      mk({
        title: 'Mined: some auto-captured note',
        source: 'mined',
        confidence: 0.8,
        valid_from: '2026-06-01T00:00:00.000Z',
      }),
    );

    const rows = store.queryDecisions({ project_root });
    expect(rows[0].source).toBe('manual');
    expect(rows[1].source).toBe('mined');
  });

  it('ranks an approved mined decision above an unreviewed newer mined one', () => {
    store.addDecision(
      mk({
        title: 'Approved mined note',
        source: 'mined',
        confidence: 0.8,
        review_status: 'approved',
        valid_from: '2026-01-01T00:00:00.000Z',
      }),
    );
    store.addDecision(
      mk({
        title: 'Unreviewed newer mined note',
        source: 'mined',
        confidence: 0.8,
        valid_from: '2026-06-01T00:00:00.000Z',
      }),
    );

    const rows = store.queryDecisions({ project_root });
    expect(rows[0].review_status).toBe('approved');
  });

  it('restores pure recency ordering with rank_by_provenance: false', () => {
    store.addDecision(
      mk({
        title: 'Manual older',
        source: 'manual',
        valid_from: '2026-01-01T00:00:00.000Z',
      }),
    );
    store.addDecision(
      mk({
        title: 'Mined newer',
        source: 'mined',
        confidence: 0.8,
        valid_from: '2026-06-01T00:00:00.000Z',
      }),
    );

    const rows = store.queryDecisions({ project_root, rank_by_provenance: false });
    // Newest first, ignoring provenance.
    expect(rows[0].title).toBe('Mined newer');
  });
});
