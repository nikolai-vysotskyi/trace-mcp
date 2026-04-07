/**
 * TailwindCSS plugin — supports v1, v2, v3, and v4.
 *
 * Version-specific features:
 *
 * **v1** (tailwind.js config):
 *   - textColors / backgroundColors / borderColors (pre-unified palette)
 *   - modules config (core plugin toggles)
 *   - options.prefix / options.important / options.separator
 *   - No @layer support, uses @responsive / @variants directives
 *
 * **v2** (tailwind.config.js, JIT optional):
 *   - Unified `theme.colors`, `purge` array for tree-shaking
 *   - @apply, @layer, @screen, @variants directives
 *   - darkMode: 'media' | 'class', plugins via require()
 *   - `variants` config section
 *
 * **v3** (tailwind.config.js, JIT default):
 *   - `content` replaces `purge`, `safelist` support
 *   - Arbitrary value/variant support ([...])
 *   - `screens` shorthand, `plugins` with addUtilities/addComponents API
 *   - `presets` config
 *
 * **v4** (CSS-first, no JS config by default):
 *   - @import "tailwindcss" entry point
 *   - @theme { --color-*: ... } for design tokens
 *   - @plugin "..." for plugins, @source "..." for content
 *   - @utility for custom utilities, @variant for custom variants
 *   - @custom-variant for named variants
 *   - Optional tailwind.config.ts via @config
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok } from 'neverthrow';
import type {
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  FileParseResult,
  RawEdge,
  RawSymbol,
  ResolveContext,
} from '../../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../../errors.js';

// ─── Interfaces ──────────────────────────────────────────────

interface TailwindThemeSection {
  category: string;
  keys: string[];
  isExtend: boolean; // true = theme.extend.X, false = theme.X (override)
}

interface TailwindPluginRef {
  name: string;
  line: number;
  isInline: boolean; // plugin(function) vs require('...')
}

interface TailwindVariantConfig {
  utility: string;
  variants: string[];
}

interface TailwindScreenDef {
  name: string;
  value: string; // e.g. '640px', { min: '640px', max: '767px' }
}

interface TailwindConfigMeta {
  version: 1 | 2 | 3 | 4;
  prefix: string | null;
  important: boolean | string | null;
  separator: string | null;
  darkMode: string | null; // 'media' | 'class' | 'selector' | false
  presets: string[];
  corePlugins: string[] | null; // v1: modules, v2+: corePlugins
}

// ─── Config file patterns ────────────────────────────────────

/** v1 used tailwind.js, v2+ use tailwind.config.{js,ts,mjs,cjs} */
const CONFIG_FILE_NAMES = [
  'tailwind.config.js',
  'tailwind.config.ts',
  'tailwind.config.mjs',
  'tailwind.config.cjs',
  'tailwind.js', // v1
];

// ─── Regex patterns ──────────────────────────────────────────

