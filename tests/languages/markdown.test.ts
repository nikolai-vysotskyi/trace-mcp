import { describe, expect, it } from 'vitest';
import {
  MarkdownLanguagePlugin,
  NOTE_FQN_PREFIX,
  type NoteMetadata,
  normalizeKey,
  TAG_FQN_PREFIX,
} from '../../src/indexer/plugins/language/markdown/index.js';

const plugin = new MarkdownLanguagePlugin();

async function parse(source: string, filePath = 'vault/note.md') {
  const result = await plugin.extractSymbols(filePath, Buffer.from(source));
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

function noteOf(symbols: ReturnType<typeof parse> extends Promise<infer R> ? R['symbols'] : never) {
  const note = symbols.find((s) => s.kind === 'namespace');
  expect(note, 'expected exactly one note symbol').toBeDefined();
  return note!;
}

describe('MarkdownLanguagePlugin', () => {
  describe('manifest', () => {
    it('has the expected identity', () => {
      expect(plugin.manifest.name).toBe('markdown-language');
      expect(plugin.supportedExtensions).toEqual(['.md', '.mdx', '.markdown', '.qmd']);
    });
  });

  describe('note symbol', () => {
    it('emits one namespace symbol per file with note: prefixed FQN', async () => {
      const r = await parse('# Title\nbody', 'vault/foo.md');
      const notes = r.symbols.filter((s) => s.kind === 'namespace');
      expect(notes).toHaveLength(1);
      const note = notes[0];
      expect(note.name).toBe('foo');
      expect(note.fqn).toBe(`${NOTE_FQN_PREFIX}foo`);
      const meta = note.metadata as NoteMetadata;
      expect(meta.note).toBe(true);
      expect(meta.wordCount).toBeGreaterThan(0);
    });

    it('uses the basename without extension regardless of nesting', async () => {
      const r = await parse('# x', 'a/b/c/My Note.md');
      const note = noteOf(r.symbols);
      expect(note.name).toBe('My Note');
      expect(note.fqn).toBe(`${NOTE_FQN_PREFIX}My Note`);
    });

    it('derives signature from frontmatter title, then first heading, then first paragraph', async () => {
      const a = await parse('---\ntitle: From FM\n---\n# Heading\nbody');
      expect(noteOf(a.symbols).signature).toBe('From FM');
      const b = await parse('# From Heading\n\nbody paragraph');
      expect(noteOf(b.symbols).signature).toBe('From Heading');
      const c = await parse('first paragraph here\n\nsecond para');
      expect(noteOf(c.symbols).signature).toBe('first paragraph here');
    });
  });

  describe('frontmatter', () => {
    it('parses YAML frontmatter into note metadata', async () => {
      const r = await parse('---\ntitle: T\nrating: 5\n---\nbody');
      const meta = noteOf(r.symbols).metadata as NoteMetadata;
      expect(meta.frontmatter).toEqual({ title: 'T', rating: 5 });
    });

    it('tolerates malformed YAML by leaving frontmatter undefined', async () => {
      const r = await parse('---\nthis: is: bad\n  : yaml\n---\nbody');
      const meta = noteOf(r.symbols).metadata as NoteMetadata;
      expect(meta.frontmatter).toBeUndefined();
    });

    it('extracts tags from frontmatter (string and array forms) plus inline #tags', async () => {
      const r = await parse('---\ntags: [foo, bar]\n---\nIntro #baz and #foo again', 'vault/n.md');
      const meta = noteOf(r.symbols).metadata as NoteMetadata;
      expect(meta.tags?.sort()).toEqual(['bar', 'baz', 'foo']);

      const tagSymbols = r.symbols.filter((s) => s.kind === 'constant');
      expect(tagSymbols.map((s) => s.fqn).sort()).toEqual([
        `${TAG_FQN_PREFIX}bar`,
        `${TAG_FQN_PREFIX}baz`,
        `${TAG_FQN_PREFIX}foo`,
      ]);
      // tag source attribution: foo+bar from frontmatter, baz from inline
      const tagByName = new Map(tagSymbols.map((s) => [s.name, s.metadata]));
      expect((tagByName.get('foo') as { source: string }).source).toBe('frontmatter');
      expect((tagByName.get('baz') as { source: string }).source).toBe('inline');
    });

    it('accepts the string form of frontmatter tags', async () => {
      const r = await parse('---\ntags: alpha beta\n---\nbody');
      const meta = noteOf(r.symbols).metadata as NoteMetadata;
      expect(meta.tags?.sort()).toEqual(['alpha', 'beta']);
    });
  });

  describe('sections (headings)', () => {
    it('emits one section per heading parented to the note', async () => {
      const r = await parse('# H1\ntext\n## H2\ntext\n### H3', 'vault/x.md');
      const sections = r.symbols.filter((s) => s.kind === 'class');
      expect(sections.map((s) => s.name)).toEqual(['H1', 'H2', 'H3']);
      const note = noteOf(r.symbols);
      for (const s of sections) expect(s.parentSymbolId).toBe(note.symbolId);
      expect(sections[0].fqn).toBe(`${NOTE_FQN_PREFIX}x#H1`);
      expect(sections[0].metadata).toMatchObject({ heading: true, level: 1 });
      expect(sections[2].metadata).toMatchObject({ heading: true, level: 3 });
    });

    it('deduplicates same-named headings (case-insensitive)', async () => {
      const r = await parse('# Same\nbody\n## Same\n');
      const sections = r.symbols.filter((s) => s.kind === 'class');
      expect(sections).toHaveLength(1);
    });
  });

  describe('wikilinks', () => {
    it('captures plain wikilinks on note metadata', async () => {
      const r = await parse('See [[Other Note]] and [[Third]].');
      const meta = noteOf(r.symbols).metadata as NoteMetadata;
      expect(meta.wikilinks?.map((w) => w.target)).toEqual(['Other Note', 'Third']);
      expect(meta.wikilinks?.[0].embed).toBeUndefined();
    });

    it('captures alias and section variants', async () => {
      const r = await parse('See [[X|alias]] and [[Y#Section]] and [[Z#H|alias2]].');
      const meta = noteOf(r.symbols).metadata as NoteMetadata;
      expect(meta.wikilinks).toEqual([
        expect.objectContaining({ target: 'X', alias: 'alias' }),
        expect.objectContaining({ target: 'Y', section: 'Section' }),
        expect.objectContaining({ target: 'Z', section: 'H', alias: 'alias2' }),
      ]);
    });

    it('marks ![[X]] as an embed', async () => {
      const r = await parse('![[Diagram]]');
      const meta = noteOf(r.symbols).metadata as NoteMetadata;
      expect(meta.wikilinks).toEqual([expect.objectContaining({ target: 'Diagram', embed: true })]);
    });

    it('records the line number of each wikilink', async () => {
      const r = await parse('one\ntwo [[A]]\nthree\nfour [[B]]');
      const meta = noteOf(r.symbols).metadata as NoteMetadata;
      expect(meta.wikilinks?.map((w) => w.line)).toEqual([2, 4]);
    });
  });

  describe('markdown links', () => {
    it('captures md-style links on note metadata', async () => {
      const r = await parse('See [link](other.md) and [external](https://example.com).');
      const meta = noteOf(r.symbols).metadata as NoteMetadata;
      expect(meta.mdLinks).toEqual([
        expect.objectContaining({ target: 'other.md', text: 'link' }),
        expect.objectContaining({ target: 'https://example.com', text: 'external' }),
      ]);
    });
  });

  describe('code blocks', () => {
    it('does not pick up tags or wikilinks inside fenced code', async () => {
      const r = await parse('```ts\nconst x = "[[NotALink]]"; // #notATag\n```\n[[Real]] #real');
      const meta = noteOf(r.symbols).metadata as NoteMetadata;
      expect(meta.wikilinks?.map((w) => w.target)).toEqual(['Real']);
      expect(meta.tags).toEqual(['real']);
    });
  });

  describe('aliases', () => {
    it('captures Obsidian-style frontmatter aliases (array form)', async () => {
      const r = await parse('---\naliases: [Foo, Bar Baz]\n---\nbody');
      const meta = noteOf(r.symbols).metadata as NoteMetadata;
      expect(meta.aliases).toEqual(['Foo', 'Bar Baz']);
    });

    it('captures aliases from the singular `alias:` key (string form)', async () => {
      const r = await parse('---\nalias: SoloName\n---\nbody');
      const meta = noteOf(r.symbols).metadata as NoteMetadata;
      expect(meta.aliases).toEqual(['SoloName']);
    });

    it('omits aliases when frontmatter has none', async () => {
      const r = await parse('---\ntitle: T\n---\nbody');
      const meta = noteOf(r.symbols).metadata as NoteMetadata;
      expect(meta.aliases).toBeUndefined();
    });
  });

  describe('block references', () => {
    it('records ^block-id anchors defined in the note', async () => {
      const r = await parse('Some text. ^foo-1\nMore text.\n\nAnother paragraph ^bar2');
      const meta = noteOf(r.symbols).metadata as NoteMetadata;
      expect(meta.blockRefs?.sort()).toEqual(['bar2', 'foo-1']);
    });

    it('parses [[X#^id]] as a block-ref wikilink, not a section', async () => {
      const r = await parse('See [[Other#^block-1]] and [[Foo#H1]].');
      const meta = noteOf(r.symbols).metadata as NoteMetadata;
      expect(meta.wikilinks).toEqual([
        expect.objectContaining({ target: 'Other', blockRef: 'block-1' }),
        expect.objectContaining({ target: 'Foo', section: 'H1' }),
      ]);
      // block-ref wikilinks must NOT have a section field set
      expect(meta.wikilinks?.[0].section).toBeUndefined();
    });
  });

  describe('normalizeKey', () => {
    it('lowercases ASCII', () => {
      expect(normalizeKey('Foo')).toBe('foo');
    });

    it('treats NFC and NFD as equal', () => {
      // 'é' as one char (NFC) vs 'e' + combining acute (NFD)
      const nfc = 'é';
      const nfd = 'é';
      expect(normalizeKey(nfc)).toBe(normalizeKey(nfd));
    });

    it('handles Cyrillic without losing characters', () => {
      expect(normalizeKey('Пример')).toBe('пример');
    });
  });

  describe('empty / edge cases', () => {
    it('handles empty file', async () => {
      const r = await parse('', 'vault/empty.md');
      expect(r.symbols).toHaveLength(1);
      expect(r.symbols[0].kind).toBe('namespace');
    });

    it('handles file with only frontmatter', async () => {
      const r = await parse('---\ntitle: Just FM\n---\n');
      const note = noteOf(r.symbols);
      expect(note.signature).toBe('Just FM');
      const meta = note.metadata as NoteMetadata;
      expect(meta.frontmatter).toEqual({ title: 'Just FM' });
      expect(meta.wikilinks).toBeUndefined();
    });
  });
});
