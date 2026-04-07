import { describe, it, expect } from 'vitest';
import { HtmlLanguagePlugin } from '../../src/indexer/plugins/language/html/index.js';

const plugin = new HtmlLanguagePlugin();

async function parse(source: string, filePath = 'index.html') {
  const result = await plugin.extractSymbols(filePath, Buffer.from(source));
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

describe('HtmlLanguagePlugin', () => {
  it('extracts script src as import edge', async () => {
    const r = await parse('<script src="app.js"></script>');
    expect(r.edges).toContainEqual(expect.objectContaining({
      edgeType: 'imports',
      metadata: { from: 'app.js', kind: 'script' },
    }));
  });

  it('extracts inline script blocks', async () => {
    const r = await parse('<script>console.log("hi")</script>');
    expect(r.symbols.some((s) => s.name === 'inline-script')).toBe(true);
  });

  it('extracts link stylesheet as import edge', async () => {
    const r = await parse('<link rel="stylesheet" href="style.css">');
    expect(r.edges).toContainEqual(expect.objectContaining({
      metadata: expect.objectContaining({ from: 'style.css', kind: 'stylesheet' }),
    }));
  });

  it('extracts HTML IDs', async () => {
    const r = await parse('<div id="app"></div><section id="main"></section>');
    expect(r.symbols.some((s) => s.name === '#app')).toBe(true);
    expect(r.symbols.some((s) => s.name === '#main')).toBe(true);
  });

  it('extracts custom elements', async () => {
    const r = await parse('<my-component></my-component><x-button></x-button>');
    expect(r.symbols.some((s) => s.name === '<my-component>')).toBe(true);
    expect(r.symbols.some((s) => s.name === '<x-button>')).toBe(true);
  });

  it('deduplicates custom elements', async () => {
    const r = await parse('<my-comp></my-comp><my-comp></my-comp>');
    const count = r.symbols.filter((s) => s.name === '<my-comp>').length;
    expect(count).toBe(1);
  });

  it('extracts meta tags', async () => {
    const r = await parse('<meta name="description" content="Hello world">');
    expect(r.symbols.some((s) => s.name === 'meta:description' && s.metadata?.metaContent === 'Hello world')).toBe(true);
  });

  it('extracts form elements with name', async () => {
    const r = await parse('<input name="email" type="text"><select name="country"></select>');
    expect(r.symbols.some((s) => s.name === 'form:email')).toBe(true);
    expect(r.symbols.some((s) => s.name === 'form:country')).toBe(true);
  });

  it('extracts img src as import edge', async () => {
    const r = await parse('<img src="logo.png" alt="Logo">');
    expect(r.edges).toContainEqual(expect.objectContaining({
      metadata: { from: 'logo.png', kind: 'image' },
    }));
  });

  it('returns language html', async () => {
    const r = await parse('<div>hello</div>');
    expect(r.language).toBe('html');
  });
});
