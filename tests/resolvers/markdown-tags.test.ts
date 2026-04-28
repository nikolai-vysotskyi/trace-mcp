import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { resolveMarkdownTagEdges } from '../../src/indexer/edge-resolvers/markdown-tags.js';
import type { PipelineState } from '../../src/indexer/pipeline-state.js';
import type { RawEdge } from '../../src/plugin-api/types.js';

interface Row {
  symbol_id: string;
  fqn: string;
  kind: 'namespace' | 'constant';
  metadata?: Record<string, unknown>;
}

function run(rows: Row[]): RawEdge[] {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol_id TEXT UNIQUE NOT NULL,
      fqn TEXT,
      kind TEXT NOT NULL,
      metadata TEXT
    );
  `);
  const insert = db.prepare(
    'INSERT INTO symbols (symbol_id, fqn, kind, metadata) VALUES (?, ?, ?, ?)',
  );
  for (const r of rows) {
    insert.run(r.symbol_id, r.fqn, r.kind, r.metadata ? JSON.stringify(r.metadata) : null);
  }
  const collected: RawEdge[] = [];
  const state = { store: { db } } as unknown as PipelineState;
  resolveMarkdownTagEdges(state, (edges) => collected.push(...edges));
  return collected;
}

function note(basename: string, tags: string[]): Row {
  return {
    symbol_id: `vault/${basename}.md::${basename}#namespace`,
    fqn: `note:${basename}`,
    kind: 'namespace',
    metadata: { note: true, tags },
  };
}

function tag(noteBasename: string, name: string): Row {
  return {
    symbol_id: `vault/${noteBasename}.md::${noteBasename}::tag::${name}#constant`,
    fqn: `tag:${name}`,
    kind: 'constant',
  };
}

describe('resolveMarkdownTagEdges', () => {
  it('emits one tagged edge per (note, tag) to the canonical tag symbol', () => {
    const edges = run([note('a', ['sgr']), note('b', ['sgr']), tag('a', 'sgr'), tag('b', 'sgr')]);
    expect(edges).toHaveLength(2);
    const targets = new Set(edges.map((e) => e.targetSymbolId));
    // both notes resolve to the SAME canonical (first-seen by id)
    expect(targets.size).toBe(1);
    expect(edges[0].edgeType).toBe('tagged');
    // canonical is the tag symbol from note `a` (lower id, inserted first)
    expect([...targets][0]).toContain('a::tag::sgr');
  });

  it('handles multiple tags per note', () => {
    const edges = run([note('a', ['sgr', 'jtbd']), tag('a', 'sgr'), tag('a', 'jtbd')]);
    expect(edges).toHaveLength(2);
    expect(new Set(edges.map((e) => (e.metadata as { tag: string }).tag))).toEqual(
      new Set(['sgr', 'jtbd']),
    );
  });

  it('emits no edge when a tag has no canonical symbol (orphan tag in metadata)', () => {
    const edges = run([note('a', ['ghost'])]); // no tag symbol
    expect(edges).toEqual([]);
  });

  it('deduplicates within a single note carrying the same tag twice', () => {
    // The plugin already dedupes at extraction, but the resolver must be
    // robust to duplicates in metadata regardless.
    const edges = run([note('a', ['sgr', 'sgr']), tag('a', 'sgr')]);
    expect(edges).toHaveLength(1);
  });

  it('produces no edges when there are tag symbols but no notes carry them', () => {
    const edges = run([tag('a', 'sgr')]);
    expect(edges).toEqual([]);
  });
});
