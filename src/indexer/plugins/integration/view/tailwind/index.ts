/**
 * TailwindCSS plugin — supports v1, v2, v3, and v4. Full coverage.
 *
 * ── Config files ──────────────────────────────────────────────
 * v1 (tailwind.js):
 *   textColors / backgroundColors / borderColors, modules, options.prefix/important/separator
 * v2 (tailwind.config.js):
 *   purge, darkMode, variants config, screens, @screen / @variants / @responsive in CSS
 * v3 (tailwind.config.js, JIT):
 *   content, safelist, presets, corePlugins, arbitrary values, @container
 * v4 (CSS-first):
 *   @import "tailwindcss", @theme / @theme inline / @theme reference
 *   @plugin, @source / @source not, @utility, @variant, @custom-variant, @config
 *   @layer theme, postcss.config.{js,ts,mjs}
 *
 * ── CSS files ─────────────────────────────────────────────────
 *   @tailwind base/components/utilities/preflight (v1)
 *   @apply (all versions, incl. arbitrary variants)
 *   @layer base/components/utilities
 *   @screen (v1-v3), @variants (v1-v2), @responsive (v1)
 *   @container / @container (named) (v3.1+, v4)
 *
 * ── Template files ────────────────────────────────────────────
 *   HTML/Blade:   class="..."
 *   JSX/TSX:      className="..." / className={`...`} / className={cn(...)}
 *   Vue SFCs:     class="..." / :class="..." / :class="{...}" / :class="[...]"
 *   Svelte:       class="..." / class:variant
 *   Any template: class={...} attribute patterns
 *
 * ── JS/TS files ───────────────────────────────────────────────
 *   cn() / clsx() / cx() / classNames() / twMerge() / twJoin()
 *   cva() / tv() (class-variance-authority / tailwind-variants)
 *   Static string arguments extracted as class inventory
 *
 * ── PostCSS config ────────────────────────────────────────────
 *   postcss.config.{js,ts,mjs,cjs} — tailwindcss plugin detection
 *
 * ── resolveEdges ──────────────────────────────────────────────
 *   Configfile → CSS entry linkage (config used by which CSS entry points)
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
  ResolveContext,
} from '../../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../../errors.js';

// ─── Interfaces ──────────────────────────────────────────────

interface TailwindThemeSection {
  category: string;
  keys: string[];
  isExtend: boolean;
}

interface TailwindPluginRef {
  name: string;
  line: number;
  isInline: boolean;
}

interface TailwindScreenDef {
  name: string;
  value: string;
}

interface TailwindConfigMeta {
  version: 1 | 2 | 3 | 4;
  prefix: string | null;
  important: boolean | string | null;
  separator: string | null;
  darkMode: string | null;
  presets: string[];
  corePlugins: string[] | null;
}

interface TailwindClassInventory {
  static: string[]; // definite static classes
  dynamic: string[]; // classes extracted from cn/clsx/cva args
  helpers: string[]; // which helpers are used: cn, clsx, twMerge, cva, tv
}

// ─── Config file patterns ─────────────────────────────────────

const CONFIG_FILE_NAMES = [
  'tailwind.config.js',
  'tailwind.config.ts',
  'tailwind.config.mjs',
  'tailwind.config.cjs',
  'tailwind.js', // v1
];

const POSTCSS_CONFIG_NAMES = [
  'postcss.config.js',
  'postcss.config.ts',
  'postcss.config.mjs',
  'postcss.config.cjs',
];

// ─── Regex patterns: v4 CSS-first ────────────────────────────

const V4_IMPORT_RE = /@import\s+["']tailwindcss(?:\/[\w-]+)?["']/;
const V4_THEME_BLOCK_RE = /@theme(?:\s+(?:inline|reference))?\s*\{/g;
const V4_THEME_MODIFIER_RE = /@theme\s+(inline|reference)\s*\{/;
const V4_PLUGIN_RE = /@plugin\s+["']([^"']+)["']/g;
const V4_SOURCE_RE = /@source\s+(?:not\s+)?["']([^"']+)["']/g;
const V4_SOURCE_NOT_RE = /@source\s+not\s+["']([^"']+)["']/g;
const V4_UTILITY_RE = /@utility\s+([\w-]+)\s*\{/g;
const V4_VARIANT_RE = /@variant\s+([\w-]+)/g;
const V4_CUSTOM_VARIANT_RE = /@custom-variant\s+([\w-]+)/g;
const V4_CONFIG_RE = /@config\s+["']([^"']+)["']/g;
const V4_LAYER_THEME_RE = /@layer\s+theme\s*\{/g;

// ─── Regex patterns: v1-v3 CSS directives ────────────────────

const TAILWIND_DIRECTIVE_RE = /@tailwind\s+(base|components|utilities|preflight|screens)/g;
// @apply supports !important modifier on each class: @apply !text-red-500 hover:!bg-blue-500
const APPLY_RE = /@apply\s+(!?[\w\s/:.![\]()'"-]+?);/g;
const LAYER_RE = /@layer\s+(base|components|utilities)\s*\{/g;
const SCREEN_DIRECTIVE_RE = /@screen\s+([\w-]+)\s*\{/g;
const VARIANTS_DIRECTIVE_RE = /@variants\s+([\w,\s-]+)\s*\{/g;
const RESPONSIVE_DIRECTIVE_RE = /@responsive\s*\{/g;
const CONTAINER_QUERY_RE = /@container\s*(?:([\w/-]+)\s*)?\(([^)]+)\)\s*\{/g;

// ─── Regex patterns: config JS ────────────────────────────────

const THEME_EXTEND_RE = /\bextend\s*:\s*\{/;
const THEME_DIRECT_RE = /\btheme\s*:\s*\{/;
const THEME_SECTION_RE = /(\w+)\s*:\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)}/g;
const PREFIX_RE = /\bprefix\s*:\s*['"]([\w-]+)['"]/;
const IMPORTANT_BOOL_RE = /\bimportant\s*:\s*(true|false)/;
const IMPORTANT_SEL_RE = /\bimportant\s*:\s*['"]([^'"]+)['"]/;
const SEPARATOR_RE = /\bseparator\s*:\s*['"]([^'"]+)['"]/;
const DARK_MODE_RE = /\bdarkMode\s*:\s*['"]?([\w-]+|false)['"]?/;
const CONTENT_RE = /(?:content|purge)\s*:\s*\[([\s\S]*?)\]/;
const SAFELIST_RE = /\bsafelist\s*:\s*\[([\s\S]*?)\]/;
const PRESETS_RE = /\bpresets\s*:\s*\[([\s\S]*?)\]/;
const _SCREENS_RE = /\bscreens\s*:\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)}/;
const VARIANTS_CONFIG_RE = /\bvariants\s*:\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)}/;
const CORE_PLUGINS_RE = /\bcorePlugins\s*:\s*\{([^}]*)\}/;
const MODULES_RE = /\bmodules\s*:\s*\{([^}]*)\}/;
const PLUGIN_REQUIRE_RE =
  /require\(\s*['"](@tailwindcss\/[\w-]+|tailwindcss\/[\w-]+|[\w@/-]+)['"]\s*\)/g;
const PLUGIN_IMPORT_RE =
  /import\s+\w+\s+from\s+['"](@tailwindcss\/[\w-]+|tailwindcss\/[\w-]+)["']/g;
const INLINE_PLUGIN_WITH_NAME_RE = /\bplugin\s*\(\s*function\s+(\w+)/g;
const INLINE_PLUGIN_RE = /\bplugin\s*\(\s*(?:function|{|\()/g;
const V1_TEXT_COLORS_RE = /\btextColors\s*:\s*\{/;
const V1_BG_COLORS_RE = /\bbackgroundColors\s*:\s*\{/;
const V1_BORDER_COLORS_RE = /\bborderColors\s*:\s*\{/;
const CLASS_IN_BLOCK_RE = /\.([\w-]+)\s*\{/g;

// ─── Regex patterns: template scanning ───────────────────────

// Static class attributes in HTML/Blade/Vue/Svelte
const HTML_CLASS_ATTR_RE = /\bclass\s*=\s*["']([^"']+)["']/g;
// JSX className (static string)
const JSX_CLASSNAME_STATIC_RE = /\bclassName\s*=\s*["']([^"']+)["']/g;
// JSX className={`template`} — extract static segments
const _JSX_CLASSNAME_TMPL_RE = /\bclassName\s*=\s*\{`([^`]+)`\}/g;
// JSX className={"string"}
const JSX_CLASSNAME_BRACE_STR_RE = /\bclassName\s*=\s*\{["']([^"']+)["']\}/g;
// Vue :class="['a', 'b']" or :class="'a'"
const VUE_BIND_CLASS_ARR_RE = /:class\s*=\s*"\[([^\]]+)\]"/g;
// Vue :class="{ 'bg-blue-500': cond }"
const VUE_BIND_CLASS_OBJ_RE = /:class\s*=\s*"\{([^}]+)\}"/g;
// Svelte class:variant (with binding) and class:variant shorthand (without =)
// Uses lookahead so the terminator is not consumed, preventing skipping the next match
const SVELTE_CLASS_DIR_RE = /\bclass:([\w-]+)(?=\s*[={>\s]|$)/g;
// Generic: any quoted string in class binding context
const GENERIC_CLASS_TMPL_RE = /\bclass(?:Name)?\s*=\s*\{([^}]{1,300})\}/g;

// ─── Regex patterns: JS/TS class helpers ─────────────────────

// cn / clsx / cx / classNames / classnames / twMerge / twJoin / ctl call detection
// Also detects twin.macro's tw tagged template (tw`...`)
const CLASS_HELPER_CALL_RE = /\b(cn|clsx|cx|classNames|classnames|twMerge|twJoin|ctl)\s*\(/g;
// twin.macro: tw`flex p-4` or tw.div`flex p-4` or tw.styled.div`...`
const TWIN_MACRO_RE = /\btw(?:\.\w+)*`([^`]+)`/g;
// cva() / tv() for CVA / tailwind-variants
const CVA_CALL_RE = /\b(cva|tv)\s*\(/g;
// Extract string literals from function arg lists
const STRING_LITERAL_RE = /["'`]([^"'`\n]{2,120})["'`]/g;

// ─── Tailwind class validator ─────────────────────────────────

// Heuristic: token looks like a Tailwind class.
// Matches known utility prefixes after stripping any modifier prefix (hover:, sm:, dark: etc.)
// Tailwind utility detector — tests the core utility (without modifier prefix).
// Spacing: p-4 px-2 py-6 pt-0 etc. — must be followed by digit, bracket, auto, full, etc.
// We require spacing utilities to end in a digit, word char (not open-ended prefix match).
const TW_UTIL_RE =
  /^(?:flex(?:$|-\w)|grid(?:$|-\w)|block$|inline(?:$|-\w)|hidden$|container(?:$|-\w)|overflow-|prose(?:$|-\w)|z-\d|px?-\w|py?-\w|pt-\w|pb-\w|pl-\w|pr-\w|mx?-\w|my?-\w|mt-\w|mb-\w|ml-\w|mr-\w|gap-\w|gap-x-\w|gap-y-\w|space-[xy]-\w|w-\w|h-\w|min-w-\w|min-h-\w|max-w-\w|max-h-\w|size-\w|text-\w|font-\w|leading-\w|tracking-\w|decoration-\w|bg-\w|bg-opacity-\w|border(?:$|-\w)|ring(?:$|-\w)|shadow(?:$|-\w)|rounded(?:$|-\w)|opacity-\w|transition(?:$|-\w)|duration-\w|ease-\w|delay-\w|scale-\w|rotate-\w|translate-[xy]-\w|skew-[xy]-\w|origin-\w|cursor-\w|select-\w|pointer-events-\w|appearance-\w|resize(?:$|-\w)|outline(?:$|-\w)|scroll-\w|snap-\w|touch-\w|will-change-\w|aspect-\w|columns-\w|break-\w|box-\w|object-\w|float-\w|clear-\w|isolate$|table(?:$|-\w)|caption-\w|sr-only$|not-sr-only$|col-\w|col-span-\w|row-\w|row-span-\w|order-\w|place-\w|self-\w|justify-\w|items-\w|content-\w|grow(?:$|-\w)|shrink(?:$|-\w)|basis-\w|static$|fixed$|absolute$|relative$|sticky$|top-\w|right-\w|bottom-\w|left-\w|inset-\w|visible$|invisible$|truncate$|whitespace-\w|line-clamp-\w|list-\w|from-\w|via-\w|to-\w|blur(?:$|-\w)|brightness-\w|contrast-\w|drop-shadow(?:$|-\w)|grayscale(?:$|-\w)|hue-rotate-\w|invert(?:$|-\w)|saturate-\w|sepia(?:$|-\w)|backdrop-\w|fill-\w|stroke-\w|animate-\w|divide-\w|placeholder-\w|caret-\w|accent-\w|underline$|overline$|line-through$|no-underline$|uppercase$|lowercase$|capitalize$|normal-case$|italic$|not-italic$|antialiased$|subpixel-antialiased$|\[.+\])/;

// State/responsive modifiers
const TW_MODIFIER_RE =
  /^(?:hover|focus|active|disabled|visited|checked|placeholder|first|last|odd|even|group-hover|group-focus|peer-hover|focus-within|focus-visible|dark|light|print|motion-safe|motion-reduce|sm|md|lg|xl|2xl|container|max-sm|max-md|max-lg|max-xl|[\w-]+):/;

function isTailwindClass(token: string): boolean {
  if (!token || token.length < 2) return false;
  // Pure arbitrary value: [32px] [#1a56db]
  if (/^\[.+\]$/.test(token)) return true;
  // Strip modifier prefixes (hover:, sm:, dark:, group-hover:, etc.)
  let core = token;
  while (TW_MODIFIER_RE.test(core)) {
    core = core.replace(/^[\w-]+:/, '');
  }
  // Utility with arbitrary value suffix: p-[32px], bg-[#1a56db], text-[14px], w-[calc(...)]
  if (/\[\S+\]$/.test(core)) {
    const prefix = core.replace(/\[.+\]$/, '');
    // prefix must be a valid TW utility prefix (non-empty, ends with -)
    if (prefix && prefix.endsWith('-')) return true;
  }
  return TW_UTIL_RE.test(core);
}

// ─── Plugin class ─────────────────────────────────────────────

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

  // ── detect ─────────────────────────────────────────────────

  detect(ctx: ProjectContext): boolean {
    // 1. Check package.json
    if (ctx.packageJson) {
      const deps = {
        ...(ctx.packageJson.dependencies as Record<string, string> | undefined),
        ...(ctx.packageJson.devDependencies as Record<string, string> | undefined),
      };
      if (deps['tailwindcss']) {
        this.detectedVersion = detectVersionFromSemver(deps['tailwindcss']);
        this.findConfigFiles(ctx.rootPath);
        return true;
      }
    }

    // 2. Fallback: config file on disk
    for (const name of CONFIG_FILE_NAMES) {
      const p = path.join(ctx.rootPath, name);
      if (fs.existsSync(p)) {
        this.configFilePath = p;
        this.detectedVersion = name === 'tailwind.js' ? 1 : 3;
        this.findPostCssConfig(ctx.rootPath);
        return true;
      }
    }

    return false;
  }

  private findConfigFiles(rootPath: string): void {
    for (const name of CONFIG_FILE_NAMES) {
      const p = path.join(rootPath, name);
      if (fs.existsSync(p)) {
        this.configFilePath = p;
        break;
      }
    }
    this.findPostCssConfig(rootPath);
  }

  private findPostCssConfig(rootPath: string): void {
    for (const name of POSTCSS_CONFIG_NAMES) {
      const p = path.join(rootPath, name);
      if (fs.existsSync(p)) {
        this.postCssConfigPath = p;
        break;
      }
    }
  }

  // ── registerSchema ─────────────────────────────────────────

  registerSchema() {
    return {
      edgeTypes: [
        // Config-level
        {
          name: 'tailwind_uses_plugin',
          category: 'tailwind',
          description: 'Tailwind config uses a plugin',
        },
        {
          name: 'tailwind_postcss_plugin',
          category: 'tailwind',
          description: 'PostCSS config registers tailwindcss plugin',
        },
        // CSS-level
        {
          name: 'tailwind_applies',
          category: 'tailwind',
          description: 'CSS file uses @apply directive',
        },
        {
          name: 'tailwind_custom_class',
          category: 'tailwind',
          description: 'Custom class defined via @layer / @responsive / @variants',
        },
        {
          name: 'tailwind_screen_ref',
          category: 'tailwind',
          description: '@screen directive references a breakpoint',
        },
        {
          name: 'tailwind_variant_group',
          category: 'tailwind',
          description: '@variants / @responsive directive groups utilities',
        },
        {
          name: 'tailwind_container_query',
          category: 'tailwind',
          description: '@container query in CSS',
        },
        // v4 CSS-level
        {
          name: 'tailwind_v4_utility',
          category: 'tailwind',
          description: '@utility defines a custom utility (v4)',
        },
        {
          name: 'tailwind_v4_variant',
          category: 'tailwind',
          description: '@variant / @custom-variant defines a custom variant (v4)',
        },
        // Template-level
        {
          name: 'tailwind_class_usage',
          category: 'tailwind',
          description: 'Template file uses Tailwind classes in class attribute',
        },
        {
          name: 'tailwind_cn_call',
          category: 'tailwind',
          description: 'File uses cn/clsx/twMerge class composition helper',
        },
        {
          name: 'tailwind_cva_call',
          category: 'tailwind',
          description: 'File uses cva/tv class-variance-authority helper',
        },
        // Cross-file
        {
          name: 'tailwind_config_used_by',
          category: 'tailwind',
          description: 'Config file is used by a CSS entry point',
        },
      ],
    };
  }

  // ── extractNodes ───────────────────────────────────────────

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    const result: FileParseResult = { status: 'ok', symbols: [], edges: [] };
    const source = content.toString('utf-8');
    if (!source.trim()) return ok(result);

    // ── PostCSS config
    if (this.isPostCssConfig(filePath)) {
      this.extractPostCssConfig(source, filePath, result);
      return ok(result);
    }

    // ── Tailwind config (JS/TS)
    if (this.isConfigFile(filePath) && isJsLike(language)) {
      result.frameworkRole = this.detectedVersion === 1 ? 'tailwind_v1_config' : 'tailwind_config';
      this.extractConfigSymbols(source, result);
      return ok(result);
    }

    // ── CSS-like files
    if (isCssLike(language, filePath)) {
      // v4 entry detection
      if (V4_IMPORT_RE.test(source)) {
        result.frameworkRole = 'tailwind_v4_entry';
        if (!this.detectedVersion) this.detectedVersion = 4;
        this.extractV4Css(source, filePath, result);
        return ok(result);
      }
      this.extractClassicCss(source, filePath, result);
      return ok(result);
    }

    // ── Template files (HTML, Blade, Vue, Svelte)
    if (isTemplateLike(language, filePath)) {
      this.extractTemplateClasses(source, filePath, language, result);
      // Vue SFCs and Svelte files may have a <style> block — process it too
      const styleBlock = extractStyleBlock(source);
      if (styleBlock) {
        if (V4_IMPORT_RE.test(styleBlock)) {
          this.extractV4Css(styleBlock, filePath, result);
        } else {
          this.extractClassicCss(styleBlock, filePath, result);
        }
      }
      return ok(result);
    }

    // ── JS/TS files — class composition helpers + static classNames
    if (isJsLike(language)) {
      this.extractJsClassUsage(source, filePath, result);
      return ok(result);
    }

    return ok(result);
  }

  // ── resolveEdges ───────────────────────────────────────────

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];
    const files = ctx.getAllFiles();

    // Link CSS entry points that use @tailwind directives → config file
    const configRel = this.configFilePath
      ? path.relative(ctx.rootPath, this.configFilePath)
      : 'tailwind.config.js';

    for (const file of files) {
      const source = ctx.readFile(file.path);
      if (!source) continue;

      let cssSource: string | null = null;
      if (isCssLike(file.language ?? '', file.path)) {
        cssSource = source;
      } else if (isTemplateLike(file.language ?? '', file.path)) {
        // Vue SFC / Svelte — check <style> block
        cssSource = extractStyleBlock(source);
      }

      if (!cssSource) continue;

      const hasDirective = TAILWIND_DIRECTIVE_RE.test(cssSource) || V4_IMPORT_RE.test(cssSource);
      if (hasDirective) {
        edges.push({
          edgeType: 'tailwind_config_used_by',
          metadata: { configPath: configRel, cssEntry: file.path },
        });
      }
    }

    return ok(edges);
  }

  // ═══════════════════════════════════════════════════════════
  //  Config file extraction (v1/v2/v3)
  // ═══════════════════════════════════════════════════════════

  private extractConfigSymbols(source: string, result: FileParseResult): void {
    const meta = this.extractConfigMeta(source);
    result.symbols.push({
      name: 'tailwind:config',
      kind: 'variable',
      signature: buildConfigSignature(meta),
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

    // Theme sections
    for (const section of this.extractThemeSections(source)) {
      const key = section.isExtend
        ? `tailwind:theme.extend.${section.category}`
        : `tailwind:theme.${section.category}`;
      result.symbols.push({
        name: key,
        kind: 'variable',
        signature: `${section.isExtend ? 'theme.extend' : 'theme'}.${section.category} { ${fmtKeys(section.keys)} }`,
        metadata: {
          frameworkRole: 'tailwind_theme_section',
          category: section.category,
          keys: section.keys,
          isExtend: section.isExtend,
        },
      });
    }

    // v1 color sections
    if (this.detectedVersion === 1) {
      this.extractV1ColorSections(source, result);
    }

    // Screens
    const screens = extractScreens(source);
    if (screens.length > 0) {
      result.symbols.push({
        name: 'tailwind:screens',
        kind: 'variable',
        signature: `screens { ${screens.map((s) => `${s.name}:${s.value}`).join(', ')} }`,
        metadata: { frameworkRole: 'tailwind_screens', screens },
      });
    }

    // Variants config (v2)
    for (const v of extractVariantsConfig(source)) {
      result.symbols.push({
        name: `tailwind:variants:${v.utility}`,
        kind: 'variable',
        signature: `variants.${v.utility} [${v.variants.join(', ')}]`,
        metadata: {
          frameworkRole: 'tailwind_variants_config',
          utility: v.utility,
          variants: v.variants,
        },
      });
    }

    // Plugins
    for (const plugin of extractPluginRefs(source)) {
      result.edges!.push({
        edgeType: 'tailwind_uses_plugin',
        metadata: { pluginName: plugin.name, line: plugin.line, isInline: plugin.isInline },
      });
      result.symbols.push({
        name: `tailwind:plugin:${plugin.name}`,
        kind: 'variable',
        signature: plugin.isInline ? `plugin(function ${plugin.name})` : `plugin ${plugin.name}`,
        metadata: {
          frameworkRole: 'tailwind_plugin',
          pluginName: plugin.name,
          isInline: plugin.isInline,
        },
      });
    }

    // Content/purge
    const contentPaths = extractContentPaths(source);
    if (contentPaths.length > 0) {
      const label = this.detectedVersion === 2 ? 'purge' : 'content';
      result.symbols.push({
        name: `tailwind:${label}`,
        kind: 'variable',
        signature: `${label} [${contentPaths.join(', ')}]`,
        metadata: { frameworkRole: 'tailwind_content_config', paths: contentPaths },
      });
    }

    // Safelist (v3+)
    const safelist = extractSafelist(source);
    if (safelist.length > 0) {
      result.symbols.push({
        name: 'tailwind:safelist',
        kind: 'variable',
        signature: `safelist [${fmtKeys(safelist)}]`,
        metadata: { frameworkRole: 'tailwind_safelist', patterns: safelist },
      });
    }

    // Core plugins / modules
    const corePlugins = extractCorePlugins(source, this.detectedVersion ?? 3);
    if (corePlugins && corePlugins.length > 0) {
      const label = this.detectedVersion === 1 ? 'modules' : 'corePlugins';
      result.symbols.push({
        name: `tailwind:${label}`,
        kind: 'variable',
        signature: `${label} { ${fmtKeys(corePlugins)} }`,
        metadata: { frameworkRole: 'tailwind_core_plugins', plugins: corePlugins },
      });
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  v4 CSS-first extraction
  // ═══════════════════════════════════════════════════════════

  private extractV4Css(source: string, filePath: string, result: FileParseResult): void {
    // @theme blocks (regular / inline / reference)
    const themeRe = new RegExp(V4_THEME_BLOCK_RE.source, 'g');
    let tMatch: RegExpExecArray | null;
    while ((tMatch = themeRe.exec(source)) !== null) {
      const modMatch = V4_THEME_MODIFIER_RE.exec(tMatch[0]);
      const modifier: 'inline' | 'reference' | null = (modMatch?.[1] as any) ?? null;
      const body = extractBraceBody(source, tMatch.index + tMatch[0].length);

      // Group custom properties by prefix
      const groups = new Map<string, string[]>();
      const propRe = /--([\w-]+)\s*:/g;
      let pMatch: RegExpExecArray | null;
      while ((pMatch = propRe.exec(body)) !== null) {
        const fullName = pMatch[1];
        const prefix = fullName.split('-')[0];
        if (!groups.has(prefix)) groups.set(prefix, []);
        groups.get(prefix)!.push(fullName);
      }
      for (const [prefix, keys] of groups) {
        result.symbols.push({
          name: `tailwind:v4:theme:${prefix}${modifier ? `:${modifier}` : ''}`,
          kind: 'variable',
          signature: `@theme${modifier ? ` ${modifier}` : ''} --${prefix}-* (${keys.length} tokens)`,
          metadata: {
            frameworkRole: 'tailwind_v4_theme',
            group: prefix,
            modifier,
            customProperties: keys,
            isInline: modifier === 'inline',
            isReference: modifier === 'reference',
          },
        });
      }
    }

    // @plugin
    const pluginRe = new RegExp(V4_PLUGIN_RE.source, 'g');
    let plMatch: RegExpExecArray | null;
    while ((plMatch = pluginRe.exec(source)) !== null) {
      const line = lineAt(source, plMatch.index);
      result.edges!.push({
        edgeType: 'tailwind_uses_plugin',
        metadata: { pluginName: plMatch[1], line },
      });
      result.symbols.push({
        name: `tailwind:plugin:${plMatch[1]}`,
        kind: 'variable',
        signature: `@plugin "${plMatch[1]}"`,
        metadata: { frameworkRole: 'tailwind_plugin', pluginName: plMatch[1] },
      });
    }

    // @source (including @source not)
    const sourceAllRe = new RegExp(V4_SOURCE_RE.source, 'g');
    const sourceNotRe = new RegExp(V4_SOURCE_NOT_RE.source, 'g');
    const notPaths = new Set<string>();
    let sMatch: RegExpExecArray | null;
    while ((sMatch = sourceNotRe.exec(source)) !== null) notPaths.add(sMatch[1]);

    const sourcePaths: string[] = [];
    const sourceExcluded: string[] = [];
    while ((sMatch = sourceAllRe.exec(source)) !== null) {
      if (notPaths.has(sMatch[1])) sourceExcluded.push(sMatch[1]);
      else sourcePaths.push(sMatch[1]);
    }
    if (sourcePaths.length > 0 || sourceExcluded.length > 0) {
      result.symbols.push({
        name: 'tailwind:v4:source',
        kind: 'variable',
        signature: `@source [${sourcePaths.join(', ')}]${sourceExcluded.length ? ` (excluded: ${sourceExcluded.join(', ')})` : ''}`,
        metadata: {
          frameworkRole: 'tailwind_v4_source',
          paths: sourcePaths,
          excluded: sourceExcluded,
        },
      });
    }

    // @utility
    const utilityRe = new RegExp(V4_UTILITY_RE.source, 'g');
    let uMatch: RegExpExecArray | null;
    while ((uMatch = utilityRe.exec(source)) !== null) {
      const line = lineAt(source, uMatch.index);
      result.edges!.push({
        edgeType: 'tailwind_v4_utility',
        metadata: { name: uMatch[1], filePath, line },
      });
      result.symbols.push({
        name: `tailwind:utility:${uMatch[1]}`,
        kind: 'function',
        signature: `@utility ${uMatch[1]} { ... }`,
        line,
        metadata: { frameworkRole: 'tailwind_v4_utility' },
      });
    }

    // @variant
    const variantRe = new RegExp(V4_VARIANT_RE.source, 'g');
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
        line,
        metadata: { frameworkRole: 'tailwind_v4_variant' },
      });
    }

    // @custom-variant
    const customVariantRe = new RegExp(V4_CUSTOM_VARIANT_RE.source, 'g');
    while ((vMatch = customVariantRe.exec(source)) !== null) {
      const line = lineAt(source, vMatch.index);
      result.edges!.push({
        edgeType: 'tailwind_v4_variant',
        metadata: { name: vMatch[1], filePath, line, isCustom: true },
      });
      result.symbols.push({
        name: `tailwind:variant:${vMatch[1]}`,
        kind: 'variable',
        signature: `@custom-variant ${vMatch[1]}`,
        line,
        metadata: { frameworkRole: 'tailwind_v4_variant', isCustom: true },
      });
    }

    // @config reference
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

    // @layer theme (v4 specific layer)
    const layerThemeRe = new RegExp(V4_LAYER_THEME_RE.source, 'g');
    if (layerThemeRe.exec(source)) {
      result.symbols.push({
        name: 'tailwind:v4:layer-theme',
        kind: 'variable',
        signature: '@layer theme { ... }',
        metadata: { frameworkRole: 'tailwind_v4_layer_theme' },
      });
    }

    // @apply, @layer (components/utilities), @container also apply in v4
    this.extractApplyDirectives(source, filePath, result);
    this.extractLayerClasses(source, filePath, result);
    this.extractContainerQueries(source, filePath, result);
  }

  // ═══════════════════════════════════════════════════════════
  //  Classic CSS (v1/v2/v3)
  // ═══════════════════════════════════════════════════════════

  private extractClassicCss(source: string, filePath: string, result: FileParseResult): void {
    // @tailwind directives
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

    this.extractApplyDirectives(source, filePath, result);
    this.extractLayerClasses(source, filePath, result);
    this.extractScreenDirectives(source, filePath, result);
    this.extractVariantsDirectives(source, filePath, result);
    this.extractResponsiveDirective(source, filePath, result);
    this.extractContainerQueries(source, filePath, result);
  }

  // ═══════════════════════════════════════════════════════════
  //  Template class scanning
  // ═══════════════════════════════════════════════════════════

  private extractTemplateClasses(
    source: string,
    filePath: string,
    language: string,
    result: FileParseResult,
  ): void {
    const staticClasses = new Set<string>();
    const isVue = language === 'vue' || filePath.endsWith('.vue');
    const isSvelte = language === 'svelte' || filePath.endsWith('.svelte');
    const isJsx =
      language === 'typescriptreact' ||
      language === 'javascriptreact' ||
      filePath.endsWith('.tsx') ||
      filePath.endsWith('.jsx') ||
      filePath.endsWith('.mdx'); // MDX contains JSX syntax

    // ── Static class="..." (HTML, Blade, Vue, Svelte, any HTML-like)
    for (const re of [HTML_CLASS_ATTR_RE]) {
      const r = new RegExp(re.source, 'g');
      let m: RegExpExecArray | null;
      while ((m = r.exec(source)) !== null) {
        for (const cls of m[1].split(/\s+/)) {
          if (cls && isTailwindClass(cls)) staticClasses.add(cls);
        }
      }
    }

    // ── JSX className
    if (isJsx) {
      // className="..."
      const r1 = new RegExp(JSX_CLASSNAME_STATIC_RE.source, 'g');
      let m: RegExpExecArray | null;
      while ((m = r1.exec(source)) !== null) {
        for (const cls of m[1].split(/\s+/)) {
          if (cls && isTailwindClass(cls)) staticClasses.add(cls);
        }
      }
      // className={"..."}
      const r2 = new RegExp(JSX_CLASSNAME_BRACE_STR_RE.source, 'g');
      while ((m = r2.exec(source)) !== null) {
        for (const cls of m[1].split(/\s+/)) {
          if (cls && isTailwindClass(cls)) staticClasses.add(cls);
        }
      }
      // className={`template with ${expr} interpolations`} — extract static segments
      // The regex may not handle nested {} in expressions; we scan raw source instead
      const tmplRe = /\bclassName\s*=\s*\{`([^`]*)`\}/g;
      while ((m = tmplRe.exec(source)) !== null) {
        // Split on ${...} and extract static parts
        const segments = m[1].split(/\$\{[^}]*\}/).flatMap((s) => s.split(/\s+/));
        for (const cls of segments) {
          if (cls && isTailwindClass(cls)) staticClasses.add(cls);
        }
      }
    }

    // ── Vue :class bindings
    if (isVue) {
      // :class="['a', 'b']"
      const r1 = new RegExp(VUE_BIND_CLASS_ARR_RE.source, 'g');
      let m: RegExpExecArray | null;
      while ((m = r1.exec(source)) !== null) {
        const strRe = /['"]([^'"]+)['"]/g;
        let sm: RegExpExecArray | null;
        while ((sm = strRe.exec(m[1])) !== null) {
          for (const cls of sm[1].split(/\s+/)) {
            if (cls && isTailwindClass(cls)) staticClasses.add(cls);
          }
        }
      }
      // :class="{ 'bg-blue-500': cond }" — keys are the classes
      const r2 = new RegExp(VUE_BIND_CLASS_OBJ_RE.source, 'g');
      while ((m = r2.exec(source)) !== null) {
        const keyRe = /['"]([^'"]+)['"]\s*:/g;
        let km: RegExpExecArray | null;
        while ((km = keyRe.exec(m[1])) !== null) {
          for (const cls of km[1].split(/\s+/)) {
            if (cls && isTailwindClass(cls)) staticClasses.add(cls);
          }
        }
      }
    }

    // ── Svelte class:variant
    if (isSvelte) {
      const r = new RegExp(SVELTE_CLASS_DIR_RE.source, 'g');
      let m: RegExpExecArray | null;
      while ((m = r.exec(source)) !== null) {
        if (isTailwindClass(m[1])) staticClasses.add(m[1]);
      }
    }

    // ── Generic class={...} template expressions — pull string literals
    const genericRe = new RegExp(GENERIC_CLASS_TMPL_RE.source, 'g');
    let gm: RegExpExecArray | null;
    while ((gm = genericRe.exec(source)) !== null) {
      const strRe = new RegExp(STRING_LITERAL_RE.source, 'g');
      let sm: RegExpExecArray | null;
      while ((sm = strRe.exec(gm[1])) !== null) {
        for (const cls of sm[1].split(/\s+/)) {
          if (cls && isTailwindClass(cls)) staticClasses.add(cls);
        }
      }
    }

    // ── cn / clsx / twMerge calls in templates (JSX inline)
    this.extractJsClassUsage(source, filePath, result);

    // Emit class inventory
    if (staticClasses.size > 0) {
      const classArr = [...staticClasses].sort();
      result.frameworkRole = 'tailwind_template';
      result.edges!.push({
        edgeType: 'tailwind_class_usage',
        metadata: {
          filePath,
          classes: classArr,
          count: classArr.length,
        },
      });
      result.symbols.push({
        name: 'tailwind:classes',
        kind: 'variable',
        signature: `${classArr.length} classes: ${classArr.slice(0, 12).join(' ')}${classArr.length > 12 ? ` ...+${classArr.length - 12}` : ''}`,
        metadata: {
          frameworkRole: 'tailwind_class_inventory',
          classes: classArr,
          count: classArr.length,
        },
      });
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  JS/TS class composition helpers
  // ═══════════════════════════════════════════════════════════

  private extractJsClassUsage(source: string, filePath: string, result: FileParseResult): void {
    const helperRe = new RegExp(CLASS_HELPER_CALL_RE.source, 'g');
    const cvaRe = new RegExp(CVA_CALL_RE.source, 'g');
    const helpersFound = new Set<string>();
    const dynamicClasses = new Set<string>();

    // twin.macro: tw`flex p-4 text-white`
    const twinRe = new RegExp(TWIN_MACRO_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = twinRe.exec(source)) !== null) {
      helpersFound.add('tw');
      for (const cls of m[1].split(/\s+/)) {
        if (cls && isTailwindClass(cls)) dynamicClasses.add(cls);
      }
    }

    // cn / clsx / classnames / twMerge / twJoin calls
    while ((m = helperRe.exec(source)) !== null) {
      helpersFound.add(m[1]);
      // Extract string args — find the call body
      const callStart = m.index + m[0].length;
      const callBody = extractParenBody(source, callStart);
      const strRe = new RegExp(STRING_LITERAL_RE.source, 'g');
      let sm: RegExpExecArray | null;
      while ((sm = strRe.exec(callBody)) !== null) {
        for (const cls of sm[1].split(/\s+/)) {
          if (cls && isTailwindClass(cls)) dynamicClasses.add(cls);
        }
      }
    }

    // cva / tv calls (class-variance-authority / tailwind-variants)
    const cvaHelpersFound = new Set<string>();
    while ((m = cvaRe.exec(source)) !== null) {
      cvaHelpersFound.add(m[1]);
      const callStart = m.index + m[0].length;
      const callBody = extractParenBody(source, callStart);
      const strRe = new RegExp(STRING_LITERAL_RE.source, 'g');
      let sm: RegExpExecArray | null;
      while ((sm = strRe.exec(callBody)) !== null) {
        for (const cls of sm[1].split(/\s+/)) {
          if (cls && isTailwindClass(cls)) dynamicClasses.add(cls);
        }
      }
    }

    if (helpersFound.size > 0) {
      const helpers = [...helpersFound];
      const classes = [...dynamicClasses].sort();
      result.edges!.push({
        edgeType: 'tailwind_cn_call',
        metadata: { filePath, helpers, classes, count: classes.length },
      });
      result.symbols.push({
        name: `tailwind:cn:${helpers.join('+')}`,
        kind: 'variable',
        signature: `${helpers.join('/')} (${classes.length} static classes)`,
        metadata: {
          frameworkRole: 'tailwind_cn_helper',
          helpers,
          classes,
        },
      });
    }

    if (cvaHelpersFound.size > 0) {
      const helpers = [...cvaHelpersFound];
      const classes = [...dynamicClasses].sort();
      result.edges!.push({
        edgeType: 'tailwind_cva_call',
        metadata: { filePath, helpers, classes, count: classes.length },
      });
      result.symbols.push({
        name: `tailwind:cva:${helpers.join('+')}`,
        kind: 'variable',
        signature: `${helpers.join('/')} (${classes.length} variant classes)`,
        metadata: {
          frameworkRole: 'tailwind_cva_helper',
          helpers,
          classes,
        },
      });
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  CSS shared helpers
  // ═══════════════════════════════════════════════════════════

  private extractApplyDirectives(source: string, filePath: string, result: FileParseResult): void {
    const re = new RegExp(APPLY_RE.source, 'g');
    let match: RegExpExecArray | null;
    const utilities = new Set<string>();
    let count = 0;
    while ((match = re.exec(source)) !== null) {
      count++;
      for (const cls of match[1].trim().split(/\s+/).filter(Boolean)) {
        utilities.add(cls);
      }
    }
    if (utilities.size > 0) {
      result.edges!.push({
        edgeType: 'tailwind_applies',
        metadata: { filePath, utilities: [...utilities], count },
      });
    }
  }

  private extractLayerClasses(source: string, filePath: string, result: FileParseResult): void {
    const re = new RegExp(LAYER_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const layer = m[1] as 'base' | 'components' | 'utilities';
      const body = extractBraceBody(source, m.index + m[0].length);
      this.extractClassesFromBlock(body, layer, filePath, source, m.index + m[0].length, result);
    }
  }

  private extractScreenDirectives(source: string, filePath: string, result: FileParseResult): void {
    const re = new RegExp(SCREEN_DIRECTIVE_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const line = lineAt(source, m.index);
      result.edges!.push({
        edgeType: 'tailwind_screen_ref',
        metadata: { screen: m[1], filePath, line },
      });
      const body = extractBraceBody(source, m.index + m[0].length);
      this.extractClassesFromBlock(
        body,
        'utilities',
        filePath,
        source,
        m.index + m[0].length,
        result,
      );
    }
  }

  private extractVariantsDirectives(
    source: string,
    filePath: string,
    result: FileParseResult,
  ): void {
    const re = new RegExp(VARIANTS_DIRECTIVE_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const variants = m[1]
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
      const line = lineAt(source, m.index);
      result.edges!.push({
        edgeType: 'tailwind_variant_group',
        metadata: { variants, filePath, line },
      });
      const body = extractBraceBody(source, m.index + m[0].length);
      this.extractClassesFromBlock(
        body,
        'utilities',
        filePath,
        source,
        m.index + m[0].length,
        result,
      );
    }
  }

  private extractResponsiveDirective(
    source: string,
    filePath: string,
    result: FileParseResult,
  ): void {
    const re = new RegExp(RESPONSIVE_DIRECTIVE_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      result.edges!.push({
        edgeType: 'tailwind_variant_group',
        metadata: { variants: ['responsive'], filePath, line: lineAt(source, m.index) },
      });
      const body = extractBraceBody(source, m.index + m[0].length);
      this.extractClassesFromBlock(
        body,
        'utilities',
        filePath,
        source,
        m.index + m[0].length,
        result,
      );
    }
  }

  private extractContainerQueries(source: string, filePath: string, result: FileParseResult): void {
    const re = new RegExp(CONTAINER_QUERY_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const containerName = m[1]?.trim() || null;
      const condition = m[2];
      const line = lineAt(source, m.index);
      result.edges!.push({
        edgeType: 'tailwind_container_query',
        metadata: { containerName, condition, filePath, line },
      });
      result.symbols.push({
        name: `tailwind:container:${containerName ?? 'anonymous'}`,
        kind: 'variable',
        signature: `@container${containerName ? ` ${containerName}` : ''} (${condition})`,
        line,
        metadata: {
          frameworkRole: 'tailwind_container_query',
          containerName,
          condition,
        },
      });
      const body = extractBraceBody(source, m.index + m[0].length);
      this.extractClassesFromBlock(
        body,
        'utilities',
        filePath,
        source,
        m.index + m[0].length,
        result,
      );
    }
  }

  private extractClassesFromBlock(
    body: string,
    layer: string,
    filePath: string,
    fullSource: string,
    blockStart: number,
    result: FileParseResult,
  ): void {
    const classRe = new RegExp(CLASS_IN_BLOCK_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = classRe.exec(body)) !== null) {
      const line = lineAt(fullSource, blockStart + m.index);
      result.edges!.push({
        edgeType: 'tailwind_custom_class',
        metadata: { className: m[1], layer, filePath, line },
      });
      result.symbols.push({
        name: m[1],
        kind: 'variable',
        signature: `.${m[1]} (@layer ${layer})`,
        line,
        metadata: { frameworkRole: 'tailwind_custom_class', layer },
      });
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  Config helpers
  // ═══════════════════════════════════════════════════════════

  private extractConfigMeta(source: string): TailwindConfigMeta {
    const version = this.detectedVersion ?? 3;
    const prefixMatch = source.match(PREFIX_RE);
    let important: boolean | string | null = null;
    const importantBool = source.match(IMPORTANT_BOOL_RE);
    const importantSel = source.match(IMPORTANT_SEL_RE);
    if (importantBool) important = importantBool[1] === 'true';
    else if (importantSel) important = importantSel[1];
    const separatorMatch = source.match(SEPARATOR_RE);
    const darkModeMatch = source.match(DARK_MODE_RE);
    const presets: string[] = [];
    const presetsMatch = source.match(PRESETS_RE);
    if (presetsMatch) {
      const presetRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
      let pm: RegExpExecArray | null;
      while ((pm = presetRe.exec(presetsMatch[1])) !== null) presets.push(pm[1]);
    }
    return {
      version: version as 1 | 2 | 3 | 4,
      prefix: prefixMatch?.[1] ?? null,
      important,
      separator: separatorMatch?.[1] ?? null,
      darkMode: darkModeMatch?.[1] ?? null,
      presets,
      corePlugins: extractCorePlugins(source, version as 1 | 2 | 3 | 4),
    };
  }

  private extractThemeSections(source: string): TailwindThemeSection[] {
    const results: TailwindThemeSection[] = [];

    if (THEME_EXTEND_RE.test(source)) {
      const idx = source.search(THEME_EXTEND_RE);
      if (idx !== -1) {
        const after = source.slice(idx);
        const brace = after.indexOf('{');
        if (brace !== -1) {
          const body = extractBraceBody(after, brace + 1);
          results.push(...extractSectionsFromBody(body, true));
        }
      }
    }

    const themeIdx = source.search(THEME_DIRECT_RE);
    if (themeIdx !== -1) {
      const after = source.slice(themeIdx);
      const brace = after.indexOf('{');
      if (brace !== -1) {
        const body = extractBraceBody(after, brace + 1);
        results.push(
          ...extractSectionsFromBody(body, false).filter((s) => s.category !== 'extend'),
        );
      }
    }

    return results;
  }

  private extractV1ColorSections(source: string, result: FileParseResult): void {
    for (const { re, name } of [
      { re: V1_TEXT_COLORS_RE, name: 'textColors' },
      { re: V1_BG_COLORS_RE, name: 'backgroundColors' },
      { re: V1_BORDER_COLORS_RE, name: 'borderColors' },
    ]) {
      const idx = source.search(re);
      if (idx === -1) continue;
      const body = extractBraceBody(source, idx + source.slice(idx).indexOf('{') + 1);
      const keys = extractObjectKeys(body);
      if (keys.length > 0) {
        result.symbols.push({
          name: `tailwind:v1:${name}`,
          kind: 'variable',
          signature: `${name} { ${fmtKeys(keys)} }`,
          metadata: { frameworkRole: 'tailwind_v1_colors', section: name, keys },
        });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  PostCSS config detection
  // ═══════════════════════════════════════════════════════════

  private extractPostCssConfig(source: string, filePath: string, result: FileParseResult): void {
    const hasTailwind =
      /['"]tailwindcss['"]/.test(source) ||
      /\btailwindcss\s*[:(,]/.test(source) ||
      /\btailwindcss\s*\(\)/.test(source);
    if (!hasTailwind) return;

    result.frameworkRole = 'tailwind_postcss_config';
    result.edges!.push({
      edgeType: 'tailwind_postcss_plugin',
      metadata: { filePath },
    });
    result.symbols.push({
      name: 'tailwind:postcss',
      kind: 'variable',
      signature: `postcss.config → tailwindcss`,
      metadata: { frameworkRole: 'tailwind_postcss_config', configFile: filePath },
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  File type helpers
  // ═══════════════════════════════════════════════════════════

  private isConfigFile(filePath: string): boolean {
    return CONFIG_FILE_NAMES.includes(path.basename(filePath));
  }

  private isPostCssConfig(filePath: string): boolean {
    return POSTCSS_CONFIG_NAMES.includes(path.basename(filePath));
  }
}

// ─── Module-level helpers ─────────────────────────────────────

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

function extractParenBody(source: string, startAfterParen: number): string {
  let depth = 1;
  let i = startAfterParen;
  let inStr: string | null = null;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (inStr) {
      if (ch === inStr && source[i - 1] !== '\\') inStr = null;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
    }
    i++;
  }
  return source.slice(startAfterParen, i - 1);
}

function lineAt(source: string, offset: number): number {
  return source.substring(0, offset).split('\n').length;
}

function isCssLike(language: string, filePath: string): boolean {
  if (['css', 'scss', 'sass', 'less', 'postcss'].includes(language)) return true;
  return /\.(css|scss|sass|less|pcss|postcss)$/.test(filePath);
}

function isJsLike(language: string): boolean {
  return ['javascript', 'typescript', 'javascriptreact', 'typescriptreact'].includes(language);
}

function isTemplateLike(language: string, filePath: string): boolean {
  if (['html', 'vue', 'svelte', 'blade', 'php', 'astro'].includes(language)) return true;
  if (/\.(html|vue|svelte|blade\.php|astro|njk|hbs|ejs|liquid|twig|jinja|mdx)$/.test(filePath))
    return true;
  // JSX/TSX also contain templates
  if (['typescriptreact', 'javascriptreact'].includes(language)) return true;
  if (/\.(tsx|jsx)$/.test(filePath)) return true;
  return false;
}

/**
 * Extract and concatenate all CSS content from `<style>` blocks.
 * Vue SFCs can have both `<style scoped>` and `<style>` blocks.
 * Handles <style>, <style lang="scss">, <style scoped>, <style module>, etc.
 * Returns null if no style block found.
 */
