/**
 * NuxtUiPlugin — Detects Nuxt UI (v2 and v3) and Nuxt UI Pro.
 *
 * Nuxt UI v3 is built on Reka UI (formerly Radix Vue) and Tailwind Variants.
 * Nuxt UI v2 is built on Headless UI and Tailwind CSS.
 *
 * Extracts:
 * - app.config.ts theme overrides (component theme customization)
 * - U-prefixed component usage tracking (UButton, UCard, etc.)
 * - Component prop bindings and variants from templates
 * - Form schema definitions (UForm + Zod/Yup/Joi integration)
 * - Nuxt UI Pro page/layout component usage
 * - Tailwind Variants (tv()) definitions in custom components
 * - Color mode / design token usage (useColorMode, app.config.ui)
 *
 * Depends on the nuxt plugin (to understand Nuxt project structure).
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
  RawRoute,
  RawComponent,
  ResolveContext,
} from '../../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../../errors.js';

// ── Types ─────────────────────────────────────────────────────────────────

interface NuxtUiThemeOverride {
  componentName: string;
  keys: string[]; // customized keys like 'base', 'color', 'size', 'variant'
}

interface NuxtUiFormDef {
  name: string;
  schemaType: 'zod' | 'yup' | 'joi' | 'valibot' | 'unknown';
  schemaRef: string;
  fields: string[];
}

interface NuxtUiComponentUsage {
  name: string; // e.g. 'UButton', 'UCard'
  propsUsed: string[]; // props explicitly set
  variants: string[]; // variant prop values
}

// ── Known Nuxt UI components ──────────────────────────────────────────────

/** Nuxt UI v3 core components (U-prefixed in templates). */
const NUXT_UI_V3_COMPONENTS = new Set([
  'UAccordion',
  'UAlert',
  'UAvatar',
  'UAvatarGroup',
  'UBadge',
  'UBreadcrumb',
  'UButton',
  'UButtonGroup',
  'UCalendar',
  'UCard',
  'UCarousel',
  'UCheckbox',
  'UChip',
  'UCollapsible',
  'UColorPicker',
  'UCommandPalette',
  'UContainer',
  'UContextMenu',
  'UDatePicker',
  'UDrawer',
  'UDropdownMenu',
  'UForm',
  'UFormField',
  'UIcon',
  'UInput',
  'UInputMenu',
  'UInputNumber',
  'UKbd',
  'ULink',
  'UModal',
  'UNavigationMenu',
  'UPagination',
  'UPinInput',
  'UPopover',
  'UProgress',
  'URadioGroup',
  'USelect',
  'USelectMenu',
  'USeparator',
  'USkeleton',
  'USlider',
  'USlideover',
  'UStepper',
  'USwitch',
  'UTable',
  'UTabs',
  'UTextarea',
  'UToast',
  'UTooltip',
  'UTree',
]);

/** Nuxt UI Pro components. */
const NUXT_UI_PRO_COMPONENTS = new Set([
  'UPage',
  'UPageBody',
  'UPageCard',
  'UPageColumns',
  'UPageGrid',
  'UPageHeader',
  'UPageHero',
  'UPageLinks',
  'UPageList',
  'UPageSearch',
  'UDashboard',
  'UDashboardGroup',
  'UDashboardLayout',
  'UDashboardNavbar',
  'UDashboardPanel',
  'UDashboardSearch',
  'UDashboardSidebar',
  'UDashboardToolbar',
  'UContentNavigation',
  'UContentSearch',
  'UContentSurround',
  'UContentToc',
  'UAuthForm',
  'UBlogList',
  'UBlogPost',
  'UColorModeButton',
  'UColorModeSelect',
  'UFooter',
  'UFooterColumns',
  'UHeader',
  'UHeaderLinks',
  'UHeaderPopover',
  'ULandingCard',
  'ULandingCTA',
  'ULandingFAQ',
  'ULandingFeature',
  'ULandingGrid',
  'ULandingHero',
  'ULandingLogos',
  'ULandingSection',
  'ULandingTestimonial',
  'UMain',
  'UNavigationTree',
  'UPricingCard',
  'UPricingGrid',
  'UPricingToggle',
]);

