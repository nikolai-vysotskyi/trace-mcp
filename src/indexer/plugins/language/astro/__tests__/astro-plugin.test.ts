/**
 * Tests for the Astro language plugin.
 */
import { describe, expect, it } from 'vitest';
import { AstroLanguagePlugin } from '../index.js';
import {
  extractIdConstants,
  extractScriptBlocks,
  extractTemplateComponents,
  isCustomAstroComponent,
  splitAstroSections,
} from '../helpers.js';

// ── Unit tests for helper functions ──────────────────────────────────────────

describe('splitAstroSections', () => {
  it('splits a well-formed .astro file into frontmatter + template', () => {
    const src = `---
import Foo from './Foo.astro';
const title = 'Hello';
---
<html>
  <body><h1>{title}</h1></body>
</html>`;
    const result = splitAstroSections(src);
    expect(result.frontmatter).toContain("import Foo from './Foo.astro'");
    expect(result.frontmatter).toContain("const title = 'Hello'");
    expect(result.template).toContain('<html>');
    expect(result.frontmatterLineStart).toBe(2);
    expect(result.templateLineStart).toBeGreaterThan(3);
  });

  it('returns no frontmatter when file has no opening fence', () => {
    const src = `<html><body>hello</body></html>`;
    const result = splitAstroSections(src);
    expect(result.frontmatter).toBeNull();
    expect(result.template).toBe(src);
    expect(result.templateLineStart).toBe(1);
  });

  it('strips UTF-8 BOM before processing', () => {
    const bom = '﻿';
    const src = `${bom}---\nconst x = 1;\n---\n<div/>`;
    const result = splitAstroSections(src);
    expect(result.frontmatter).toContain('const x = 1');
    expect(result.template).toContain('<div/>');
    // BOM should not appear in frontmatter or template
    expect(result.frontmatter).not.toContain('﻿');
    expect(result.template).not.toContain('﻿');
  });

  it('normalises CRLF line endings', () => {
    const src = `---\r\nconst x = 1;\r\n---\r\n<div/>`;
    const result = splitAstroSections(src);
    expect(result.frontmatter).toContain('const x = 1;');
    expect(result.template).toContain('<div/>');
    // No stray \r in results
    expect(result.frontmatter).not.toContain('\r');
    expect(result.template).not.toContain('\r');
  });

  it('fails-soft on unclosed frontmatter fence — treats whole file as template', () => {
    const src = `---\nconst x = 1;\n<div/>`;
    const result = splitAstroSections(src);
    // Unclosed fence: no frontmatter, whole file is template
    expect(result.frontmatter).toBeNull();
    expect(result.template).toBe(src);
  });

  it('produces correct line offsets for multiline frontmatter', () => {
    const src = `---\nline1;\nline2;\nline3;\n---\n<main/>`;
    const result = splitAstroSections(src);
    // Frontmatter content starts on line 2 (after opening ---)
    expect(result.frontmatterLineStart).toBe(2);
    // Template starts after the closing --- on line 5 → line 6
    expect(result.templateLineStart).toBe(6);
  });
});

describe('isCustomAstroComponent', () => {
  it('identifies PascalCase tags as custom components', () => {
    expect(isCustomAstroComponent('Button')).toBe(true);
    expect(isCustomAstroComponent('UserCard')).toBe(true);
    expect(isCustomAstroComponent('MyLayout')).toBe(true);
  });

  it('rejects standard HTML elements', () => {
    expect(isCustomAstroComponent('div')).toBe(false);
    expect(isCustomAstroComponent('span')).toBe(false);
    expect(isCustomAstroComponent('script')).toBe(false);
    expect(isCustomAstroComponent('style')).toBe(false);
  });

  it('rejects SVG elements', () => {
    expect(isCustomAstroComponent('svg')).toBe(false);
    expect(isCustomAstroComponent('circle')).toBe(false);
  });

  it('rejects Astro built-ins', () => {
    expect(isCustomAstroComponent('Fragment')).toBe(false);
    expect(isCustomAstroComponent('slot')).toBe(false);
  });

  it('accepts kebab-case custom elements', () => {
    expect(isCustomAstroComponent('my-element')).toBe(true);
    expect(isCustomAstroComponent('x-header')).toBe(true);
  });
});

describe('extractTemplateComponents', () => {
  it('finds PascalCase component usages', () => {
    const tmpl = `<Layout>\n  <Header title="Hi" />\n  <Footer />\n</Layout>`;
    const comps = extractTemplateComponents(tmpl);
    expect(comps).toContain('Layout');
    expect(comps).toContain('Header');
    expect(comps).toContain('Footer');
  });

  it('excludes HTML elements', () => {
    const tmpl = `<div><p>Hello</p><Button /></div>`;
    const comps = extractTemplateComponents(tmpl);
    expect(comps).not.toContain('div');
    expect(comps).not.toContain('p');
    expect(comps).toContain('Button');
  });

  it('returns unique component names', () => {
    const tmpl = `<Card /><Card /><Card />`;
    const comps = extractTemplateComponents(tmpl);
    expect(comps.filter((c) => c === 'Card')).toHaveLength(1);
  });
});