function extractStyleBlock(source: string): string | null {
  const re = /<style[^>]*>([\s\S]*?)<\/style>/g;
  const parts: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const content = m[1].trim();
    if (content) parts.push(content);
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

function detectVersionFromSemver(version: string): 1 | 2 | 3 | 4 {
  const clean = version.replace(/^[\^~>=<\s]+/, '');
  if (clean.startsWith('4')) return 4;
  if (clean.startsWith('3')) return 3;
  if (clean.startsWith('1') || clean.startsWith('0')) return 1;
  return 2;
}

function extractSectionsFromBody(body: string, isExtend: boolean): TailwindThemeSection[] {
  const results: TailwindThemeSection[] = [];
  const re = new RegExp(THEME_SECTION_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const keys = extractObjectKeys(m[2]);
    if (keys.length > 0) results.push({ category: m[1], keys, isExtend });
  }
  return results;
}

function extractObjectKeys(body: string): string[] {
  const keys: string[] = [];
  const re = /['"]?([\w-]+)['"]?\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) keys.push(m[1]);
  return keys;
}

function extractScreens(source: string): TailwindScreenDef[] {
  // Find the screens: { ... } block with full brace tracking
  const screensIdx = source.search(/\bscreens\s*:\s*\{/);
  if (screensIdx === -1) return [];
  const braceIdx = source.indexOf('{', screensIdx);
  if (braceIdx === -1) return [];
  const body = extractBraceBody(source, braceIdx + 1);

  const screens: TailwindScreenDef[] = [];
  // Simple string values: sm: '640px'
  const simple = /['"]?([\w-]+)['"]?\s*:\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = simple.exec(body)) !== null) screens.push({ name: m[1], value: m[2] });
  // Object format: desktop: { min: '1280px', max: '1535px' }
  const obj = /['"]?([\w-]+)['"]?\s*:\s*\{([^}]+)\}/g;
  while ((m = obj.exec(body)) !== null) {
    if (screens.some((s) => s.name === m![1])) continue;
    const inner = m[2];
    const min = inner.match(/\bmin\s*:\s*['"]([^'"]+)['"]/)?.[1];
    const max = inner.match(/\bmax\s*:\s*['"]([^'"]+)['"]/)?.[1];
    const val = [min && `min:${min}`, max && `max:${max}`].filter(Boolean).join(' ');
    if (val) screens.push({ name: m[1], value: val });
  }
  return screens;
}

function extractVariantsConfig(source: string): Array<{ utility: string; variants: string[] }> {
  const match = source.match(VARIANTS_CONFIG_RE);
  if (!match) return [];
  const results: Array<{ utility: string; variants: string[] }> = [];
  const re = /['"]?([\w-]+)['"]?\s*:\s*\[([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(match[1])) !== null) {
    const variants = m[2].match(/['"]([^'"]+)['"]/g)?.map((s) => s.replace(/['"]/g, '')) ?? [];
    if (variants.length > 0) results.push({ utility: m[1], variants });
  }
  return results;
}

function extractPluginRefs(source: string): TailwindPluginRef[] {
  const results: TailwindPluginRef[] = [];
  const seen = new Set<string>();

  const reqRe = new RegExp(PLUGIN_REQUIRE_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = reqRe.exec(source)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      results.push({ name: m[1], line: lineAt(source, m.index), isInline: false });
    }
  }
  const impRe = new RegExp(PLUGIN_IMPORT_RE.source, 'g');
  while ((m = impRe.exec(source)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      results.push({ name: m[1], line: lineAt(source, m.index), isInline: false });
    }
  }
  const namedRe = new RegExp(INLINE_PLUGIN_WITH_NAME_RE.source, 'g');
  while ((m = namedRe.exec(source)) !== null) {
    const name = `inline:${m[1]}`;
    if (!seen.has(name)) {
      seen.add(name);
      results.push({ name, line: lineAt(source, m.index), isInline: true });
    }
  }
  // Count anonymous inline plugins
  const allInlineRe = new RegExp(INLINE_PLUGIN_RE.source, 'g');
  let anonCount = 0;
  while ((m = allInlineRe.exec(source)) !== null) anonCount++;
  anonCount -= results.filter((r) => r.isInline).length;
  if (anonCount > 0)
    results.push({ name: `inline:anonymous (${anonCount})`, line: 0, isInline: true });

  return results;
}

function extractContentPaths(source: string): string[] {
  const match = source.match(CONTENT_RE);
  if (!match) return [];
  const re = /['"]([^'"]+)['"]/g;
  const paths: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(match[1])) !== null) paths.push(m[1]);
  return paths;
}

function extractSafelist(source: string): string[] {
  const match = source.match(SAFELIST_RE);
  if (!match) return [];
  const re = /['"]([^'"]+)['"]/g;
  const patterns: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(match[1])) !== null) patterns.push(m[1]);
  return patterns;
}

function extractCorePlugins(source: string, version: 1 | 2 | 3 | 4): string[] | null {
  if (version === 1) {
    const match = source.match(MODULES_RE);
    if (!match) return null;
    const re = /['"]?([\w-]+)['"]?\s*:\s*(true|false)/g;
    const plugins: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(match[1])) !== null) plugins.push(`${m[1]}:${m[2]}`);
    return plugins.length > 0 ? plugins : null;
  }

  // Object format: corePlugins: { float: false, clear: false }
  const objMatch = source.match(CORE_PLUGINS_RE);
  if (objMatch) {
    const re = /['"]?([\w-]+)['"]?\s*:\s*(true|false)/g;
    const plugins: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(objMatch[1])) !== null) plugins.push(`${m[1]}:${m[2]}`);
    if (plugins.length > 0) return plugins;
  }

  // Array format: corePlugins: ['container', 'preflight', 'float']
  const arrMatch = source.match(/\bcorePlugins\s*:\s*\[([\s\S]*?)\]/);
  if (arrMatch) {
    const re = /['"]([^'"]+)['"]/g;
    const plugins: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(arrMatch[1])) !== null) plugins.push(m[1]);
    if (plugins.length > 0) return plugins;
  }

  return null;
}

function buildConfigSignature(meta: TailwindConfigMeta): string {
  const parts = [`tailwind v${meta.version}`];
  if (meta.prefix) parts.push(`prefix="${meta.prefix}"`);
  if (meta.important === true) parts.push('important');
  else if (typeof meta.important === 'string') parts.push(`important="${meta.important}"`);
  if (meta.separator && meta.separator !== ':') parts.push(`separator="${meta.separator}"`);
  if (meta.darkMode) parts.push(`darkMode=${meta.darkMode}`);
  if (meta.presets.length) parts.push(`presets=[${meta.presets.join(', ')}]`);
  return parts.join(' | ');
}

function fmtKeys(keys: string[]): string {
  return `${keys.slice(0, 15).join(', ')}${keys.length > 15 ? ` ... (+${keys.length - 15})` : ''}`;
}
