import { describe, it, expect } from 'vitest';
import { CssLanguagePlugin } from '../../src/indexer/plugins/language/css/index.js';

const plugin = new CssLanguagePlugin();

async function parse(source: string, filePath = 'style.css') {
  const result = await plugin.extractSymbols(filePath, Buffer.from(source));
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

describe('CssLanguagePlugin', () => {
  describe('CSS', () => {
    it('extracts CSS custom properties', async () => {
      const r = await parse(':root { --primary-color: #333; --font-size: 16px; }');
      expect(r.symbols.some((s) => s.name === '--primary-color')).toBe(true);
      expect(r.symbols.some((s) => s.name === '--font-size')).toBe(true);
    });

    it('extracts @import edges', async () => {
      const r = await parse('@import "reset.css";\n@import url("fonts.css");');
      expect(r.edges).toHaveLength(2);
      expect(r.edges).toContainEqual(expect.objectContaining({
        metadata: { from: 'reset.css', kind: 'stylesheet' },
      }));
    });

    it('extracts @keyframes', async () => {
      const r = await parse('@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }');
      expect(r.symbols.some((s) => s.name === '@keyframes fadeIn')).toBe(true);
    });

    it('extracts @font-face', async () => {
      const r = await parse('@font-face { font-family: "MyFont"; src: url("myfont.woff2"); }');
      expect(r.symbols.some((s) => s.name === '@font-face MyFont' && s.metadata?.fontFamily === 'MyFont')).toBe(true);
    });

    it('extracts class selectors (deduplicated)', async () => {
      const r = await parse('.btn { color: red; }\n.btn:hover { color: blue; }\n.card { padding: 1rem; }');
      expect(r.symbols.some((s) => s.name === '.btn')).toBe(true);
      expect(r.symbols.some((s) => s.name === '.card')).toBe(true);
      const btnCount = r.symbols.filter((s) => s.name === '.btn').length;
      expect(btnCount).toBe(1);
    });

    it('extracts ID selectors', async () => {
      const r = await parse('#header { height: 60px; }\n#footer { height: 40px; }');
      expect(r.symbols.some((s) => s.name === '#header')).toBe(true);
      expect(r.symbols.some((s) => s.name === '#footer')).toBe(true);
    });

    it('returns language css', async () => {
      expect((await parse('body {}')).language).toBe('css');
    });
  });

  describe('SCSS', () => {
    it('extracts SCSS variables', async () => {
      const r = await parse('$primary: #333;\n$font-size: 16px;', 'vars.scss');
      expect(r.symbols.some((s) => s.name === '$primary' && s.metadata?.scssVariable)).toBe(true);
      expect(r.symbols.some((s) => s.name === '$font-size')).toBe(true);
    });

    it('extracts @mixin definitions', async () => {
      const r = await parse('@mixin flex-center { display: flex; align-items: center; }', 'mixins.scss');
      expect(r.symbols.some((s) => s.name === '@mixin flex-center' && s.metadata?.mixin)).toBe(true);
    });

    it('extracts @use as import edge', async () => {
      const r = await parse('@use "variables";\n@forward "mixins";', 'main.scss');
      expect(r.edges).toHaveLength(2);
    });

    it('returns language scss', async () => {
      expect((await parse('$x: 1;', 'a.scss')).language).toBe('scss');
    });
  });

  describe('SASS', () => {
    it('extracts SASS variables', async () => {
      const r = await parse('$bg-color: white', 'theme.sass');
      expect(r.symbols.some((s) => s.name === '$bg-color')).toBe(true);
      expect(r.language).toBe('sass');
    });
  });

  describe('LESS', () => {
    it('extracts LESS variables', async () => {
      const r = await parse('@brand-color: #4a90d9;\n@font-stack: Helvetica;', 'vars.less');
      expect(r.symbols.some((s) => s.name === '@brand-color' && s.metadata?.lessVariable)).toBe(true);
      expect(r.symbols.some((s) => s.name === '@font-stack')).toBe(true);
    });

    it('does not extract @import as a variable', async () => {
      const r = await parse('@import "base.less";\n@color: red;', 'main.less');
      expect(r.symbols.some((s) => s.name === '@import')).toBe(false);
      expect(r.symbols.some((s) => s.name === '@color')).toBe(true);
    });

    it('returns language less', async () => {
      expect((await parse('@x: 1;', 'a.less')).language).toBe('less');
    });
  });

  describe('Stylus', () => {
    it('extracts Stylus variables', async () => {
      const r = await parse('primary = #333\nfont_size = 16px', 'vars.styl');
      expect(r.symbols.some((s) => s.name === 'primary' && s.metadata?.stylusVariable)).toBe(true);
      expect(r.symbols.some((s) => s.name === 'font_size')).toBe(true);
    });

    it('returns language stylus', async () => {
      expect((await parse('x = 1', 'a.styl')).language).toBe('stylus');
      expect((await parse('x = 1', 'b.stylus')).language).toBe('stylus');
    });
  });
});