describe('extractIdConstants', () => {
  it('finds id attributes', () => {
    const tmpl = `<section id="hero"><div id="main-content"></div></section>`;
    const ids = extractIdConstants(tmpl);
    expect(ids.map((i) => i.name)).toContain('hero');
    expect(ids.map((i) => i.name)).toContain('main-content');
  });

  it('returns empty array for templates with no ids', () => {
    expect(extractIdConstants('<div><p>hello</p></div>')).toHaveLength(0);
  });
});

describe('extractScriptBlocks', () => {
  it('extracts a plain <script> block as typescript by default', () => {
    const tmpl = `<div/>\n<script>\nconst x = 1;\n</script>`;
    const blocks = extractScriptBlocks(tmpl);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].lang).toBe('typescript');
    expect(blocks[0].content).toContain('const x = 1;');
    expect(blocks[0].isInline).toBe(false);
  });

  it('respects lang="js" attribute', () => {
    const tmpl = `<script lang="js">var x = 1;</script>`;
    const blocks = extractScriptBlocks(tmpl);
    expect(blocks[0].lang).toBe('javascript');
  });

  it('marks is:inline blocks', () => {
    const tmpl = `<script is:inline>alert("hi");</script>`;
    const blocks = extractScriptBlocks(tmpl);
    expect(blocks[0].isInline).toBe(true);
  });

  it('skips JSON script blocks', () => {
    const tmpl = `<script type="application/json">{"key":"value"}</script>`;
    const blocks = extractScriptBlocks(tmpl);
    expect(blocks).toHaveLength(0);
  });

  it('skips application/ld+json blocks', () => {
    const tmpl = `<script type="application/ld+json">{"@context":"https://schema.org"}</script>`;
    const blocks = extractScriptBlocks(tmpl);
    expect(blocks).toHaveLength(0);
  });
});

// ── Integration tests for the full plugin ────────────────────────────────────

