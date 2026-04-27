/**
 * TailwindCSS plugin — comprehensive tests for v1, v2, v3, v4.
 * Covers: config extraction, CSS directives, template scanning,
 * class composition helpers, PostCSS, container queries, v4 features.
 */
import { describe, expect, it } from 'vitest';
import { TailwindPlugin } from '../../../src/indexer/plugins/integration/view/tailwind/index.js';
import type { FileParseResult, ProjectContext } from '../../../src/plugin-api/types.js';

function makeCtx(deps: Record<string, string> = {}, rootPath = '/tmp/test'): ProjectContext {
  return {
    rootPath,
    packageJson: { dependencies: deps, devDependencies: {} },
    detectedVersions: [],
    allDependencies: [],
    configFiles: [],
  };
}

function extract(
  plugin: TailwindPlugin,
  filePath: string,
  source: string,
  language: string,
): FileParseResult {
  const result = plugin.extractNodes(filePath, Buffer.from(source), language);
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

function mkPlugin(version: string): TailwindPlugin {
  const p = new TailwindPlugin();
  p.detect(makeCtx({ tailwindcss: version }));
  return p;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Detection
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('tailwind — detection', () => {
  it('detects v1 (^1.9.0)', () => {
    expect(mkPlugin('^1.9.0').detect).toBeDefined();
    // @ts-expect-error private
    expect(mkPlugin('^1.9.0').detectedVersion).toBe(1);
  });
  it('detects v2', () => expect((mkPlugin('^2.2.0') as any).detectedVersion).toBe(2));
  it('detects v3', () => expect((mkPlugin('^3.4.0') as any).detectedVersion).toBe(3));
  it('detects v4', () => expect((mkPlugin('^4.0.0') as any).detectedVersion).toBe(4));
  it('detects from devDependencies', () => {
    const p = new TailwindPlugin();
    const ctx = makeCtx();
    (ctx.packageJson as any).devDependencies = { tailwindcss: '^3.4.0' };
    expect(p.detect(ctx)).toBe(true);
  });
  it('returns false when not present', () =>
    expect(new TailwindPlugin().detect(makeCtx({ react: '^18.0.0' }))).toBe(false));
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  v1 — tailwind.js
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const V1_CONFIG = `module.exports = {
  options: { prefix: 'tw-', important: true, separator: '_' },
  textColors: { 'primary': '#3490dc', 'secondary': '#ffed4a', 'danger': '#e3342f' },
  backgroundColors: { 'brand': '#3490dc', 'soft': '#f1f5f8' },
  borderColors: { 'default': '#dae1e7', 'focus': '#3490dc' },
  modules: {
    appearance: true, backgroundAttachment: false, backgroundColors: true, float: false,
  },
  plugins: [ require('tailwindcss/plugins/container') ],
};`;

describe('tailwind — v1 config', () => {
  const p = mkPlugin('^1.9.0');
  const data = extract(p, 'tailwind.js', V1_CONFIG, 'javascript');

  it('sets v1 framework role', () => expect(data.frameworkRole).toBe('tailwind_v1_config'));
  it('extracts prefix, important, separator', () => {
    const meta = data.symbols.find((s) => s.name === 'tailwind:config')!;
    expect(meta.metadata!.prefix).toBe('tw-');
    expect(meta.metadata!.important).toBe(true);
    expect(meta.metadata!.separator).toBe('_');
    expect(meta.metadata!.version).toBe(1);
  });
  it('extracts textColors', () => {
    const s = data.symbols.find((s) => s.name === 'tailwind:v1:textColors')!;
    expect(s.metadata!.keys).toEqual(expect.arrayContaining(['primary', 'secondary', 'danger']));
  });
  it('extracts backgroundColors', () => {
    const s = data.symbols.find((s) => s.name === 'tailwind:v1:backgroundColors')!;
    expect(s.metadata!.keys).toContain('brand');
  });
  it('extracts borderColors', () => {
    const s = data.symbols.find((s) => s.name === 'tailwind:v1:borderColors')!;
    expect(s.metadata!.keys).toContain('default');
  });
  it('extracts modules', () => {
    const s = data.symbols.find((s) => s.name === 'tailwind:modules')!;
    expect(s.metadata!.plugins).toContain('appearance:true');
    expect(s.metadata!.plugins).toContain('float:false');
  });
  it('extracts plugin require', () => {
    const edges = data.edges!.filter((e) => e.edgeType === 'tailwind_uses_plugin');
    expect(edges.map((e) => e.metadata.pluginName)).toContain('tailwindcss/plugins/container');
  });
});

describe('tailwind — v1 CSS', () => {
  const css = `
@tailwind preflight;
@tailwind utilities;
@responsive { .container-fluid { max-width: 100%; } .inset-0 { inset: 0; } }
@variants hover, focus { .text-shadow { text-shadow: 0 2px 4px black; } }
.header { @apply bg-black text-white p-4; }`;
  const p = mkPlugin('^1.9.0');
  const data = extract(p, 'app.css', css, 'css');

  it('detects @tailwind preflight directive', () => {
    const d = data.symbols.find((s) => s.name === 'tailwind:directives')!;
    expect(d.metadata!.directives).toContain('preflight');
    expect(d.metadata!.directives).toContain('utilities');
  });
  it('extracts @responsive classes', () => {
    const classes = data
      .edges!.filter((e) => e.edgeType === 'tailwind_custom_class')
      .map((e) => e.metadata.className);
    expect(classes).toContain('container-fluid');
  });
  it('extracts @responsive variant_group edge', () => {
    const g = data.edges!.filter((e) => e.edgeType === 'tailwind_variant_group');
    expect(g.some((e) => e.metadata.variants.includes('responsive'))).toBe(true);
  });
  it('extracts @variants hover, focus', () => {
    const g = data.edges!.filter((e) => e.edgeType === 'tailwind_variant_group');
    expect(
      g.some((e) => e.metadata.variants.includes('hover') && e.metadata.variants.includes('focus')),
    ).toBe(true);
  });
  it('extracts classes inside @variants', () => {
    const classes = data
      .edges!.filter((e) => e.edgeType === 'tailwind_custom_class')
      .map((e) => e.metadata.className);
    expect(classes).toContain('text-shadow');
  });
  it('extracts @apply', () => {
    const a = data.edges!.filter((e) => e.edgeType === 'tailwind_applies');
    expect(a[0].metadata.utilities).toContain('bg-black');
    expect(a[0].metadata.utilities).toContain('text-white');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  v2
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const V2_CONFIG = `module.exports = {
  purge: ['./src/**/*.html', './src/**/*.vue'],
  darkMode: 'class',
  theme: {
    screens: { sm: '640px', md: '768px', lg: '1024px' },
    extend: { colors: { brand: '#1a56db', accent: '#f59e0b' }, spacing: { '72': '18rem' } },
  },
  plugins: [ require('@tailwindcss/forms'), require('@tailwindcss/typography') ],
};`;

describe('tailwind — v2 config', () => {
  const p = mkPlugin('^2.2.0');
  const data = extract(p, 'tailwind.config.js', V2_CONFIG, 'javascript');

  it('extracts darkMode=class', () =>
    expect(data.symbols.find((s) => s.name === 'tailwind:config')!.metadata!.darkMode).toBe(
      'class',
    ));
  it('extracts purge paths (v2 label)', () => {
    const s = data.symbols.find((s) => s.name === 'tailwind:purge')!;
    expect(s.metadata!.paths).toContain('./src/**/*.html');
  });
  it('extracts screens', () => {
    const s = data.symbols.find((s) => s.name === 'tailwind:screens')!;
    expect(s.metadata!.screens.find((x: any) => x.name === 'sm')?.value).toBe('640px');
    expect(s.metadata!.screens.find((x: any) => x.name === 'lg')?.value).toBe('1024px');
  });
  it('extracts theme.extend.colors', () => {
    const s = data.symbols.find((s) => s.name === 'tailwind:theme.extend.colors')!;
    expect(s.metadata!.keys).toContain('brand');
    expect(s.metadata!.isExtend).toBe(true);
  });
  it('extracts plugins', () => {
    const edges = data.edges!.filter((e) => e.edgeType === 'tailwind_uses_plugin');
    expect(edges.map((e) => e.metadata.pluginName)).toContain('@tailwindcss/forms');
    expect(edges.map((e) => e.metadata.pluginName)).toContain('@tailwindcss/typography');
  });
});

describe('tailwind — v2 @screen directive', () => {
  const css = `@tailwind base;\n@tailwind utilities;\n@screen md { .two-col { columns: 2; } }\n@layer components { .card { @apply rounded p-4; } }`;
  const p = mkPlugin('^2.2.0');
  const data = extract(p, 'styles.css', css, 'css');

  it('extracts @screen ref', () => {
    const e = data.edges!.filter((e) => e.edgeType === 'tailwind_screen_ref');
    expect(e[0].metadata.screen).toBe('md');
  });
  it('extracts class inside @screen', () => {
    const classes = data
      .edges!.filter((e) => e.edgeType === 'tailwind_custom_class')
      .map((e) => e.metadata.className);
    expect(classes).toContain('two-col');
  });
  it('extracts @layer component class', () => {
    const classes = data
      .edges!.filter((e) => e.edgeType === 'tailwind_custom_class')
      .map((e) => e.metadata.className);
    expect(classes).toContain('card');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  v3
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const V3_CONFIG = `/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./resources/**/*.blade.php', './resources/**/*.js', './resources/**/*.vue'],
  safelist: ['bg-red-500', 'text-3xl', 'lg:text-4xl'],
  darkMode: 'selector',
  important: '#app',
  theme: {
    screens: { tablet: '640px', laptop: '1024px', desktop: { min: '1280px', max: '1535px' } },
    colors: { transparent: 'transparent', black: '#000', white: '#fff' },
    extend: {
      colors: { primary: '#1a56db', secondary: '#7c3aed' },
      fontFamily: { sans: ['Inter', 'sans-serif'], mono: ['JetBrains Mono'] },
    },
  },
  presets: [ require('./brand-preset') ],
  corePlugins: { float: false, clear: false },
  plugins: [
    require('@tailwindcss/forms'),
    require('@tailwindcss/typography'),
    require('@tailwindcss/container-queries'),
    plugin(function({ addComponents }) { addComponents({ '.btn': { padding: '.5rem 1rem' } }); }),
  ],
};`;

describe('tailwind — v3 config', () => {
  const p = mkPlugin('^3.4.0');
  const data = extract(p, 'tailwind.config.js', V3_CONFIG, 'javascript');

  it('extracts content paths', () =>
    expect(data.symbols.find((s) => s.name === 'tailwind:content')!.metadata!.paths).toContain(
      './resources/**/*.blade.php',
    ));
  it('extracts safelist', () =>
    expect(data.symbols.find((s) => s.name === 'tailwind:safelist')!.metadata!.patterns).toContain(
      'lg:text-4xl',
    ));
  it('extracts important as selector', () =>
    expect(data.symbols.find((s) => s.name === 'tailwind:config')!.metadata!.important).toBe(
      '#app',
    ));
  it('extracts darkMode=selector', () =>
    expect(data.symbols.find((s) => s.name === 'tailwind:config')!.metadata!.darkMode).toBe(
      'selector',
    ));
  it('extracts screens with min/max object format', () => {
    const s = data.symbols.find((s) => s.name === 'tailwind:screens')!;
    const desktop = s.metadata!.screens.find((x: any) => x.name === 'desktop');
    expect(desktop?.value).toMatch(/min:/);
  });
  it('extracts theme override (not extend)', () => {
    const s = data.symbols.find((s) => s.name === 'tailwind:theme.colors')!;
    expect(s.metadata!.isExtend).toBe(false);
    expect(s.metadata!.keys).toContain('black');
  });
  it('extracts theme.extend.colors', () => {
    const s = data.symbols.find((s) => s.name === 'tailwind:theme.extend.colors')!;
    expect(s.metadata!.isExtend).toBe(true);
    expect(s.metadata!.keys).toContain('primary');
  });
  it('extracts presets', () =>
    expect(data.symbols.find((s) => s.name === 'tailwind:config')!.metadata!.presets).toContain(
      './brand-preset',
    ));
  it('extracts corePlugins', () => {
    const s = data.symbols.find((s) => s.name === 'tailwind:corePlugins')!;
    expect(s.metadata!.plugins).toContain('float:false');
    expect(s.metadata!.plugins).toContain('clear:false');
  });
  it('extracts require() plugins', () => {
    const edges = data.edges!.filter(
      (e) => e.edgeType === 'tailwind_uses_plugin' && !e.metadata.isInline,
    );
    expect(edges.map((e) => e.metadata.pluginName)).toContain('@tailwindcss/forms');
    expect(edges.map((e) => e.metadata.pluginName)).toContain('@tailwindcss/container-queries');
  });
  it('detects inline plugin(function)', () => {
    const edges = data.edges!.filter(
      (e) => e.edgeType === 'tailwind_uses_plugin' && e.metadata.isInline,
    );
    expect(edges.length).toBeGreaterThanOrEqual(1);
  });
});

describe('tailwind — v3 @container queries', () => {
  const css = `@tailwind base;\n@tailwind utilities;\n@container sidebar (min-width: 700px) { .sidebar-card { flex-direction: row; } }\n@container (max-width: 500px) { .narrow { display: none; } }`;
  const p = mkPlugin('^3.4.0');
  const data = extract(p, 'styles.css', css, 'css');

  it('extracts named @container query', () => {
    const edges = data.edges!.filter((e) => e.edgeType === 'tailwind_container_query');
    const named = edges.find((e) => e.metadata.containerName === 'sidebar');
    expect(named).toBeDefined();
    expect(named!.metadata.condition).toBe('min-width: 700px');
  });
  it('extracts anonymous @container query', () => {
    const edges = data.edges!.filter((e) => e.edgeType === 'tailwind_container_query');
    const anon = edges.find((e) => !e.metadata.containerName);
    expect(anon!.metadata.condition).toBe('max-width: 500px');
  });
  it('creates container symbols', () => {
    const syms = data.symbols.filter((s) => s.name.startsWith('tailwind:container:'));
    expect(syms.length).toBe(2);
    expect(syms.map((s) => s.name)).toContain('tailwind:container:sidebar');
    expect(syms.map((s) => s.name)).toContain('tailwind:container:anonymous');
  });
  it('extracts classes inside @container', () => {
    const classes = data
      .edges!.filter((e) => e.edgeType === 'tailwind_custom_class')
      .map((e) => e.metadata.className);
    expect(classes).toContain('sidebar-card');
    expect(classes).toContain('narrow');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  v4 CSS-first
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const V4_CSS = `@import "tailwindcss";
@config "./tailwind.config.ts";
@plugin "@tailwindcss/typography";
@plugin "@tailwindcss/forms";
@source "./resources/**/*.blade.php";
@source not "./resources/vendor/**";
@theme {
  --color-primary: #1a56db;
  --color-secondary: #7c3aed;
  --color-accent: #f59e0b;
  --font-sans: 'Inter', sans-serif;
  --font-mono: 'JetBrains Mono', monospace;
  --spacing-128: 32rem;
  --radius-xl: 1rem;
}
@theme inline {
  --color-surface: oklch(0.97 0 0);
  --color-on-surface: oklch(0.2 0 0);
}
@theme reference {
  --color-brand: var(--color-primary);
}
@layer theme {
  :root { --base-font: 14px; }
}
@utility tab-highlight-none { -webkit-tap-highlight-color: transparent; }
@utility scroll-stable { scrollbar-gutter: stable both-edges; }
@variant hocus (&:hover, &:focus);
@custom-variant pointer-coarse (@media (pointer: coarse));
@layer components { .btn-primary { @apply bg-primary text-white px-4 py-2 rounded; } .card { @apply rounded-lg shadow-md p-6; } }
@layer utilities { .content-auto { content-visibility: auto; } }
@container sidebar (min-width: 700px) { .sidebar-grid { display: grid; } }`;

describe('tailwind — v4 CSS', () => {
  const p = mkPlugin('^4.0.0');
  const data = extract(p, 'app.css', V4_CSS, 'css');

  it('detects v4 entry', () => expect(data.frameworkRole).toBe('tailwind_v4_entry'));
  it('extracts @config reference', () =>
    expect(
      data.symbols.find((s) => s.name === 'tailwind:v4:config-ref')!.metadata!.configPath,
    ).toBe('./tailwind.config.ts'));

  it('extracts @plugin', () => {
    const edges = data.edges!.filter((e) => e.edgeType === 'tailwind_uses_plugin');
    expect(edges.map((e) => e.metadata.pluginName)).toContain('@tailwindcss/typography');
    expect(edges.map((e) => e.metadata.pluginName)).toContain('@tailwindcss/forms');
  });

  it('extracts @source (included)', () => {
    const s = data.symbols.find((s) => s.name === 'tailwind:v4:source')!;
    expect(s.metadata!.paths).toContain('./resources/**/*.blade.php');
  });
  it('extracts @source not (excluded)', () => {
    const s = data.symbols.find((s) => s.name === 'tailwind:v4:source')!;
    expect(s.metadata!.excluded).toContain('./resources/vendor/**');
  });

  it('groups @theme by prefix', () => {
    const color = data.symbols.find((s) => s.name === 'tailwind:v4:theme:color')!;
    expect(color.metadata!.customProperties).toContain('color-primary');
    const font = data.symbols.find((s) => s.name === 'tailwind:v4:theme:font')!;
    expect(font.metadata!.customProperties).toContain('font-sans');
    const spacing = data.symbols.find((s) => s.name === 'tailwind:v4:theme:spacing')!;
    expect(spacing).toBeDefined();
  });

  it('detects @theme inline modifier', () => {
    const s = data.symbols.find(
      (s) =>
        s.name.includes('theme:color:inline') ||
        (s.name.startsWith('tailwind:v4:theme:') && s.metadata!.isInline),
    )!;
    expect(s.metadata!.isInline).toBe(true);
    expect(s.metadata!.customProperties).toContain('color-surface');
  });

  it('detects @theme reference modifier', () => {
    const s = data.symbols.find((s) => s.metadata?.isReference === true)!;
    expect(s).toBeDefined();
    expect(s.metadata!.modifier).toBe('reference');
  });

  it('detects @layer theme', () =>
    expect(data.symbols.find((s) => s.name === 'tailwind:v4:layer-theme')).toBeDefined());

  it('extracts @utility', () => {
    const edges = data.edges!.filter((e) => e.edgeType === 'tailwind_v4_utility');
    expect(edges.map((e) => e.metadata.name)).toContain('tab-highlight-none');
    expect(edges.map((e) => e.metadata.name)).toContain('scroll-stable');
    const sym = data.symbols.find((s) => s.name === 'tailwind:utility:tab-highlight-none')!;
    expect(sym.kind).toBe('function');
  });

  it('extracts @variant and @custom-variant', () => {
    const edges = data.edges!.filter((e) => e.edgeType === 'tailwind_v4_variant');
    expect(edges.map((e) => e.metadata.name)).toContain('hocus');
    expect(edges.map((e) => e.metadata.name)).toContain('pointer-coarse');
    expect(data.symbols.find((s) => s.name === 'tailwind:variant:hocus')).toBeDefined();
    expect(data.symbols.find((s) => s.name === 'tailwind:variant:pointer-coarse')).toBeDefined();
  });

  it('extracts @layer custom classes with correct layer', () => {
    const classes = data.edges!.filter((e) => e.edgeType === 'tailwind_custom_class');
    expect(classes.find((e) => e.metadata.className === 'btn-primary')?.metadata.layer).toBe(
      'components',
    );
    expect(classes.find((e) => e.metadata.className === 'content-auto')?.metadata.layer).toBe(
      'utilities',
    );
  });

  it('extracts @apply inside @layer', () => {
    const a = data.edges!.filter((e) => e.edgeType === 'tailwind_applies');
    expect(a[0].metadata.utilities).toContain('bg-primary');
  });

  it('extracts @container in v4', () => {
    const edges = data.edges!.filter((e) => e.edgeType === 'tailwind_container_query');
    expect(edges[0].metadata.containerName).toBe('sidebar');
  });
});

describe('tailwind — v4 partial imports', () => {
  const cases = [
    '@import "tailwindcss/preflight";',
    '@import "tailwindcss/utilities";',
    '@import "tailwindcss/theme";',
  ];
  for (const css of cases) {
    it(`detects ${css}`, () => {
      const p = mkPlugin('^4.0.0');
      const data = extract(p, 'app.css', css, 'css');
      expect(data.frameworkRole).toBe('tailwind_v4_entry');
    });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Template scanning
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('tailwind — HTML template scanning', () => {
  const html = `<div class="flex items-center gap-4 p-6 bg-white rounded-lg shadow-md">
  <button class="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded">Click</button>
  <span class="text-sm text-gray-500 truncate">Label</span>
</div>`;
  const p = mkPlugin('^3.4.0');
  const data = extract(p, 'component.html', html, 'html');

  it('sets template framework role', () => expect(data.frameworkRole).toBe('tailwind_template'));
  it('emits class_usage edge', () => {
    const edge = data.edges!.find((e) => e.edgeType === 'tailwind_class_usage')!;
    expect(edge.metadata.classes).toContain('flex');
    expect(edge.metadata.classes).toContain('items-center');
    expect(edge.metadata.classes).toContain('hover:bg-blue-600');
    expect(edge.metadata.classes).toContain('rounded-lg');
    expect(edge.metadata.count).toBeGreaterThan(5);
  });
  it('creates class inventory symbol', () => {
    const s = data.symbols.find((s) => s.name === 'tailwind:classes')!;
    expect(s.metadata!.classes).toContain('px-4');
    expect(s.metadata!.count).toBeGreaterThan(5);
  });
});

describe('tailwind — Blade template scanning', () => {
  const blade = `<x-card class="bg-white rounded-xl p-6 shadow-lg">
    <h2 class="text-2xl font-bold text-gray-900">{{ $title }}</h2>
    <p class="mt-4 text-gray-600 leading-relaxed">{{ $body }}</p>
    <a href="#" class="mt-6 inline-block text-blue-600 hover:underline font-medium">Read more</a>
</x-card>`;
  const p = mkPlugin('^3.4.0');
  const data = extract(p, 'show.blade.php', blade, 'blade');

  it('extracts classes from Blade templates', () => {
    const edge = data.edges!.find((e) => e.edgeType === 'tailwind_class_usage')!;
    expect(edge.metadata.classes).toContain('font-bold');
    expect(edge.metadata.classes).toContain('text-gray-600');
    expect(edge.metadata.classes).toContain('hover:underline');
  });
});

describe('tailwind — JSX/TSX scanning', () => {
  const jsx = `
import { cn } from '@/lib/utils';

export function Card({ isActive }: { isActive: boolean }) {
  return (
    <div className="rounded-lg shadow-md p-6 bg-white">
      <h2 className="text-xl font-bold text-gray-900">Title</h2>
      <p className={"text-sm text-gray-600 mt-2"}>Body</p>
      <button className={\`px-4 py-2 \${isActive ? 'bg-blue-500' : 'bg-gray-200'} rounded transition-colors\`}>
        Action
      </button>
    </div>
  );
}`;
  const p = mkPlugin('^3.4.0');
  const data = extract(p, 'Card.tsx', jsx, 'typescriptreact');

  it('extracts static className="..."', () => {
    const edge = data.edges!.find((e) => e.edgeType === 'tailwind_class_usage')!;
    expect(edge.metadata.classes).toContain('rounded-lg');
    expect(edge.metadata.classes).toContain('font-bold');
    expect(edge.metadata.classes).toContain('text-gray-600');
  });
  it('extracts className={"..."} braced string', () => {
    const edge = data.edges!.find((e) => e.edgeType === 'tailwind_class_usage')!;
    expect(edge.metadata.classes).toContain('text-sm');
  });
  it('extracts static parts from template literal', () => {
    const edge = data.edges!.find((e) => e.edgeType === 'tailwind_class_usage')!;
    expect(edge.metadata.classes).toContain('rounded');
    expect(edge.metadata.classes).toContain('transition-colors');
  });
});

describe('tailwind — Vue SFC scanning', () => {
  const vue = `<template>
  <div class="container mx-auto px-4">
    <header class="flex justify-between items-center py-6">
      <nav :class="['flex', 'gap-4', isOpen ? 'flex-col' : 'flex-row']">
        <a :class="{ 'text-blue-600': isActive, 'font-semibold': isActive, 'text-gray-600': !isActive }">Home</a>
      </nav>
    </header>
  </div>
</template>`;
  const p = mkPlugin('^3.4.0');
  const data = extract(p, 'App.vue', vue, 'vue');

  it('extracts static class="..."', () => {
    const edge = data.edges!.find((e) => e.edgeType === 'tailwind_class_usage')!;
    expect(edge.metadata.classes).toContain('container');
    expect(edge.metadata.classes).toContain('mx-auto');
    expect(edge.metadata.classes).toContain('justify-between');
  });
  it('extracts :class array strings', () => {
    const edge = data.edges!.find((e) => e.edgeType === 'tailwind_class_usage')!;
    expect(edge.metadata.classes).toContain('flex');
    expect(edge.metadata.classes).toContain('gap-4');
  });
  it('extracts :class object keys', () => {
    const edge = data.edges!.find((e) => e.edgeType === 'tailwind_class_usage')!;
    expect(edge.metadata.classes).toContain('text-blue-600');
    expect(edge.metadata.classes).toContain('font-semibold');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  JS/TS class composition helpers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('tailwind — cn() / clsx() helpers', () => {
  const ts = `
import { cn } from '@/lib/utils';
import clsx from 'clsx';
import { twMerge } from 'tailwind-merge';

export function buttonClasses(variant: string) {
  return cn(
    'px-4 py-2 rounded font-semibold',
    variant === 'primary' && 'bg-blue-500 hover:bg-blue-600 text-white',
    variant === 'ghost' && 'bg-transparent hover:bg-gray-100',
  );
}

export function mergedClasses(base: string, extra?: string) {
  return twMerge(clsx('flex items-center gap-2', base), extra);
}`;
  const p = mkPlugin('^3.4.0');
  const data = extract(p, 'utils.ts', ts, 'typescript');

  it('emits cn_call edge', () => {
    const edge = data.edges!.find((e) => e.edgeType === 'tailwind_cn_call')!;
    expect(edge.metadata.helpers).toContain('cn');
  });
  it('extracts static classes from cn() args', () => {
    const edge = data.edges!.find((e) => e.edgeType === 'tailwind_cn_call')!;
    expect(edge.metadata.classes).toContain('px-4');
    expect(edge.metadata.classes).toContain('rounded');
    expect(edge.metadata.classes).toContain('font-semibold');
  });
  it('detects twMerge()', () => {
    const edges = data.edges!.filter((e) => e.edgeType === 'tailwind_cn_call');
    const helpers = edges.flatMap((e) => e.metadata.helpers);
    expect(helpers).toContain('twMerge');
  });
  it('detects clsx()', () => {
    const edges = data.edges!.filter((e) => e.edgeType === 'tailwind_cn_call');
    const helpers = edges.flatMap((e) => e.metadata.helpers);
    expect(helpers).toContain('clsx');
  });
  it('extracts static classes from clsx/twMerge args', () => {
    const edges = data.edges!.filter((e) => e.edgeType === 'tailwind_cn_call');
    const classes = edges.flatMap((e) => e.metadata.classes);
    expect(classes).toContain('flex');
    expect(classes).toContain('items-center');
  });
  it('creates cn helper symbol', () => {
    const sym = data.symbols.find((s) => s.name.startsWith('tailwind:cn:'))!;
    expect(sym.metadata!.helpers.length).toBeGreaterThanOrEqual(1);
  });
});

describe('tailwind — cva() / tv() helpers', () => {
  const ts = `
import { cva } from 'class-variance-authority';
import { tv } from 'tailwind-variants';

const button = cva('px-4 py-2 font-semibold rounded', {
  variants: {
    variant: {
      primary: 'bg-blue-500 text-white hover:bg-blue-600',
      ghost: 'bg-transparent hover:bg-gray-100',
      destructive: 'bg-red-500 text-white hover:bg-red-600',
    },
    size: {
      sm: 'text-sm px-2 py-1',
      lg: 'text-lg px-6 py-3',
    },
  },
});

const badge = tv({
  base: 'inline-flex items-center rounded-full text-xs font-medium',
  variants: { color: { blue: 'bg-blue-100 text-blue-700', green: 'bg-green-100 text-green-700' } },
});`;
  const p = mkPlugin('^3.4.0');
  const data = extract(p, 'button.ts', ts, 'typescript');

  it('emits cva_call edge for cva()', () => {
    const edge = data.edges!.find((e) => e.edgeType === 'tailwind_cva_call')!;
    expect(edge.metadata.helpers).toContain('cva');
  });
  it('extracts base classes from cva()', () => {
    const edge = data.edges!.find((e) => e.edgeType === 'tailwind_cva_call')!;
    expect(edge.metadata.classes).toContain('px-4');
    expect(edge.metadata.classes).toContain('font-semibold');
  });
  it('extracts variant classes from cva()', () => {
    const edge = data.edges!.find((e) => e.edgeType === 'tailwind_cva_call')!;
    expect(edge.metadata.classes).toContain('bg-blue-500');
    expect(edge.metadata.classes).toContain('hover:bg-blue-600');
  });
  it('detects tv()', () => {
    const edge = data.edges!.find((e) => e.edgeType === 'tailwind_cva_call')!;
    expect(edge.metadata.helpers).toContain('tv');
  });
  it('creates cva symbol', () => {
    const sym = data.symbols.find((s) => s.name.startsWith('tailwind:cva:'))!;
    expect(sym.metadata!.helpers.length).toBeGreaterThanOrEqual(1);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PostCSS config
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('tailwind — PostCSS config', () => {
  const postCssJs = `module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};`;
  const postCssEsm = `import tailwindcss from 'tailwindcss';\nexport default { plugins: [tailwindcss()] };`;

  const p = mkPlugin('^3.4.0');

  it('detects CommonJS postcss.config.js', () => {
    const data = extract(p, 'postcss.config.js', postCssJs, 'javascript');
    expect(data.frameworkRole).toBe('tailwind_postcss_config');
    expect(data.edges!.find((e) => e.edgeType === 'tailwind_postcss_plugin')).toBeDefined();
  });

  it('detects ESM postcss.config.mjs', () => {
    const data = extract(p, 'postcss.config.mjs', postCssEsm, 'javascript');
    expect(data.edges!.find((e) => e.edgeType === 'tailwind_postcss_plugin')).toBeDefined();
  });

  it('creates postcss symbol', () => {
    const data = extract(p, 'postcss.config.js', postCssJs, 'javascript');
    const sym = data.symbols.find((s) => s.name === 'tailwind:postcss')!;
    expect(sym.metadata!.frameworkRole).toBe('tailwind_postcss_config');
  });

  it('does not fire for unrelated postcss config', () => {
    const other = `module.exports = { plugins: { autoprefixer: {}, cssnano: {} } };`;
    const data = extract(p, 'postcss.config.js', other, 'javascript');
    expect(data.edges!.find((e) => e.edgeType === 'tailwind_postcss_plugin')).toBeUndefined();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  @apply with modifiers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('tailwind — @apply variants', () => {
  const css = `.card { @apply hover:bg-gray-100 dark:bg-gray-800 sm:p-4 lg:rounded-xl; }\n.btn { @apply focus:ring-2 focus:ring-offset-2 focus:ring-blue-500; }`;
  const p = mkPlugin('^3.4.0');
  const data = extract(p, 'styles.css', css, 'css');

  it('extracts modifier-prefixed classes in @apply', () => {
    const a = data.edges!.filter((e) => e.edgeType === 'tailwind_applies');
    const utils = a[0].metadata.utilities;
    expect(utils).toContain('hover:bg-gray-100');
    expect(utils).toContain('dark:bg-gray-800');
    expect(utils).toContain('sm:p-4');
  });
  it('counts @apply occurrences', () => {
    const a = data.edges!.filter((e) => e.edgeType === 'tailwind_applies');
    expect(a[0].metadata.count).toBe(2);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Schema
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('tailwind — schema', () => {
  it('registers all edge types', () => {
    const schema = new TailwindPlugin().registerSchema();
    const names = schema.edgeTypes.map((e) => e.name);
    expect(names).toContain('tailwind_uses_plugin');
    expect(names).toContain('tailwind_postcss_plugin');
    expect(names).toContain('tailwind_applies');
    expect(names).toContain('tailwind_custom_class');
    expect(names).toContain('tailwind_screen_ref');
    expect(names).toContain('tailwind_variant_group');
    expect(names).toContain('tailwind_container_query');
    expect(names).toContain('tailwind_v4_utility');
    expect(names).toContain('tailwind_v4_variant');
    expect(names).toContain('tailwind_class_usage');
    expect(names).toContain('tailwind_cn_call');
    expect(names).toContain('tailwind_cva_call');
    expect(names).toContain('tailwind_config_used_by');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Edge cases
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('tailwind — edge cases', () => {
  const p = mkPlugin('^3.4.0');

  it('ignores clearly non-Tailwind classes in templates', () => {
    // Classes that have no TW utility prefix
    const html = `<div class="js-toggle is-active vue-component">content</div>`;
    const data = extract(p, 'test.html', html, 'html');
    // js-toggle, is-active, vue-component have no TW prefix — no inventory
    const edge = data.edges!.find((e) => e.edgeType === 'tailwind_class_usage');
    expect(edge).toBeUndefined();
  });

  it('handles arbitrary values in class inventory', () => {
    const html = `<div class="p-[32px] bg-[#1a56db] text-[14px] w-[calc(100%-2rem)]">x</div>`;
    const data = extract(p, 'test.html', html, 'html');
    const edge = data.edges!.find((e) => e.edgeType === 'tailwind_class_usage');
    expect(edge).toBeDefined();
  });

  it('returns empty result for unrelated TS file', () => {
    const data = extract(
      p,
      'service.ts',
      'export class UserService { getUser() {} }',
      'typescript',
    );
    expect(data.edges!.filter((e) => e.edgeType.startsWith('tailwind_'))).toHaveLength(0);
  });

  it('handles empty CSS file', () => {
    const data = extract(p, 'empty.css', '', 'css');
    expect(data.symbols).toHaveLength(0);
    expect(data.edges).toHaveLength(0);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Vue SFC <style> block extraction
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('tailwind — Vue SFC <style> block', () => {
  const vue = `<template>
  <div class="flex items-center gap-4 p-6">
    <button class="px-4 py-2 bg-blue-500 text-white rounded">Click</button>
  </div>
</template>

<script setup lang="ts">
const isActive = ref(false);
</script>

<style scoped>
.card {
  @apply rounded-lg shadow-md p-6 bg-white;
}
.btn-primary {
  @apply px-4 py-2 bg-primary text-white font-semibold;
}
@layer utilities {
  .content-auto {
    content-visibility: auto;
  }
}
@screen md {
  .sidebar {
    width: 16rem;
  }
}
</style>`;

  const p = mkPlugin('^3.4.0');
  const data = extract(p, 'MyComponent.vue', vue, 'vue');

  it('extracts @apply from <style> block', () => {
    const applyEdges = data.edges!.filter((e) => e.edgeType === 'tailwind_applies');
    expect(applyEdges).toHaveLength(1);
    expect(applyEdges[0].metadata.utilities).toContain('rounded-lg');
    expect(applyEdges[0].metadata.utilities).toContain('shadow-md');
    expect(applyEdges[0].metadata.utilities).toContain('font-semibold');
  });

  it('extracts @layer classes from <style> block', () => {
    const classEdges = data.edges!.filter((e) => e.edgeType === 'tailwind_custom_class');
    expect(classEdges.map((e) => e.metadata.className)).toContain('content-auto');
  });

  it('extracts @screen from <style> block', () => {
    const screenEdges = data.edges!.filter((e) => e.edgeType === 'tailwind_screen_ref');
    expect(screenEdges).toHaveLength(1);
    expect(screenEdges[0].metadata.screen).toBe('md');
  });

  it('still extracts template class usage', () => {
    const classUsage = data.edges!.find((e) => e.edgeType === 'tailwind_class_usage');
    expect(classUsage).toBeDefined();
    expect(classUsage!.metadata.classes).toContain('flex');
    expect(classUsage!.metadata.classes).toContain('items-center');
  });
});

describe('tailwind — Svelte <style> block', () => {
  const svelte = `<script lang="ts">
  let isOpen = false;
</script>

<div class="container mx-auto px-4">
  <nav class:flex={isOpen} class:hidden={!isOpen}>
    <slot />
  </nav>
</div>

<style>
.container {
  @apply max-w-7xl;
}
@layer components {
  .nav-item {
    @apply block px-4 py-2 text-gray-700 hover:bg-gray-100;
  }
}
</style>`;

  const p = mkPlugin('^3.4.0');
  const data = extract(p, 'Layout.svelte', svelte, 'svelte');

  it('extracts @apply from Svelte <style> block', () => {
    const applyEdges = data.edges!.filter((e) => e.edgeType === 'tailwind_applies');
    expect(applyEdges).toHaveLength(1);
    expect(applyEdges[0].metadata.utilities).toContain('max-w-7xl');
  });

  it('extracts @layer classes from Svelte <style> block', () => {
    const classEdges = data.edges!.filter((e) => e.edgeType === 'tailwind_custom_class');
    expect(classEdges.map((e) => e.metadata.className)).toContain('nav-item');
  });

  it('extracts Svelte class: directive classes from template', () => {
    const classUsage = data.edges!.find((e) => e.edgeType === 'tailwind_class_usage');
    // container, mx-auto, px-4 come from static class="..."
    expect(classUsage?.metadata.classes).toContain('container');
    expect(classUsage?.metadata.classes).toContain('mx-auto');
  });
});

describe('tailwind — Svelte class: directive (shorthand)', () => {
  const svelte = `<div class:flex class:hidden={!show} class:items-center={center}>x</div>`;
  const p = mkPlugin('^3.4.0');
  const data = extract(p, 'Comp.svelte', svelte, 'svelte');

  it('detects class:flex shorthand (no binding)', () => {
    const classUsage = data.edges!.find((e) => e.edgeType === 'tailwind_class_usage');
    expect(classUsage?.metadata.classes).toContain('flex');
  });

  it('detects class:hidden and class:items-center with binding', () => {
    const classUsage = data.edges!.find((e) => e.edgeType === 'tailwind_class_usage');
    expect(classUsage?.metadata.classes).toContain('hidden');
    expect(classUsage?.metadata.classes).toContain('items-center');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  twin.macro + classnames
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('tailwind — twin.macro tw`` detection', () => {
  const ts = `
import tw from 'twin.macro';

const Container = tw.div\`flex items-center justify-between px-6 py-4 bg-white shadow-md\`;
const Button = tw.button\`px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded font-semibold\`;
`;
  const p = mkPlugin('^3.4.0');
  const data = extract(p, 'styled.ts', ts, 'typescript');

  it('detects twin.macro tw`` tag', () => {
    const edge = data.edges!.find((e) => e.edgeType === 'tailwind_cn_call');
    expect(edge?.metadata.helpers).toContain('tw');
  });

  it('extracts classes from tw`` template', () => {
    const edge = data.edges!.find((e) => e.edgeType === 'tailwind_cn_call');
    expect(edge?.metadata.classes).toContain('flex');
    expect(edge?.metadata.classes).toContain('items-center');
    expect(edge?.metadata.classes).toContain('px-6');
    expect(edge?.metadata.classes).toContain('shadow-md');
    expect(edge?.metadata.classes).toContain('hover:bg-blue-600');
  });
});

describe('tailwind — classnames package', () => {
  const ts = `
import classnames from 'classnames';

const cls = classnames('flex items-center', { 'bg-blue-500': isActive, 'bg-gray-200': !isActive });
`;
  const p = mkPlugin('^3.4.0');
  const data = extract(p, 'comp.ts', ts, 'typescript');

  it('detects classnames() helper', () => {
    const edge = data.edges!.find((e) => e.edgeType === 'tailwind_cn_call');
    expect(edge?.metadata.helpers).toContain('classnames');
  });

  it('extracts static classes from classnames() args', () => {
    const edge = data.edges!.find((e) => e.edgeType === 'tailwind_cn_call');
    expect(edge?.metadata.classes).toContain('flex');
    expect(edge?.metadata.classes).toContain('items-center');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  @apply with !important modifier
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('tailwind — @apply with ! important modifier', () => {
  const css = `.btn { @apply !text-red-500 !font-bold hover:!bg-blue-500 !px-4; }`;
  const p = mkPlugin('^3.4.0');
  const data = extract(p, 'styles.css', css, 'css');

  it('extracts classes with ! prefix', () => {
    const a = data.edges!.filter((e) => e.edgeType === 'tailwind_applies');
    expect(a[0].metadata.utilities).toContain('!text-red-500');
    expect(a[0].metadata.utilities).toContain('!font-bold');
  });

  it('extracts hover:!bg-blue-500', () => {
    const a = data.edges!.filter((e) => e.edgeType === 'tailwind_applies');
    expect(a[0].metadata.utilities).toContain('hover:!bg-blue-500');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  corePlugins as array
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('tailwind — corePlugins as array', () => {
  const config = `module.exports = {
  content: ['./src/**/*.html'],
  corePlugins: ['container', 'preflight', 'float', 'clear', 'accessibility'],
};`;
  const p = mkPlugin('^3.4.0');
  const data = extract(p, 'tailwind.config.js', config, 'javascript');

  it('parses corePlugins array', () => {
    const sym = data.symbols.find((s) => s.name === 'tailwind:corePlugins');
    expect(sym).toBeDefined();
    expect(sym!.metadata!.plugins).toContain('container');
    expect(sym!.metadata!.plugins).toContain('preflight');
    expect(sym!.metadata!.plugins).toContain('accessibility');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Multiple <style> blocks in Vue SFC
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('tailwind — Vue SFC with multiple <style> blocks', () => {
  const vue = `<template>
  <div class="flex p-4">content</div>
</template>

<style>
/* global styles */
.global-nav {
  @apply sticky top-0 z-50 bg-white shadow-sm;
}
</style>

<style scoped>
/* scoped component styles */
@layer components {
  .card-header {
    @apply text-xl font-bold text-gray-900 mb-4;
  }
}
</style>`;

  const p = mkPlugin('^3.4.0');
  const data = extract(p, 'Layout.vue', vue, 'vue');

  it('extracts @apply from both <style> blocks', () => {
    const a = data.edges!.filter((e) => e.edgeType === 'tailwind_applies');
    const allUtils = a.flatMap((e) => e.metadata.utilities);
    expect(allUtils).toContain('sticky');
    expect(allUtils).toContain('top-0');
    expect(allUtils).toContain('z-50');
    expect(allUtils).toContain('text-xl');
    expect(allUtils).toContain('font-bold');
  });

  it('extracts @layer class from scoped block', () => {
    const classes = data.edges!.filter((e) => e.edgeType === 'tailwind_custom_class');
    expect(classes.map((e) => e.metadata.className)).toContain('card-header');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Astro files
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('tailwind — Astro file scanning', () => {
  const astro = `---
import Layout from '../layouts/Layout.astro';
---
<Layout>
  <main class="container mx-auto px-4 py-8">
    <h1 class="text-4xl font-bold text-gray-900 mb-6">Hello Astro</h1>
    <p class="text-lg text-gray-600 leading-relaxed">Content here.</p>
    <a href="/about" class="inline-flex items-center gap-2 text-blue-600 hover:underline mt-4">
      Learn more
    </a>
  </main>
</Layout>

<style>
.hero {
  @apply bg-gradient-to-r from-blue-600 to-purple-600 text-white;
}
</style>`;

  const p = mkPlugin('^3.4.0');
  const data = extract(p, 'src/pages/index.astro', astro, 'astro');

  it('detects .astro as template file', () => {
    const classUsage = data.edges!.find((e) => e.edgeType === 'tailwind_class_usage');
    expect(classUsage).toBeDefined();
    expect(classUsage!.metadata.classes).toContain('container');
    expect(classUsage!.metadata.classes).toContain('font-bold');
    expect(classUsage!.metadata.classes).toContain('text-gray-600');
    expect(classUsage!.metadata.classes).toContain('hover:underline');
  });

  it('extracts @apply from Astro <style> block', () => {
    const a = data.edges!.filter((e) => e.edgeType === 'tailwind_applies');
    expect(a[0].metadata.utilities).toContain('from-blue-600');
    expect(a[0].metadata.utilities).toContain('to-purple-600');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  MDX files
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('tailwind — MDX file scanning', () => {
  const mdx = `# Title

<div className="prose prose-lg max-w-none">
  <p className="text-gray-700 leading-relaxed">Paragraph text.</p>
</div>

<CalloutBox className="bg-blue-50 border border-blue-200 rounded-lg p-6 my-8">
  Important note.
</CalloutBox>`;

  const p = mkPlugin('^3.4.0');
  // MDX is passed with language='mdx' or detected by .mdx extension
  const data = extract(p, 'content/post.mdx', mdx, 'mdx');

  it('extracts className from MDX JSX components', () => {
    const classUsage = data.edges!.find((e) => e.edgeType === 'tailwind_class_usage');
    expect(classUsage?.metadata.classes).toContain('prose');
    expect(classUsage?.metadata.classes).toContain('max-w-none');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Vue v4 <style> with @import "tailwindcss"
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('tailwind — Vue SFC with v4 <style>', () => {
  const vue = `<template>
  <div class="flex p-4">content</div>
</template>
<style>
@import "tailwindcss";
@theme {
  --color-brand: #1a56db;
  --color-accent: #f59e0b;
}
@utility fade-in { animation: fadeIn 0.3s ease; }
</style>`;

  const p = mkPlugin('^4.0.0');
  const data = extract(p, 'Page.vue', vue, 'vue');

  it('detects v4 @import in Vue <style> block', () => {
    // frameworkRole set by template scanner, but v4 CSS should be processed
    const themeSyms = data.symbols.filter((s) => s.name.startsWith('tailwind:v4:theme:'));
    expect(themeSyms.length).toBeGreaterThanOrEqual(1);
    const colorTheme = themeSyms.find((s) => s.name.includes('color'));
    expect(colorTheme?.metadata?.customProperties).toContain('color-brand');
  });

  it('extracts @utility from Vue v4 <style>', () => {
    const utilEdges = data.edges!.filter((e) => e.edgeType === 'tailwind_v4_utility');
    expect(utilEdges.map((e) => e.metadata.name)).toContain('fade-in');
  });
});