// v4 entry points
const V4_IMPORT_RE = /@import\s+["']tailwindcss(?:\/[\w-]+)?["']/;
const V4_THEME_RE = /@theme\s*(?:inline\s*)?\{/g;
const V4_PLUGIN_RE = /@plugin\s+["']([^"']+)["']/g;
const V4_SOURCE_RE = /@source\s+["']([^"']+)["']/g;
const V4_UTILITY_RE = /@utility\s+([\w-]+)\s*\{/g;
const V4_VARIANT_RE = /@variant\s+([\w-]+)/g;
const V4_CUSTOM_VARIANT_RE = /@custom-variant\s+([\w-]+)/g;
const V4_CONFIG_RE = /@config\s+["']([^"']+)["']/g;

// v1/v2/v3 directives in CSS
const TAILWIND_DIRECTIVE_RE = /@tailwind\s+(base|components|utilities|preflight)/g;
const APPLY_RE = /@apply\s+([\w\s/:.[\]-]+);?/g;
const LAYER_RE = /@layer\s+(base|components|utilities)\s*\{/g;
const SCREEN_DIRECTIVE_RE = /@screen\s+([\w-]+)\s*\{/g;
const VARIANTS_DIRECTIVE_RE = /@variants\s+([\w,\s-]+)\s*\{/g;
const RESPONSIVE_DIRECTIVE_RE = /@responsive\s*\{/g;

// Custom classes within @layer / @responsive / @variants blocks
const CLASS_IN_BLOCK_RE = /\.([\w-]+)\s*\{/g;

// Config JS patterns
const THEME_EXTEND_RE = /extend\s*:\s*\{/;
const THEME_DIRECT_RE = /theme\s*:\s*\{/;
const THEME_SECTION_RE = /(\w+)\s*:\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)}/g;

// Plugin detection — require() and import()
const PLUGIN_REQUIRE_RE = /require\(\s*['"](@tailwindcss\/[\w-]+|tailwindcss\/[\w-]+|[\w@/-]+)['"]\s*\)/g;
const PLUGIN_IMPORT_RE = /import\s+\w+\s+from\s+['"](@tailwindcss\/[\w-]+|tailwindcss\/[\w-]+)["']/g;
const INLINE_PLUGIN_RE = /plugin\s*\(\s*(?:function|{|\()/g;
const INLINE_PLUGIN_WITH_NAME_RE = /plugin\s*\(\s*function\s+(\w+)/g;

// Content/purge paths (v2: purge, v3: content)
const CONTENT_RE = /(?:content|purge)\s*:\s*\[([\s\S]*?)\]/;

// Config metadata
const PREFIX_RE = /prefix\s*:\s*['"]([\w-]+)['"]/;
const IMPORTANT_BOOL_RE = /important\s*:\s*(true|false)/;
const IMPORTANT_SEL_RE = /important\s*:\s*['"]([^'"]+)['"]/;
const SEPARATOR_RE = /separator\s*:\s*['"]([^'"]+)['"]/;
const DARK_MODE_RE = /darkMode\s*:\s*['"]?([\w-]+|false)['"]?/;

// Safelist
const SAFELIST_RE = /safelist\s*:\s*\[([\s\S]*?)\]/;

// Presets
const PRESETS_RE = /presets\s*:\s*\[([\s\S]*?)\]/;

// Screens
const SCREENS_RE = /screens\s*:\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)}/;

// Variants config (v2)
const VARIANTS_CONFIG_RE = /variants\s*:\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)}/;

// Core plugins / modules
const CORE_PLUGINS_RE = /corePlugins\s*:\s*\{([^}]*)\}/;
const MODULES_RE = /modules\s*:\s*\{([^}]*)\}/; // v1

// v1 specific: color sections
const V1_TEXT_COLORS_RE = /textColors\s*:\s*\{/;
const V1_BG_COLORS_RE = /backgroundColors\s*:\s*\{/;
const V1_BORDER_COLORS_RE = /borderColors\s*:\s*\{/;

// ─── Plugin class ────────────────────────────────────────────

export class TailwindPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'tailwindcss',
    version: '2.0.0',
    priority: 30,
    category: 'view',
    dependencies: [],
  };

  private detectedVersion: 1 | 2 | 3 | 4 | null = null;
  private configFilePath: string | null = null;

  detect(ctx: ProjectContext): boolean {
    // Check package.json dependencies
    if (ctx.packageJson) {
      const deps = {
        ...(ctx.packageJson.dependencies as Record<string, string> | undefined),
        ...(ctx.packageJson.devDependencies as Record<string, string> | undefined),
      };
      if (deps['tailwindcss']) {
        this.detectedVersion = detectVersionFromSemver(deps['tailwindcss']);

        // Find config file
        for (const name of CONFIG_FILE_NAMES) {
          const p = path.join(ctx.rootPath, name);
          if (fs.existsSync(p)) {
            this.configFilePath = p;
            break;
          }
        }

        return true;
      }
    }

    // Fallback: check for config file on disk
    for (const name of CONFIG_FILE_NAMES) {
      const p = path.join(ctx.rootPath, name);
      if (fs.existsSync(p)) {
        this.configFilePath = p;
        // tailwind.js → v1, tailwind.config.* → v3 (safe default)
        this.detectedVersion = name === 'tailwind.js' ? 1 : 3;
        return true;
      }
    }

    return false;
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'tailwind_uses_plugin', category: 'tailwind', description: 'Tailwind config uses a plugin' },
        { name: 'tailwind_applies', category: 'tailwind', description: 'CSS file uses @apply directive' },
        { name: 'tailwind_custom_class', category: 'tailwind', description: 'Custom class defined in @layer / @responsive / @variants' },
        { name: 'tailwind_screen_ref', category: 'tailwind', description: '@screen directive references a breakpoint' },
        { name: 'tailwind_variant_group', category: 'tailwind', description: '@variants directive groups utilities' },
        { name: 'tailwind_v4_utility', category: 'tailwind', description: '@utility defines a custom utility (v4)' },
        { name: 'tailwind_v4_variant', category: 'tailwind', description: '@variant / @custom-variant defines a custom variant (v4)' },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    const result: FileParseResult = { status: 'ok', symbols: [], edges: [] };

    // Handle config files (JS/TS)
    if (this.isConfigFile(filePath) && ['typescript', 'javascript'].includes(language)) {
      const source = content.toString('utf-8');
      result.frameworkRole = this.detectedVersion === 1 ? 'tailwind_v1_config' : 'tailwind_config';
      this.extractConfigSymbols(source, result);
      return ok(result);
    }

    // Handle CSS files
    if (isCssLike(language, filePath)) {
      const source = content.toString('utf-8');

      // v4 detection
      if (V4_IMPORT_RE.test(source)) {
        result.frameworkRole = 'tailwind_v4_entry';
        this.detectedVersion = 4;
        this.extractV4Config(source, filePath, result);
        return ok(result);
      }

      // v1/v2/v3 directives
      const directiveRe = new RegExp(TAILWIND_DIRECTIVE_RE.source, 'g');
      const directives: string[] = [];
      let dMatch: RegExpExecArray | null;
      while ((dMatch = directiveRe.exec(source)) !== null) {
        directives.push(dMatch[1]);
      }
      if (directives.length > 0) {
        result.frameworkRole = 'tailwind_entry';
        result.symbols.push({
          name: 'tailwind:directives',
          kind: 'variable',
          signature: `@tailwind ${directives.join(', ')}`,
          metadata: { frameworkRole: 'tailwind_directives', directives },
        });
      }

      // @apply directives
      this.extractApplyDirectives(source, filePath, result);

      // @layer custom classes (v2+)
      this.extractLayerClasses(source, filePath, result);

      // @screen directive (v1/v2)
      this.extractScreenDirectives(source, filePath, result);

      // @variants directive (v1/v2)
      this.extractVariantsDirectives(source, filePath, result);

      // @responsive directive (v1)
      this.extractResponsiveDirective(source, filePath, result);

      return ok(result);
    }

    return ok(result);
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }

  // ─── Config file extraction (v1/v2/v3) ─────────────────────

  private extractConfigSymbols(source: string, result: FileParseResult): void {
    // Detect config meta
    const meta = this.extractConfigMeta(source);
    result.symbols.push({
      name: 'tailwind:config',
      kind: 'variable',
      signature: this.buildConfigSignature(meta),
      metadata: {
        frameworkRole: 'tailwind_config_meta',
        version: meta.version,
        prefix: meta.prefix,
        important: meta.important,
        separator: meta.separator,
        darkMode: meta.darkMode,
        presets: meta.presets,
      },
    });

    // Extract theme sections (both override and extend)
    const themeSections = this.extractThemeSections(source);
    for (const section of themeSections) {
      const prefix = section.isExtend ? 'theme.extend' : 'theme';
      result.symbols.push({
        name: `tailwind:${prefix}.${section.category}`,
        kind: 'variable',
        signature: `${prefix}.${section.category} { ${section.keys.slice(0, 15).join(', ')}${section.keys.length > 15 ? ` ... (+${section.keys.length - 15})` : ''} }`,
        metadata: {
          frameworkRole: 'tailwind_theme_section',
          category: section.category,
          keys: section.keys,
          isExtend: section.isExtend,
        },
      });
    }

    // v1-specific color sections
    if (this.detectedVersion === 1) {
      this.extractV1ColorSections(source, result);
    }

    // Extract screens / breakpoints
    const screens = this.extractScreens(source);
    if (screens.length > 0) {
      result.symbols.push({
        name: 'tailwind:screens',
        kind: 'variable',
        signature: `screens { ${screens.map(s => `${s.name}: ${s.value}`).join(', ')} }`,
        metadata: {
          frameworkRole: 'tailwind_screens',
          screens: screens.map(s => ({ name: s.name, value: s.value })),
        },
      });
    }

    // Extract variants config (v2)
    const variants = this.extractVariantsConfig(source);
    for (const v of variants) {
      result.symbols.push({
        name: `tailwind:variants:${v.utility}`,
        kind: 'variable',
        signature: `variants.${v.utility} [${v.variants.join(', ')}]`,
        metadata: { frameworkRole: 'tailwind_variants_config', utility: v.utility, variants: v.variants },
      });
    }

    // Extract plugin registrations
    const plugins = this.extractPluginRefs(source);
    for (const plugin of plugins) {
      result.edges!.push({
        edgeType: 'tailwind_uses_plugin',
        metadata: { pluginName: plugin.name, line: plugin.line, isInline: plugin.isInline },
      });
      result.symbols.push({
        name: `tailwind:plugin:${plugin.name}`,
        kind: 'variable',
        signature: plugin.isInline ? `plugin(function ${plugin.name})` : `plugin ${plugin.name}`,
        metadata: { frameworkRole: 'tailwind_plugin', pluginName: plugin.name, isInline: plugin.isInline },
      });
    }

    // Extract content/purge paths
    const contentPaths = this.extractContentPaths(source);
    if (contentPaths.length > 0) {
      const label = this.detectedVersion === 2 ? 'purge' : 'content';
      result.symbols.push({
        name: `tailwind:${label}`,
        kind: 'variable',
        signature: `${label} [${contentPaths.join(', ')}]`,
        metadata: { frameworkRole: 'tailwind_content_config', paths: contentPaths },
      });
    }

    // Extract safelist (v3+)
    const safelist = this.extractSafelist(source);
    if (safelist.length > 0) {
      result.symbols.push({
        name: 'tailwind:safelist',
        kind: 'variable',
        signature: `safelist [${safelist.slice(0, 10).join(', ')}${safelist.length > 10 ? ` ... (+${safelist.length - 10})` : ''}]`,
        metadata: { frameworkRole: 'tailwind_safelist', patterns: safelist },
      });
    }

    // Extract core plugins / modules
    const corePlugins = this.extractCorePlugins(source);
    if (corePlugins && corePlugins.length > 0) {
      const label = this.detectedVersion === 1 ? 'modules' : 'corePlugins';
      result.symbols.push({
        name: `tailwind:${label}`,
        kind: 'variable',
        signature: `${label} { ${corePlugins.slice(0, 10).join(', ')}${corePlugins.length > 10 ? ' ...' : ''} }`,
        metadata: { frameworkRole: 'tailwind_core_plugins', plugins: corePlugins },
      });
    }
  }

  // ─── v4 CSS-based config extraction ────────────────────────

  private extractV4Config(source: string, filePath: string, result: FileParseResult): void {
    // @theme blocks (including @theme inline)
    const themeRe = new RegExp(V4_THEME_RE.source, 'g');
    let tMatch: RegExpExecArray | null;
    while ((tMatch = themeRe.exec(source)) !== null) {
      const body = extractBraceBody(source, tMatch.index + tMatch[0].length);
      const isInline = tMatch[0].includes('inline');

      // Group custom properties by prefix: --color-*, --font-*, --spacing-*, etc.
      const groups = new Map<string, string[]>();
      const propRe = /--([\w-]+)\s*:/g;
      let pMatch: RegExpExecArray | null;
      while ((pMatch = propRe.exec(body)) !== null) {
        const fullName = pMatch[1];
        const prefix = fullName.split('-')[0]; // color, font, spacing, etc.
        if (!groups.has(prefix)) groups.set(prefix, []);
        groups.get(prefix)!.push(fullName);
      }

      for (const [prefix, keys] of groups) {
        result.symbols.push({
          name: `tailwind:v4:theme:${prefix}`,
          kind: 'variable',
          signature: `@theme${isInline ? ' inline' : ''} --${prefix}-* (${keys.length} tokens)`,
          metadata: {
            frameworkRole: 'tailwind_v4_theme',
            group: prefix,
            isInline,
            customProperties: keys,
          },
        });
      }
    }

    // @plugin directives
    const pluginRe = new RegExp(V4_PLUGIN_RE.source, 'g');
    let plMatch: RegExpExecArray | null;
    while ((plMatch = pluginRe.exec(source)) !== null) {
      const line = lineAt(source, plMatch.index);
      result.edges!.push({
        edgeType: 'tailwind_uses_plugin',
        metadata: { pluginName: plMatch[1], line, isInline: false },
      });
      result.symbols.push({
        name: `tailwind:plugin:${plMatch[1]}`,
        kind: 'variable',
        signature: `@plugin "${plMatch[1]}"`,
        metadata: { frameworkRole: 'tailwind_plugin', pluginName: plMatch[1] },
      });
    }

    // @source directives
    const sourceRe = new RegExp(V4_SOURCE_RE.source, 'g');
    const sourcePaths: string[] = [];
    let sMatch: RegExpExecArray | null;
    while ((sMatch = sourceRe.exec(source)) !== null) {
      sourcePaths.push(sMatch[1]);
    }
    if (sourcePaths.length > 0) {
      result.symbols.push({
        name: 'tailwind:v4:source',
        kind: 'variable',
        signature: `@source [${sourcePaths.join(', ')}]`,
        metadata: { frameworkRole: 'tailwind_v4_source', paths: sourcePaths },
      });
    }

    // @utility directives (v4 custom utilities)
    const utilityRe = new RegExp(V4_UTILITY_RE.source, 'g');
    let uMatch: RegExpExecArray | null;
    while ((uMatch = utilityRe.exec(source)) !== null) {
      const line = lineAt(source, uMatch.index);
      const body = extractBraceBody(source, uMatch.index + uMatch[0].length);
      result.edges!.push({
        edgeType: 'tailwind_v4_utility',
        metadata: { name: uMatch[1], filePath, line },
      });
      result.symbols.push({
        name: `tailwind:utility:${uMatch[1]}`,
        kind: 'function',
        signature: `@utility ${uMatch[1]} { ... }`,
        line: line,
        metadata: { frameworkRole: 'tailwind_v4_utility', bodyLength: body.length },
      });
    }

    // @variant and @custom-variant directives
    for (const re of [V4_VARIANT_RE, V4_CUSTOM_VARIANT_RE]) {
      const variantRe = new RegExp(re.source, 'g');
      let vMatch: RegExpExecArray | null;
      while ((vMatch = variantRe.exec(source)) !== null) {
        const line = lineAt(source, vMatch.index);
        result.edges!.push({
          edgeType: 'tailwind_v4_variant',
          metadata: { name: vMatch[1], filePath, line },
        });
        result.symbols.push({
          name: `tailwind:variant:${vMatch[1]}`,
          kind: 'variable',
          signature: `@variant ${vMatch[1]}`,
          line: line,
          metadata: { frameworkRole: 'tailwind_v4_variant' },
        });
      }
    }

    // @config directive — reference to JS config (v4 migration)
    const configRe = new RegExp(V4_CONFIG_RE.source, 'g');
    let cMatch: RegExpExecArray | null;
    while ((cMatch = configRe.exec(source)) !== null) {
      result.symbols.push({
        name: 'tailwind:v4:config-ref',
        kind: 'variable',
        signature: `@config "${cMatch[1]}"`,
        metadata: { frameworkRole: 'tailwind_v4_config_ref', configPath: cMatch[1] },
      });
    }

    // @apply and @layer in v4 CSS files too
    this.extractApplyDirectives(source, filePath, result);
    this.extractLayerClasses(source, filePath, result);
  }

  // ─── @apply extraction ─────────────────────────────────────

  private extractApplyDirectives(source: string, filePath: string, result: FileParseResult): void {
    const re = new RegExp(APPLY_RE.source, 'g');
    let match: RegExpExecArray | null;
    const utilities = new Set<string>();
    const locations: Array<{ line: number; classes: string[] }> = [];
    while ((match = re.exec(source)) !== null) {
      const classes = match[1].trim().split(/\s+/).filter(c => c.length > 0);
      for (const cls of classes) utilities.add(cls);
      locations.push({ line: lineAt(source, match.index), classes });
    }
    if (utilities.size > 0) {
      result.edges!.push({
        edgeType: 'tailwind_applies',
        metadata: { filePath, utilities: [...utilities], count: locations.length },
      });
    }
  }

  // ─── @layer custom class extraction ────────────────────────

  private extractLayerClasses(source: string, filePath: string, result: FileParseResult): void {
    const re = new RegExp(LAYER_RE.source, 'g');
    let layerMatch: RegExpExecArray | null;
    while ((layerMatch = re.exec(source)) !== null) {
      const layer = layerMatch[1] as 'base' | 'components' | 'utilities';
      const start = layerMatch.index + layerMatch[0].length;
      const body = extractBraceBody(source, start);
      this.extractClassesFromBlock(body, layer, filePath, source, start, result);
    }
  }

  // ─── @screen directive (v1/v2) ─────────────────────────────

  private extractScreenDirectives(source: string, filePath: string, result: FileParseResult): void {
    const re = new RegExp(SCREEN_DIRECTIVE_RE.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      const screenName = match[1];
      const line = lineAt(source, match.index);
      const start = match.index + match[0].length;
      const body = extractBraceBody(source, start);

      result.edges!.push({
        edgeType: 'tailwind_screen_ref',
        metadata: { screen: screenName, filePath, line },
      });

      // Extract classes inside @screen
      this.extractClassesFromBlock(body, 'utilities', filePath, source, start, result);
    }
  }

  // ─── @variants directive (v1/v2) ───────────────────────────

  private extractVariantsDirectives(source: string, filePath: string, result: FileParseResult): void {
    const re = new RegExp(VARIANTS_DIRECTIVE_RE.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      const variants = match[1].split(',').map(v => v.trim()).filter(Boolean);
      const line = lineAt(source, match.index);
      const start = match.index + match[0].length;
      const body = extractBraceBody(source, start);

      result.edges!.push({
        edgeType: 'tailwind_variant_group',
        metadata: { variants, filePath, line },
      });

      // Extract classes inside @variants
      this.extractClassesFromBlock(body, 'utilities', filePath, source, start, result);
    }
  }

  // ─── @responsive directive (v1) ────────────────────────────

  private extractResponsiveDirective(source: string, filePath: string, result: FileParseResult): void {
    const re = new RegExp(RESPONSIVE_DIRECTIVE_RE.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      const start = match.index + match[0].length;
      const body = extractBraceBody(source, start);

      result.edges!.push({
        edgeType: 'tailwind_variant_group',
        metadata: { variants: ['responsive'], filePath, line: lineAt(source, match.index) },
      });

      this.extractClassesFromBlock(body, 'utilities', filePath, source, start, result);
    }
  }

  // ─── Shared: extract classes from a block ──────────────────

  private extractClassesFromBlock(
    body: string,
    layer: string,
    filePath: string,
    fullSource: string,
    blockStart: number,
    result: FileParseResult,
  ): void {
    const classRe = new RegExp(CLASS_IN_BLOCK_RE.source, 'g');
    let cMatch: RegExpExecArray | null;
    while ((cMatch = classRe.exec(body)) !== null) {
      const line = lineAt(fullSource, blockStart + cMatch.index);
      result.edges!.push({
        edgeType: 'tailwind_custom_class',
        metadata: { className: cMatch[1], layer, filePath, line },
      });
      result.symbols.push({
        name: cMatch[1],
        kind: 'variable',
        signature: `.${cMatch[1]} (@layer ${layer})`,
        line: line,
        metadata: { frameworkRole: 'tailwind_custom_class', layer },
      });
    }
  }

  // ─── Config metadata extraction ────────────────────────────

  private extractConfigMeta(source: string): TailwindConfigMeta {
    const version = this.detectedVersion ?? 3;

    const prefixMatch = source.match(PREFIX_RE);
    const prefix = prefixMatch?.[1] ?? null;

    let important: boolean | string | null = null;
    const importantBool = source.match(IMPORTANT_BOOL_RE);
    const importantSel = source.match(IMPORTANT_SEL_RE);
    if (importantBool) important = importantBool[1] === 'true';
    else if (importantSel) important = importantSel[1];

    const separatorMatch = source.match(SEPARATOR_RE);
    const separator = separatorMatch?.[1] ?? null;

    const darkModeMatch = source.match(DARK_MODE_RE);
    const darkMode = darkModeMatch?.[1] ?? null;

    // Presets
    const presets: string[] = [];
    const presetsMatch = source.match(PRESETS_RE);
    if (presetsMatch) {
      const presetRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
      let pMatch: RegExpExecArray | null;
      while ((pMatch = presetRe.exec(presetsMatch[1])) !== null) {
        presets.push(pMatch[1]);
      }
    }

    // Core plugins
    const corePlugins = this.extractCorePlugins(source);

    return {
      version: version as 1 | 2 | 3 | 4,
      prefix,
      important,
      separator,
      darkMode,
      presets,
      corePlugins,
    };
  }

  // ─── Theme section extraction ──────────────────────────────

  private extractThemeSections(source: string): TailwindThemeSection[] {
    const results: TailwindThemeSection[] = [];

    // Extract theme.extend sections
    if (THEME_EXTEND_RE.test(source)) {
      const extendIdx = source.search(THEME_EXTEND_RE);
      if (extendIdx !== -1) {
        const afterExtend = source.slice(extendIdx);
        const braceStart = afterExtend.indexOf('{');
        if (braceStart !== -1) {
          const body = extractBraceBody(afterExtend, braceStart + 1);
          results.push(...this.extractSectionsFromBody(body, true));
        }
      }
    }

    // Extract direct theme overrides (theme.colors, theme.spacing, etc.)
    // Only non-extend sections at theme level
    const themeIdx = source.search(THEME_DIRECT_RE);
    if (themeIdx !== -1) {
      const afterTheme = source.slice(themeIdx);
      const braceStart = afterTheme.indexOf('{');
      if (braceStart !== -1) {
        const body = extractBraceBody(afterTheme, braceStart + 1);
        // Filter out 'extend' itself — already handled above
        const filtered = this.extractSectionsFromBody(body, false)
          .filter(s => s.category !== 'extend');
        results.push(...filtered);
      }
    }

    return results;
  }

  private extractSectionsFromBody(body: string, isExtend: boolean): TailwindThemeSection[] {
    const results: TailwindThemeSection[] = [];
    const sectionRe = new RegExp(THEME_SECTION_RE.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = sectionRe.exec(body)) !== null) {
      const category = match[1];
      const sectionBody = match[2];
      const keyRe = /['"]?([\w-]+)['"]?\s*:/g;
      const keys: string[] = [];
      let kMatch: RegExpExecArray | null;
      while ((kMatch = keyRe.exec(sectionBody)) !== null) {
        keys.push(kMatch[1]);
      }
      if (keys.length > 0) {
        results.push({ category, keys, isExtend });
      }
    }
    return results;
  }

  // ─── v1 color sections ─────────────────────────────────────

  private extractV1ColorSections(source: string, result: FileParseResult): void {
    const v1Sections = [
      { re: V1_TEXT_COLORS_RE, name: 'textColors' },
      { re: V1_BG_COLORS_RE, name: 'backgroundColors' },
      { re: V1_BORDER_COLORS_RE, name: 'borderColors' },
    ];

    for (const { re, name } of v1Sections) {
      const match = re.exec(source);
      if (!match) continue;

      const body = extractBraceBody(source, match.index + match[0].length);
      const keyRe = /['"]?([\w-]+)['"]?\s*:/g;
      const keys: string[] = [];
      let kMatch: RegExpExecArray | null;
      while ((kMatch = keyRe.exec(body)) !== null) {
        keys.push(kMatch[1]);
      }
      if (keys.length > 0) {
        result.symbols.push({
          name: `tailwind:v1:${name}`,
          kind: 'variable',
          signature: `${name} { ${keys.slice(0, 15).join(', ')}${keys.length > 15 ? ' ...' : ''} }`,
          metadata: { frameworkRole: 'tailwind_v1_colors', section: name, keys },
        });
      }
    }
  }

  // ─── Screens extraction ────────────────────────────────────

  private extractScreens(source: string): TailwindScreenDef[] {
    const match = source.match(SCREENS_RE);
    if (!match) return [];

    const body = match[1];
    const screens: TailwindScreenDef[] = [];

    // Simple: 'sm': '640px'
    const simpleRe = /['"]?([\w-]+)['"]?\s*:\s*['"]([^'"]+)['"]/g;
    let sMatch: RegExpExecArray | null;
    while ((sMatch = simpleRe.exec(body)) !== null) {
      screens.push({ name: sMatch[1], value: sMatch[2] });
    }

    // Object: 'sm': { min: '640px', max: '767px' }
    const objRe = /['"]?([\w-]+)['"]?\s*:\s*\{([^}]+)\}/g;
    while ((sMatch = objRe.exec(body)) !== null) {
      const name = sMatch[1];
      if (screens.some(s => s.name === name)) continue; // already matched as simple
      const inner = sMatch[2];
      const minMatch = inner.match(/min\s*:\s*['"]([^'"]+)['"]/);
      const maxMatch = inner.match(/max\s*:\s*['"]([^'"]+)['"]/);
      const value = [minMatch && `min:${minMatch[1]}`, maxMatch && `max:${maxMatch[1]}`]
        .filter(Boolean).join(' ');
      if (value) screens.push({ name, value });
    }

    return screens;
  }

  // ─── Variants config extraction (v2) ───────────────────────

  private extractVariantsConfig(source: string): TailwindVariantConfig[] {
    const match = source.match(VARIANTS_CONFIG_RE);
    if (!match) return [];

    const results: TailwindVariantConfig[] = [];
    const body = match[1];
    const entryRe = /['"]?([\w-]+)['"]?\s*:\s*\[([^\]]+)\]/g;
    let eMatch: RegExpExecArray | null;
    while ((eMatch = entryRe.exec(body)) !== null) {
      const utility = eMatch[1];
      const variants = eMatch[2].match(/['"]([^'"]+)['"]/g)?.map(s => s.replace(/['"]/g, '')) ?? [];
      if (variants.length > 0) {
        results.push({ utility, variants });
      }
    }
    return results;
  }

  // ─── Plugin ref extraction ─────────────────────────────────

  private extractPluginRefs(source: string): TailwindPluginRef[] {
    const results: TailwindPluginRef[] = [];
    const seen = new Set<string>();

    // require('...')
    const requireRe = new RegExp(PLUGIN_REQUIRE_RE.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = requireRe.exec(source)) !== null) {
      const name = match[1];
      if (seen.has(name)) continue;
      seen.add(name);
      results.push({ name, line: lineAt(source, match.index), isInline: false });
    }

    // import ... from '...'
    const importRe = new RegExp(PLUGIN_IMPORT_RE.source, 'g');
    while ((match = importRe.exec(source)) !== null) {
      const name = match[1];
      if (seen.has(name)) continue;
      seen.add(name);
      results.push({ name, line: lineAt(source, match.index), isInline: false });
    }

    // Inline plugin(function name() { ... })
    const inlineNameRe = new RegExp(INLINE_PLUGIN_WITH_NAME_RE.source, 'g');
    while ((match = inlineNameRe.exec(source)) !== null) {
      const name = `inline:${match[1]}`;
      if (seen.has(name)) continue;
      seen.add(name);
      results.push({ name, line: lineAt(source, match.index), isInline: true });
    }

    // Anonymous inline plugins (count only)
    const inlineRe = new RegExp(INLINE_PLUGIN_RE.source, 'g');
    let anonCount = 0;
    while ((match = inlineRe.exec(source)) !== null) {
      anonCount++;
    }
    // Subtract named ones
    anonCount -= results.filter(r => r.isInline).length;
    if (anonCount > 0) {
      results.push({
        name: `inline:anonymous (${anonCount})`,
        line: 0,
        isInline: true,
      });
    }

    return results;
  }

  // ─── Content/purge path extraction ─────────────────────────

  private extractContentPaths(source: string): string[] {
    const match = source.match(CONTENT_RE);
    if (!match) return [];

    const body = match[1];
    const paths: string[] = [];
    const pathRe = /['"]([^'"]+)['"]/g;
    let pMatch: RegExpExecArray | null;
    while ((pMatch = pathRe.exec(body)) !== null) {
      paths.push(pMatch[1]);
    }
    return paths;
  }

  // ─── Safelist extraction ───────────────────────────────────

  private extractSafelist(source: string): string[] {
    const match = source.match(SAFELIST_RE);
    if (!match) return [];

    const body = match[1];
    const patterns: string[] = [];
    const patRe = /['"]([^'"]+)['"]/g;
    let pMatch: RegExpExecArray | null;
    while ((pMatch = patRe.exec(body)) !== null) {
      patterns.push(pMatch[1]);
    }
    return patterns;
  }

  // ─── Core plugins / modules ────────────────────────────────

  private extractCorePlugins(source: string): string[] | null {
    const re = this.detectedVersion === 1 ? MODULES_RE : CORE_PLUGINS_RE;
    const match = source.match(re);
    if (!match) return null;

    const body = match[1];
    const plugins: string[] = [];
    // 'pluginName': true/false
    const entryRe = /['"]?([\w-]+)['"]?\s*:\s*(true|false)/g;
    let eMatch: RegExpExecArray | null;
    while ((eMatch = entryRe.exec(body)) !== null) {
      plugins.push(`${eMatch[1]}:${eMatch[2]}`);
    }
    return plugins.length > 0 ? plugins : null;
  }

  // ─── Config signature builder ──────────────────────────────

  private buildConfigSignature(meta: TailwindConfigMeta): string {
    const parts = [`tailwind v${meta.version}`];
    if (meta.prefix) parts.push(`prefix="${meta.prefix}"`);
    if (meta.important === true) parts.push('important');
    else if (typeof meta.important === 'string') parts.push(`important="${meta.important}"`);
    if (meta.separator && meta.separator !== ':') parts.push(`separator="${meta.separator}"`);
    if (meta.darkMode) parts.push(`darkMode=${meta.darkMode}`);
    if (meta.presets.length > 0) parts.push(`presets=[${meta.presets.join(', ')}]`);
    return parts.join(' | ');
  }

  // ─── File detection ────────────────────────────────────────

  private isConfigFile(filePath: string): boolean {
    const basename = path.basename(filePath);
    return CONFIG_FILE_NAMES.includes(basename);
  }
}

// ─── Helpers ─────────────────────────────────────────────────

function extractBraceBody(source: string, startAfterBrace: number): string {
  let depth = 1;
  let i = startAfterBrace;
  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    i++;
  }
  return source.slice(startAfterBrace, i - 1);
}

function lineAt(source: string, offset: number): number {
  return source.substring(0, offset).split('\n').length;
}

function isCssLike(language: string, filePath: string): boolean {
  if (language === 'css') return true;
  return /\.(css|scss|sass|less|pcss|postcss)$/.test(filePath);
}

function detectVersionFromSemver(version: string): 1 | 2 | 3 | 4 {
  const clean = version.replace(/^[\^~>=<\s]+/, '');
  if (clean.startsWith('4')) return 4;
  if (clean.startsWith('3')) return 3;
  if (clean.startsWith('1') || clean.startsWith('0')) return 1;
  return 2;
}