describe('AstroLanguagePlugin', () => {
  const plugin = new AstroLanguagePlugin();

  it('has correct manifest and extension', () => {
    expect(plugin.manifest.name).toBe('astro-language');
    expect(plugin.supportedExtensions).toEqual(['.astro']);
    expect(plugin.manifest.priority).toBe(12);
  });

  it('extracts imports and component usages from a representative .astro file', async () => {
    const src = `---
import Layout from '../layouts/Layout.astro';
import Button from '../components/Button.astro';
import { getEntry } from 'astro:content';

const post = await getEntry('blog', Astro.params.slug);
const { title, description } = post.data;
---
<Layout title={title}>
  <main id="main-content">
    <h1>{title}</h1>
    <p>{description}</p>
    <Button label="Read more" />
  </main>
</Layout>
`;
    const result = await plugin.extractSymbols('src/pages/index.astro', Buffer.from(src, 'utf-8'));

    expect(result.isOk()).toBe(true);
    const parsed = result._unsafeUnwrap();

    expect(parsed.language).toBe('astro');
    expect(parsed.status).toBe('ok');

    // Top-level component symbol
    const compSymbol = parsed.symbols.find((s) => s.name === 'index' && s.kind === 'class');
    expect(compSymbol).toBeDefined();
    expect(compSymbol?.metadata?.framework).toBe('astro');

    // Import edges from frontmatter
    const importEdges = (parsed.edges ?? []).filter((e) => e.edgeType === 'imports');
    const froms = importEdges.map((e) => (e.metadata as Record<string, unknown>)?.from as string);
    expect(froms).toContain('../layouts/Layout.astro');
    expect(froms).toContain('../components/Button.astro');
    expect(froms).toContain('astro:content');

    // Template component usages on the component symbol metadata
    const meta = compSymbol?.metadata as Record<string, unknown>;
    const templateComponents = meta?.templateComponents as string[] | undefined;
    expect(templateComponents).toBeDefined();
    expect(templateComponents).toContain('Layout');
    expect(templateComponents).toContain('Button');

    // id constant symbol
    const idSymbol = parsed.symbols.find((s) => s.name === 'main-content' && s.kind === 'constant');
    expect(idSymbol).toBeDefined();
    expect(idSymbol?.metadata?.htmlId).toBe(true);

    // RawComponent
    expect(parsed.components).toHaveLength(1);
    expect(parsed.components![0].name).toBe('index');
    expect(parsed.components![0].framework).toBe('astro');
  });

  it('handles a file with no frontmatter (template-only)', async () => {
    const src = `<html>
  <body>
    <h1>Static page</h1>
    <MyWidget />
  </body>
</html>`;
    const result = await plugin.extractSymbols('src/pages/about.astro', Buffer.from(src, 'utf-8'));
    expect(result.isOk()).toBe(true);
    const parsed = result._unsafeUnwrap();

    expect(parsed.status).toBe('ok');
    const meta = parsed.symbols[0].metadata as Record<string, unknown>;
    expect((meta.templateComponents as string[]) ?? []).toContain('MyWidget');
  });

  it('extracts symbols declared in the frontmatter', async () => {
    const src = `---
function greet(name: string): string {
  return \`Hello \${name}\`;
}
interface PageProps {
  title: string;
}
---
<h1>{greet('World')}</h1>`;
    const result = await plugin.extractSymbols('src/pages/greet.astro', Buffer.from(src, 'utf-8'));
    expect(result.isOk()).toBe(true);
    const parsed = result._unsafeUnwrap();

    const fnSymbol = parsed.symbols.find((s) => s.name === 'greet' && s.kind === 'function');
    expect(fnSymbol).toBeDefined();
    // Line offset should be > 1 (inside frontmatter, not line 1)
    expect(fnSymbol!.lineStart).toBeGreaterThan(1);

    const ifaceSymbol = parsed.symbols.find(
      (s) => s.name === 'PageProps' && s.kind === 'interface',
    );
    expect(ifaceSymbol).toBeDefined();
  });

  it('processes <script> blocks inside the template', async () => {
    const src = `---
---
<div>Hello</div>
<script>
  import { createStore } from './store.js';
  const store = createStore();
</script>`;
    const result = await plugin.extractSymbols(
      'src/pages/scripted.astro',
      Buffer.from(src, 'utf-8'),
    );
    expect(result.isOk()).toBe(true);
    const parsed = result._unsafeUnwrap();

    // Import from the <script> block
    const importEdges = (parsed.edges ?? []).filter((e) => e.edgeType === 'imports');
    const froms = importEdges.map((e) => (e.metadata as Record<string, unknown>)?.from as string);
    expect(froms).toContain('./store.js');
  });

  it('skips is:inline <script> blocks', async () => {
    const src = `---
---
<div/>
<script is:inline>
  window.legacyGlobal = true;
</script>`;
    const result = await plugin.extractSymbols('src/pages/inline.astro', Buffer.from(src, 'utf-8'));
    expect(result.isOk()).toBe(true);
    const parsed = result._unsafeUnwrap();
    // No edges from the inline block (no import statements anyway, but it should be skipped)
    expect(parsed.edges).toBeUndefined();
  });

  // ── Fail-soft / hardening tests ───────────────────────────────────────────

  it('does not throw on a UTF-8 BOM at the start of the file', async () => {
    const bom = '﻿';
    const src = `${bom}---\nimport x from './x.astro';\n---\n<div/>`;
    const result = await plugin.extractSymbols('src/pages/bom.astro', Buffer.from(src, 'utf-8'));
    expect(result.isOk()).toBe(true);
    const parsed = result._unsafeUnwrap();
    const froms = (parsed.edges ?? [])
      .filter((e) => e.edgeType === 'imports')
      .map((e) => (e.metadata as Record<string, unknown>)?.from as string);
    expect(froms).toContain('./x.astro');
  });

  it('does not throw on CRLF line endings', async () => {
    const src = `---\r\nimport y from './y.astro';\r\n---\r\n<div/>`;
    const result = await plugin.extractSymbols('src/pages/crlf.astro', Buffer.from(src, 'utf-8'));
    expect(result.isOk()).toBe(true);
    const parsed = result._unsafeUnwrap();
    const froms = (parsed.edges ?? [])
      .filter((e) => e.edgeType === 'imports')
      .map((e) => (e.metadata as Record<string, unknown>)?.from as string);
    expect(froms).toContain('./y.astro');
  });

  it('does not throw on an unclosed frontmatter fence', async () => {
    const src = `---\nconst x = 1;\n<div>oops — no closing fence</div>`;
    // Must not throw or return err
    const result = await plugin.extractSymbols('src/pages/bad.astro', Buffer.from(src, 'utf-8'));
    expect(result.isOk()).toBe(true);
    const parsed = result._unsafeUnwrap();
    // Whole file treated as template, status is still ok
    expect(parsed.status).toBe('ok');
    // No frontmatter module symbol should be present
    const modSym = parsed.symbols.find((s) => s.name?.includes('__module__'));
    expect(modSym).toBeUndefined();
  });

  it('does not throw on an empty file', async () => {
    const result = await plugin.extractSymbols('src/pages/empty.astro', Buffer.from('', 'utf-8'));
    expect(result.isOk()).toBe(true);
    const parsed = result._unsafeUnwrap();
    expect(parsed.symbols).toHaveLength(1); // Just the component symbol
    expect(parsed.symbols[0].kind).toBe('class');
  });

  it('does not throw on completely malformed input', async () => {
    const src = `\x00\x01\x02broken garbage \xFF\xFE`;
    const result = await plugin.extractSymbols(
      'src/pages/garbage.astro',
      Buffer.from(src, 'binary'),
    );
    // Should either be ok or err — must not throw
    expect(result.isOk() || result.isErr()).toBe(true);
  });
});