// ── Extraction functions ──────────────────────────────────────────────────

/** Extract app.config.ts/js theme overrides. */
function extractAppConfigTheme(source: string): NuxtUiThemeOverride[] {
  const overrides: NuxtUiThemeOverride[] = [];

  // Match: ui: { button: { ... }, card: { ... } }
  const uiBlockMatch = source.match(/\bui\s*:\s*\{/);
  if (!uiBlockMatch) return overrides;

  const uiStart = source.indexOf('{', uiBlockMatch.index! + uiBlockMatch[0].length - 1);
  const uiBody = extractBraceBody(source, uiStart);

  // Each top-level key in the ui block is a component name
  const componentRe = /(\w+)\s*:\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = componentRe.exec(uiBody)) !== null) {
    const componentName = m[1];
    const compStart = uiBody.indexOf('{', m.index + m[0].length - 1);
    const compBody = extractBraceBody(uiBody, compStart);

    // Extract keys being customized
    const keys: string[] = [];
    const keyRe = /(\w+)\s*:/g;
    let km: RegExpExecArray | null;
    while ((km = keyRe.exec(compBody)) !== null) {
      keys.push(km[1]);
    }

    if (keys.length > 0) {
      overrides.push({ componentName, keys: [...new Set(keys)] });
    }
  }

  return overrides;
}

