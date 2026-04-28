import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { resolveMarkdownWikilinkEdges } from '../../src/indexer/edge-resolvers/markdown-wikilinks.js';
import type { PipelineState } from '../../src/indexer/pipeline-state.js';
import type { RawEdge } from '../../src/plugin-api/types.js';

interface SymbolRow {
  symbol_id: string;
  fqn: string;
  kind: 'namespace' | 'class' | 'constant';
  metadata?: Record<string, unknown>;
}

function run(symbols: SymbolRow[]): RawEdge[] {
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
  for (const s of symbols) {
    insert.run(s.symbol_id, s.fqn, s.kind, s.metadata ? JSON.stringify(s.metadata) : null);
  }
  const collected: RawEdge[] = [];
  const state = { store: { db } } as unknown as PipelineState;
  resolveMarkdownWikilinkEdges(state, (e) => collected.push(...e));
  return collected;
}

function note(basename: string, meta: Record<string, unknown> = {}): SymbolRow {
  return {
    symbol_id: `vault/${basename}.md::${basename}#namespace`,
    fqn: `note:${basename}`,
    kind: 'namespace',
    metadata: { note: true, ...meta },
  };
}

function section(noteBasename: string, heading: string): SymbolRow {
  return {
    symbol_id: `vault/${noteBasename}.md::${noteBasename}#${heading}#class`,
    fqn: `note:${noteBasename}#${heading}`,
    kind: 'class',
  };
}

describe('resolveMarkdownWikilinkEdges', () => {
  it('emits a `references` edge for a basename match', () => {
    const edges = run([
      note('foo', { wikilinks: [{ target: 'bar', line: 1, raw: '[[bar]]' }] }),
      note('bar'),
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      sourceSymbolId: expect.stringContaining('foo'),
      targetSymbolId: expect.stringContaining('bar'),
      edgeType: 'references',
      resolution: 'ast_inferred',
    });
  });

  it('matches case-insensitively (Obsidian semantics)', () => {
    const edges = run([
      note('foo', { wikilinks: [{ target: 'BAR', line: 1, raw: '[[BAR]]' }] }),
      note('bar'),
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0].targetSymbolId).toContain('bar');
  });

  it('resolves [[Alias]] via frontmatter aliases', () => {
    const edges = run([
      note('source', {
        wikilinks: [{ target: 'Public Name', line: 1, raw: '[[Public Name]]' }],
      }),
      note('canonical', { aliases: ['Public Name'] }),
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0].targetSymbolId).toContain('canonical');
    expect(edges[0].metadata).toMatchObject({ wikilink: 'Public Name' });
  });

  it('a basename match wins over an alias collision', () => {
    const edges = run([
      note('source', { wikilinks: [{ target: 'Foo', line: 1, raw: '[[Foo]]' }] }),
      // `bar` claims an alias of "Foo"…
      note('bar', { aliases: ['Foo'] }),
      // …but a literal `foo.md` exists, which Obsidian prefers.
      note('foo'),
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0].targetSymbolId).toMatch(/foo#namespace$/);
  });

  it('resolves [[X#Section]] to the matching section symbol', () => {
    const edges = run([
      note('source', {
        wikilinks: [{ target: 'target', section: 'Intro', line: 1, raw: '[[target#Intro]]' }],
      }),
      note('target'),
      section('target', 'Intro'),
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0].targetSymbolId).toContain('target#Intro');
    expect(edges[0].metadata).toMatchObject({ section: 'Intro' });
  });

  it('falls back to the note when the section is missing', () => {
    const edges = run([
      note('source', {
        wikilinks: [{ target: 'target', section: 'Missing', line: 1, raw: '[[target#Missing]]' }],
      }),
      note('target'),
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0].targetSymbolId).toMatch(/target#namespace$/);
    expect(edges[0].metadata).toMatchObject({ section: 'Missing', sectionResolved: false });
  });

  it('emits an `embeds` edge for ![[X]]', () => {
    const edges = run([
      note('source', {
        wikilinks: [{ target: 'diagram', embed: true, line: 1, raw: '![[diagram]]' }],
      }),
      note('diagram'),
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0].edgeType).toBe('embeds');
  });

  it('drops unresolved wikilinks silently', () => {
    const edges = run([
      note('source', {
        wikilinks: [{ target: 'never-existed', line: 1, raw: '[[never-existed]]' }],
      }),
    ]);
    expect(edges).toEqual([]);
  });

  it('drops self-links to avoid cycle noise', () => {
    const edges = run([note('foo', { wikilinks: [{ target: 'foo', line: 1, raw: '[[foo]]' }] })]);
    expect(edges).toEqual([]);
  });

  it('resolves md-style links to .md targets', () => {
    const edges = run([
      note('a', {
        mdLinks: [{ target: '../notes/b.md', text: 'see B', line: 2 }],
      }),
      note('b'),
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0].metadata).toMatchObject({ mdLink: '../notes/b.md', text: 'see B' });
  });

  it('ignores http(s) and non-md targets in mdLinks', () => {
    const edges = run([
      note('a', {
        mdLinks: [
          { target: 'https://example.com', text: 'web', line: 1 },
          { target: 'image.png', text: 'img', line: 2 },
          { target: 'b.md', text: 'b', line: 3 },
        ],
      }),
      note('b'),
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0].metadata).toMatchObject({ mdLink: 'b.md' });
  });

  it('handles Cyrillic basenames identically to ASCII', () => {
    const edges = run([
      note('источник', {
        wikilinks: [{ target: 'Цель', line: 1, raw: '[[Цель]]' }],
      }),
      note('цель'),
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0].targetSymbolId).toContain('цель');
  });
});