/** Extract U-prefixed component usage from Vue templates. */
function extractNuxtUiComponentUsage(source: string): NuxtUiComponentUsage[] {
  const usages: NuxtUiComponentUsage[] = [];
  const seen = new Map<string, NuxtUiComponentUsage>();

  // Match: <UButton ... > or <UButton ... />
  // Handles both PascalCase and kebab-case
  const componentRe = /<(U[A-Z]\w+)(\s[^>]*)?(?:\/>|>)/g;
  let m: RegExpExecArray | null;
  while ((m = componentRe.exec(source)) !== null) {
    const name = m[1];
    const attrsStr = m[2] || '';

    const existing = seen.get(name);
    const propsUsed = existing?.propsUsed ? [...existing.propsUsed] : [];
    const variants = existing?.variants ? [...existing.variants] : [];

    // Extract props
    const propRe = /(?::)?(\w+)(?:\s*=\s*["'{])?/g;
    let pm: RegExpExecArray | null;
    while ((pm = propRe.exec(attrsStr)) !== null) {
      const prop = pm[1];
      if (prop && !propsUsed.includes(prop)) propsUsed.push(prop);
    }

    // Extract variant/color/size values
    const variantRe = /(?:variant|color|size)\s*=\s*["'](\w+)["']/g;
    let vm: RegExpExecArray | null;
    while ((vm = variantRe.exec(attrsStr)) !== null) {
      if (!variants.includes(vm[1])) variants.push(vm[1]);
    }

    seen.set(name, { name, propsUsed: [...new Set(propsUsed)], variants: [...new Set(variants)] });
  }

  // Also match kebab-case: <u-button ... >
  const kebabRe = /<(u-[a-z][\w-]*)(\s[^>]*)?(?:\/>|>)/g;
  while ((m = kebabRe.exec(source)) !== null) {
    const kebab = m[1];
    const pascal = kebabToPascal(kebab);
    if (!seen.has(pascal)) {
      seen.set(pascal, { name: pascal, propsUsed: [], variants: [] });
    }
  }

  for (const usage of seen.values()) usages.push(usage);
  return usages;
}

/** Extract UForm schema definitions. */
function extractNuxtUiFormSchemas(source: string): NuxtUiFormDef[] {
  const forms: NuxtUiFormDef[] = [];

  // Pattern 1: <UForm :schema="loginSchema" :state="state">
  const formRe = /<UForm[^>]*:schema\s*=\s*["'](\w+)["'][^>]*/g;
  let m: RegExpExecArray | null;
  while ((m = formRe.exec(source)) !== null) {
    const schemaRef = m[1];

    // Determine schema type from the source
    let schemaType: NuxtUiFormDef['schemaType'] = 'unknown';
    if (
      source.includes('z.object') ||
      source.includes('z.string') ||
      source.includes("from 'zod'") ||
      source.includes('from "zod"')
    ) {
      schemaType = 'zod';
    } else if (source.includes('yup.object') || source.includes("from 'yup'")) {
      schemaType = 'yup';
    } else if (source.includes('Joi.object') || source.includes("from 'joi'")) {
      schemaType = 'joi';
    } else if (source.includes('v.object') || source.includes("from 'valibot'")) {
      schemaType = 'valibot';
    }

    // Extract form field names from UFormField
    const fields: string[] = [];
    const fieldRe = /<UFormField[^>]*name\s*=\s*["'](\w+)["']/g;
    let fm: RegExpExecArray | null;
    while ((fm = fieldRe.exec(source)) !== null) {
      fields.push(fm[1]);
    }
    // Also legacy v2: <UFormGroup>
    const groupRe = /<UFormGroup[^>]*name\s*=\s*["'](\w+)["']/g;
    while ((fm = groupRe.exec(source)) !== null) {
      if (!fields.includes(fm[1])) fields.push(fm[1]);
    }

    forms.push({ name: schemaRef, schemaType, schemaRef, fields: [...new Set(fields)] });
  }

  return forms;
}

/** Extract tailwind-variants tv() definitions. */
function extractTvDefinitions(
  source: string,
): { name: string; variants: Record<string, string[]>; slots: string[] }[] {
  const defs: { name: string; variants: Record<string, string[]>; slots: string[] }[] = [];
  const tvRe = /(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*tv\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = tvRe.exec(source)) !== null) {
    const name = match[1];
    const startPos = match.index + match[0].length;
    const body = extractParenBody(source, startPos);

    // slots
    const slots: string[] = [];
    const slotsMatch = body.match(/slots\s*:\s*\{/);
    if (slotsMatch) {
      const slotsStart = body.indexOf('{', slotsMatch.index! + slotsMatch[0].length - 1);
      const slotsBody = extractBraceBody(body, slotsStart);
      const slotRe = /(\w+)\s*:/g;
      let sm: RegExpExecArray | null;
      while ((sm = slotRe.exec(slotsBody)) !== null) slots.push(sm[1]);
    }

    // variants
    const variants: Record<string, string[]> = {};
    const variantsMatch = body.match(/variants\s*:\s*\{/);
    if (variantsMatch) {
      const variantsStart = body.indexOf('{', variantsMatch.index! + variantsMatch[0].length - 1);
      const variantsBody = extractBraceBody(body, variantsStart);
      const vkRe = /(\w+)\s*:\s*\{/g;
      let vkMatch: RegExpExecArray | null;
      while ((vkMatch = vkRe.exec(variantsBody)) !== null) {
        const variantName = vkMatch[1];
        const groupStart = variantsBody.indexOf('{', vkMatch.index + vkMatch[0].length - 1);
        const groupBody = extractBraceBody(variantsBody, groupStart);
        const values: string[] = [];
        const vvRe = /(\w+)\s*:/g;
        let vvMatch: RegExpExecArray | null;
        while ((vvMatch = vvRe.exec(groupBody)) !== null) values.push(vvMatch[1]);
        if (values.length > 0) variants[variantName] = values;
      }
    }

    defs.push({ name, slots, variants });
  }

  return defs;
}

/** Extract useColorMode() and color-mode related patterns. */
function extractColorModeUsage(source: string): boolean {
  return (
    /\buseColorMode\b/.test(source) || /\bcolorMode\b/.test(source) || /\$colorMode/.test(source)
  );
}

// ── Plugin ────────────────────────────────────────────────────────────────

export class NuxtUiPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'nuxt-ui',
    version: '1.0.0',
    priority: 16, // just after nuxt (15)
    category: 'view',
    dependencies: ['nuxt'],
  };

  private isV3 = false;
  private hasPro = false;

  detect(ctx: ProjectContext): boolean {
    const deps = {
      ...(ctx.packageJson?.dependencies as Record<string, string> | undefined),
      ...(ctx.packageJson?.devDependencies as Record<string, string> | undefined),
    };

    const hasNuxtUi = '@nuxt/ui' in deps;
    if (!hasNuxtUi) return false;

    // Detect version: v3 uses reka-ui, v2 uses @headlessui
    const version = deps['@nuxt/ui'] || '';
    this.isV3 = /^\^?3/.test(version) || 'reka-ui' in deps || !('@headlessui/vue' in deps);
    this.hasPro = '@nuxt/ui-pro' in deps;

    // Fallback: check nuxt.config for module registration
    if (!hasNuxtUi) {
      try {
        const configPath = path.join(ctx.rootPath, 'nuxt.config.ts');
        const configContent = fs.readFileSync(configPath, 'utf-8');
        if (/@nuxt\/ui/.test(configContent)) return true;
      } catch {
        /* ignore */
      }
    }

    return true;
  }

  registerSchema() {
    return {
      edgeTypes: [
        {
          name: 'nuxt_ui_component',
          category: 'ui-library',
          description: 'Nuxt UI component usage',
        },
        {
          name: 'nuxt_ui_pro_component',
          category: 'ui-library',
          description: 'Nuxt UI Pro component usage',
        },
        {
          name: 'nuxt_ui_theme',
          category: 'ui-library',
          description: 'app.config.ts theme override',
        },
        {
          name: 'nuxt_ui_form',
          category: 'ui-library',
          description: 'UForm with validation schema',
        },
        {
          name: 'nuxt_ui_variant',
          category: 'ui-library',
          description: 'Tailwind Variants definition (tv())',
        },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    const source = content.toString('utf-8');
    const result: FileParseResult = {
      status: 'ok',
      symbols: [],
      routes: [],
      edges: [],
      components: [],
    };

    // ── app.config.ts — theme customization ──
    if (filePath === 'app.config.ts' || filePath === 'app.config.js') {
      const overrides = extractAppConfigTheme(source);
      for (const override of overrides) {
        result.routes!.push({
          method: 'THEME',
          uri: `nuxt-ui:theme:${override.componentName}`,
          handler: override.componentName,
          metadata: { customizedKeys: override.keys },
        });
        result.edges!.push({
          edgeType: 'nuxt_ui_theme',
          metadata: {
            componentName: override.componentName,
            customizedKeys: override.keys,
          },
        });
      }
      if (overrides.length > 0) {
        result.frameworkRole = 'nuxt_ui_theme';
        return ok(result);
      }
    }

    // Only process Vue and TS/JS files
    if (!['vue', 'typescript', 'javascript'].includes(language)) {
      return ok({ status: 'ok', symbols: [] });
    }

    // ── Component usage in templates ──
    if (language === 'vue') {
      const usages = extractNuxtUiComponentUsage(source);
      for (const usage of usages) {
        const isPro = NUXT_UI_PRO_COMPONENTS.has(usage.name);
        const isCore = NUXT_UI_V3_COMPONENTS.has(usage.name);

        if (isCore || isPro) {
          result.components!.push({
            name: usage.name,
            kind: 'component',
            framework: isPro ? 'nuxt-ui-pro' : 'nuxt-ui',
            props: Object.fromEntries(usage.propsUsed.map((p) => [p, true])),
          });

          result.edges!.push({
            edgeType: isPro ? 'nuxt_ui_pro_component' : 'nuxt_ui_component',
            metadata: {
              componentName: usage.name,
              propsUsed: usage.propsUsed,
              variants: usage.variants,
            },
          });
        }
      }

      // ── UForm schema extraction ──
      const forms = extractNuxtUiFormSchemas(source);
      for (const form of forms) {
        result.routes!.push({
          method: 'FORM',
          uri: `nuxt-ui:form:${form.name}`,
          handler: form.name,
          metadata: {
            schemaType: form.schemaType,
            schemaRef: form.schemaRef,
            fields: form.fields,
          },
        });
        result.edges!.push({
          edgeType: 'nuxt_ui_form',
          metadata: {
            formName: form.name,
            schemaType: form.schemaType,
            fields: form.fields,
          },
        });
      }

      // Color mode
      if (extractColorModeUsage(source)) {
        result.metadata = { ...result.metadata, usesColorMode: true };
      }
    }

    // ── TV definitions in TS/JS/Vue files ──
    if (/\btv\s*\(/.test(source)) {
      const tvDefs = extractTvDefinitions(source);
      for (const tv of tvDefs) {
        result.routes!.push({
          method: 'VARIANT',
          uri: `nuxt-ui:tv:${tv.name}`,
          handler: tv.name,
          metadata: {
            slots: tv.slots,
            variants: tv.variants,
          },
        });
        result.edges!.push({
          edgeType: 'nuxt_ui_variant',
          metadata: {
            name: tv.name,
            slots: tv.slots,
            variants: Object.keys(tv.variants),
          },
        });
      }
    }

    // Determine framework role
    if (result.components!.length > 0 || result.edges!.length > 0 || result.routes!.length > 0) {
      if (!result.frameworkRole) {
        result.frameworkRole = 'nuxt_ui_consumer';
      }
      return ok(result);
    }

    return ok({ status: 'ok', symbols: [] });
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];
    const allFiles = ctx.getAllFiles();

    // Find app.config.ts theme definitions
    const appConfig = allFiles.find(
      (f) => f.path === 'app.config.ts' || f.path === 'app.config.js',
    );

    if (!appConfig) return ok(edges);

    const appConfigSource = ctx.readFile(appConfig.path);
    if (!appConfigSource) return ok(edges);

    const overrides = extractAppConfigTheme(appConfigSource);
    if (overrides.length === 0) return ok(edges);

    // Build theme override map: component name → keys
    const themeMap = new Map(overrides.map((o) => [o.componentName, o.keys]));

    // For each Vue file using Nuxt UI components, link to theme overrides
    const vueFiles = allFiles.filter((f) => f.path.endsWith('.vue'));
    for (const file of vueFiles) {
      const source = ctx.readFile(file.path);
      if (!source) continue;

      const usages = extractNuxtUiComponentUsage(source);
      for (const usage of usages) {
        // Nuxt UI components map: UButton → button
        const themeKey = usage.name.replace(/^U/, '').toLowerCase();
        if (themeMap.has(themeKey)) {
          const symbols = ctx.getSymbolsByFile(file.id);
          const sourceSymbol = symbols[0];
          if (sourceSymbol) {
            edges.push({
              sourceNodeType: 'symbol',
              sourceRefId: sourceSymbol.id,
              edgeType: 'nuxt_ui_theme',
              resolved: true,
              metadata: {
                componentName: usage.name,
                themeKey,
                customizedKeys: themeMap.get(themeKey),
              },
            });
          }
        }
      }
    }

    return ok(edges);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function kebabToPascal(str: string): string {
  return str
    .split('-')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
}

function extractParenBody(source: string, pos: number): string {
  let depth = 1;
  let i = pos;
  while (i < source.length && depth > 0) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') depth--;
    i++;
  }
  return source.slice(pos, i - 1);
}

function extractBraceBody(source: string, pos: number): string {
  let depth = 0;
  let start = pos;
  while (start < source.length && source[start] !== '{') start++;
  if (start >= source.length) return '';
  depth = 1;
  let i = start + 1;
  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    i++;
  }
  return source.slice(start + 1, i - 1);
}
