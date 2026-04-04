/**
 * ShadcnPlugin — Comprehensive shadcn/ui and shadcn-vue detection and extraction.
 *
 * Detection:
 * - components.json config file (primary — parses full config)
 * - Dependency heuristics: @radix-ui/* + class-variance-authority + tailwind-merge
 * - shadcn-vue: radix-vue, shadcn-nuxt
 *
 * Extracts:
 * - Full components.json configuration (style, RSC, aliases, registry)
 * - Installed component registry (scans components/ui directory)
 * - CVA (class-variance-authority) variant definitions with full variant map
 * - tv() (tailwind-variants) definitions (alternative to CVA)
 * - Component props interface extraction (TypeScript interface/type)
 * - Component composition: which Radix primitives and internal components each uses
 * - Compound sub-component exports (DialogTrigger, DialogContent, etc.)
 * - cn() utility usage patterns
 * - shadcn-vue: defineProps/withDefaults extraction
 * - Cross-file resolution: links component usage → component definitions
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

export interface ShadcnConfig {
  $schema?: string;
  style?: string;                    // 'default' | 'new-york'
  rsc?: boolean;                     // React Server Components
  tsx?: boolean;
  tailwind?: {
    config?: string;
    css?: string;
    baseColor?: string;
    cssVariables?: boolean;
    prefix?: string;
  };
  aliases?: {
    components?: string;
    utils?: string;
    ui?: string;
    lib?: string;
    hooks?: string;
  };
  registryUrl?: string;              // Custom registry URL
  iconLibrary?: string;              // 'lucide' | 'radix-icons' etc.
}

export interface CvaDefinition {
  name: string;
  baseClasses: string;
  variants: Record<string, string[]>;
  defaultVariants: Record<string, string>;
  compoundVariants: number;           // count of compound variant rules
}

export interface TvDefinition {
  name: string;
  slots: string[];
  variants: Record<string, string[]>;
  defaultVariants: Record<string, string>;
}

export interface ShadcnComponentInfo {
  name: string;
  hasForwardRef: boolean;
  usesSlot: boolean;                  // @radix-ui/react-slot
  cvaVariants: string | null;
  tvVariants: string | null;
  radixImports: string[];             // Radix primitives used
  internalImports: string[];          // other shadcn components imported
  propsInterface: string | null;      // name of the props type
  propFields: string[];               // individual prop names
  subComponents: string[];            // exported sub-components (DialogTrigger, etc.)
  usesClassName: boolean;             // accepts className prop
  usesCn: boolean;                    // uses cn() utility
}

export interface InstalledComponent {
  name: string;
  fileName: string;
  relativePath: string;
}

// ── CVA extraction ────────────────────────────────────────────────────────

const CVA_RE =
  /(?:export\s+(?:default\s+)?)?(?:const|let)\s+(\w+)\s*=\s*cva\s*\(/g;

/** Extract CVA variant definitions from source code. */
export function extractCvaDefinitions(source: string): CvaDefinition[] {
  const defs: CvaDefinition[] = [];
  const re = new RegExp(CVA_RE.source, 'g');
  let match: RegExpExecArray | null;

  while ((match = re.exec(source)) !== null) {
    const name = match[1];
    const startPos = match.index + match[0].length;
    const body = extractParenBody(source, startPos);

    const baseMatch = body.match(/^\s*["'`]([^"'`]*)["'`]/);
    const baseClasses = baseMatch?.[1] ?? '';

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
        const vvRe = /(\w+)\s*:\s*["'`]/g;
        let vvMatch: RegExpExecArray | null;
        while ((vvMatch = vvRe.exec(groupBody)) !== null) {
          values.push(vvMatch[1]);
        }
        if (values.length > 0) variants[variantName] = values;
      }
    }

    // defaultVariants
    const defaultVariants: Record<string, string> = {};
    const defaultMatch = body.match(/defaultVariants\s*:\s*\{/);
    if (defaultMatch) {
      const dvStart = body.indexOf('{', defaultMatch.index! + defaultMatch[0].length - 1);
      const dvBody = extractBraceBody(body, dvStart);
      const dvRe = /(\w+)\s*:\s*["'](\w+)["']/g;
      let dvMatch: RegExpExecArray | null;
      while ((dvMatch = dvRe.exec(dvBody)) !== null) {
        defaultVariants[dvMatch[1]] = dvMatch[2];
      }
    }

    // compoundVariants count
    const compoundMatch = body.match(/compoundVariants\s*:\s*\[/);
    let compoundVariants = 0;
    if (compoundMatch) {
      const cvStart = body.indexOf('[', compoundMatch.index! + compoundMatch[0].length - 1);
      const cvBody = extractBracketBody(body, cvStart);
      compoundVariants = (cvBody.match(/\{/g) || []).length;
    }

    defs.push({ name, baseClasses, variants, defaultVariants, compoundVariants });
  }

  return defs;
}

// ── Tailwind Variants (tv) extraction ─────────────────────────────────────

const TV_RE =
  /(?:export\s+(?:default\s+)?)?(?:const|let)\s+(\w+)\s*=\s*tv\s*\(/g;

/** Extract tailwind-variants tv() definitions. */
export function extractTvDefinitions(source: string): TvDefinition[] {
  const defs: TvDefinition[] = [];
  const re = new RegExp(TV_RE.source, 'g');
  let match: RegExpExecArray | null;

  while ((match = re.exec(source)) !== null) {
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

    // defaultVariants
    const defaultVariants: Record<string, string> = {};
    const defaultMatch = body.match(/defaultVariants\s*:\s*\{/);
    if (defaultMatch) {
      const dvStart = body.indexOf('{', defaultMatch.index! + defaultMatch[0].length - 1);
      const dvBody = extractBraceBody(body, dvStart);
      const dvRe = /(\w+)\s*:\s*["'](\w+)["']/g;
      let dvMatch: RegExpExecArray | null;
      while ((dvMatch = dvRe.exec(dvBody)) !== null) {
        defaultVariants[dvMatch[1]] = dvMatch[2];
      }
    }

    defs.push({ name, slots, variants, defaultVariants });
  }

  return defs;
}

// ── Component extraction (React) ──────────────────────────────────────────

/** Extract comprehensive shadcn component info from a React/TSX file. */
export function extractShadcnComponents(source: string, filePath: string): ShadcnComponentInfo[] {
  const components: ShadcnComponentInfo[] = [];

  // Gather file-level data
  const radixImports = extractRadixImports(source);
  const internalImports = extractInternalShadcnImports(source);
  const usesCn = /\bcn\s*\(/.test(source);

  // forwardRef components
  const forwardRefRe =
    /(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:React\.)?forwardRef(?:<[^>]*>)?\s*\(/g;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();

  while ((m = forwardRefRe.exec(source)) !== null) {
    const name = m[1];
    if (seen.has(name)) continue;
    seen.add(name);

    const bodyStart = m.index + m[0].length;
    const body = extractParenBody(source, bodyStart);
    const usesSlot = /\bSlot\b/.test(body);
    const cvaMatch = body.match(/(\w+Variants)\b/);
    const tvMatch = body.match(/(\w+)\s*\(\s*\{[^}]*variant/);
    const usesClassName = /className/.test(body);
    const propFields = extractPropFieldsFromBody(body);

    components.push({
      name,
      hasForwardRef: true,
      usesSlot,
      cvaVariants: cvaMatch?.[1] ?? null,
      tvVariants: tvMatch?.[1] ?? null,
      radixImports,
      internalImports,
      propsInterface: findPropsInterface(source, name),
      propFields,
      subComponents: [],
      usesClassName,
      usesCn,
    });
  }

  // Arrow function components: const Button = ({ ... }) => (...)
  const arrowRe =
    /(?:export\s+)?(?:const|let)\s+([A-Z]\w+)\s*(?::\s*React\.FC[^=]*)?=\s*(?:\([^)]*\)|[^=])\s*=>/g;
  while ((m = arrowRe.exec(source)) !== null) {
    const name = m[1];
    if (seen.has(name)) continue;
    seen.add(name);
    components.push({
      name,
      hasForwardRef: false,
      usesSlot: false,
      cvaVariants: null,
      tvVariants: null,
      radixImports,
      internalImports,
      propsInterface: findPropsInterface(source, name),
      propFields: [],
      subComponents: [],
      usesClassName: /className/.test(source),
      usesCn,
    });
  }

  // function components
  const fnRe = /(?:export\s+)?function\s+([A-Z]\w+)\s*\(/g;
  while ((m = fnRe.exec(source)) !== null) {
    const name = m[1];
    if (seen.has(name)) continue;
    seen.add(name);
    components.push({
      name,
      hasForwardRef: false,
      usesSlot: /\bSlot\b/.test(source),
      cvaVariants: null,
      tvVariants: null,
      radixImports,
      internalImports,
      propsInterface: findPropsInterface(source, name),
      propFields: [],
      subComponents: [],
      usesClassName: /className/.test(source),
      usesCn,
    });
  }

  // Detect sub-component re-exports at file level
  const subComponents = extractSubComponentExports(source);
  if (components.length > 0 && subComponents.length > 0) {
    components[0].subComponents = subComponents;
  }

  return components;
}

// ── Component extraction (Vue — shadcn-vue) ───────────────────────────────

export interface ShadcnVueComponentInfo {
  name: string;
  props: string[];
  emits: string[];
  slots: string[];
  radixVueImports: string[];
  usesCn: boolean;
  tvVariants: string | null;
  cvaVariants: string | null;
}

/** Extract shadcn-vue component info from a .vue SFC. */
export function extractShadcnVueComponent(source: string, filePath: string): ShadcnVueComponentInfo | null {
  const fileName = path.basename(filePath, path.extname(filePath));
  const name = toPascalCase(fileName);

  // Check if this is a shadcn-vue component
  const hasRadixVue = /from\s+['"]radix-vue['"]/.test(source) || /from\s+['"]reka-ui['"]/.test(source);
  const hasCn = /\bcn\s*\(/.test(source);
  if (!hasRadixVue && !hasCn) return null;

  // Extract props from defineProps
  const props: string[] = [];
  const propsMatch = source.match(/defineProps<\{([^}]*)\}>/);
  if (propsMatch) {
    const propsBody = propsMatch[1];
    const propRe = /(\w+)\s*[?:]?\s*:/g;
    let pm: RegExpExecArray | null;
    while ((pm = propRe.exec(propsBody)) !== null) props.push(pm[1]);
  }
  // Also match withDefaults(defineProps<...>(), { ... })
  const defaultsMatch = source.match(/withDefaults\s*\(\s*defineProps<\{([^}]*)\}>/);
  if (defaultsMatch) {
    const propsBody = defaultsMatch[1];
    const propRe = /(\w+)\s*[?:]?\s*:/g;
    let pm: RegExpExecArray | null;
    while ((pm = propRe.exec(propsBody)) !== null) {
      if (!props.includes(pm[1])) props.push(pm[1]);
    }
  }

  // Extract emits
  const emits: string[] = [];
  const emitsMatch = source.match(/defineEmits<\{([^}]*)\}>/);
  if (emitsMatch) {
    const emitsBody = emitsMatch[1];
    const emitRe = /\(\s*e\s*:\s*['"](\w+)['"]/g;
    let em: RegExpExecArray | null;
    while ((em = emitRe.exec(emitsBody)) !== null) emits.push(em[1]);
  }

  // Extract slots
  const slots: string[] = [];
  const slotRe = /<slot\s+name=["'](\w+)["']/g;
  let sm: RegExpExecArray | null;
  while ((sm = slotRe.exec(source)) !== null) slots.push(sm[1]);

  // Radix Vue / Reka UI imports
  const radixVueImports: string[] = [];
  const rvRe = /import\s*\{([^}]+)\}\s*from\s*["'](?:radix-vue|reka-ui)["']/g;
  let rvm: RegExpExecArray | null;
  while ((rvm = rvRe.exec(source)) !== null) {
    const names = rvm[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    radixVueImports.push(...names);
  }

  // TV / CVA
  const tvMatch = source.match(/(?:const|let)\s+(\w+)\s*=\s*tv\s*\(/);
  const cvaMatch = source.match(/(?:const|let)\s+(\w+)\s*=\s*cva\s*\(/);

  return {
    name,
    props,
    emits,
    slots,
    radixVueImports,
    usesCn: hasCn,
    tvVariants: tvMatch?.[1] ?? null,
    cvaVariants: cvaMatch?.[1] ?? null,
  };
}

// ── Import extraction helpers ─────────────────────────────────────────────

/** Extract @radix-ui/* imports with their component names. */
function extractRadixImports(source: string): string[] {
  const imports: string[] = [];

  // import * as DialogPrimitive from '@radix-ui/react-dialog'
  const starRe = /import\s*\*\s*as\s+(\w+)\s+from\s*["']@radix-ui\/react-[\w-]+["']/g;
  let m: RegExpExecArray | null;
  while ((m = starRe.exec(source)) !== null) imports.push(m[1]);

  // import { Root, Trigger } from '@radix-ui/react-dialog'
  const namedRe = /import\s*\{([^}]+)\}\s*from\s*["']@radix-ui\/react-([\w-]+)["']/g;
  while ((m = namedRe.exec(source)) !== null) {
    const pkg = m[2];
    const names = m[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    for (const name of names) imports.push(`${pkg}/${name}`);
  }

  return imports;
}

/** Extract imports from other shadcn components (e.g., import { Button } from './button'). */
function extractInternalShadcnImports(source: string): string[] {
  const imports: string[] = [];
  const re = /import\s*\{([^}]+)\}\s*from\s*["']\.\/(\w+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const names = m[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    imports.push(...names);
  }
  return imports;
}

/** Extract sub-component exports (e.g., DialogTrigger, DialogContent). */
function extractSubComponentExports(source: string): string[] {
  const subs: string[] = [];

  // Pattern 1: const DialogTrigger = DialogPrimitive.Trigger
  const aliasRe = /(?:const|let)\s+([A-Z]\w+)\s*=\s*\w+\.\w+/g;
  let m: RegExpExecArray | null;
  while ((m = aliasRe.exec(source)) !== null) subs.push(m[1]);

  // Pattern 2: export { DialogTrigger, DialogContent }
  const exportRe = /export\s*\{([^}]+)\}/g;
  while ((m = exportRe.exec(source)) !== null) {
    const names = m[1].split(',').map((n) => n.trim().split(/\s+as\s+/).pop()!.trim()).filter(Boolean);
    for (const name of names) {
      if (/^[A-Z]/.test(name) && !subs.includes(name)) subs.push(name);
    }
  }

  return subs;
}

/** Find the props interface name for a component. */
function findPropsInterface(source: string, componentName: string): string | null {
  // Pattern: interface ButtonProps extends ...
  const ifaceRe = new RegExp(`(?:interface|type)\\s+(${componentName}Props\\w*)`, 'g');
  const m = ifaceRe.exec(source);
  if (m) return m[1];

  // Generic pattern: Props type near the component
  const genericRe = /(?:interface|type)\s+(\w+Props)\s/g;
  const gm = genericRe.exec(source);
  return gm?.[1] ?? null;
}

/** Extract prop field names from destructured function params. */
function extractPropFieldsFromBody(body: string): string[] {
  const fields: string[] = [];
  // Match destructured props: ({ className, variant, size, ...props })
  const destructRe = /\(\s*\{([^}]+)\}/;
  const dm = destructRe.exec(body);
  if (dm) {
    const items = dm[1].split(',').map((s) => s.trim());
    for (const item of items) {
      const name = item.replace(/^\.\.\./, '').split(/\s*[=:]/)[0].trim();
      if (name && /^\w+$/.test(name)) fields.push(name);
    }
  }
  return fields;
}

/** Extract imports from shadcn/ui component paths. */
export function extractShadcnImports(source: string): { name: string; path: string; isDefault: boolean }[] {
  const imports: { name: string; path: string; isDefault: boolean }[] = [];

  // Named: import { Button } from "@/components/ui/button"
  const namedRe =
    /import\s*\{([^}]+)\}\s*from\s*["']([^"']*(?:components\/ui|@\/ui|~\/ui|\.\.\/ui)[^"']*)["']/g;
  let m: RegExpExecArray | null;
  while ((m = namedRe.exec(source)) !== null) {
    const names = m[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    for (const name of names) {
      imports.push({ name, path: m[2], isDefault: false });
    }
  }

  // Default: import Button from "@/components/ui/button"
  const defaultRe =
    /import\s+(\w+)\s+from\s*["']([^"']*(?:components\/ui|@\/ui|~\/ui)[^"']*)["']/g;
  while ((m = defaultRe.exec(source)) !== null) {
    imports.push({ name: m[1], path: m[2], isDefault: true });
  }

  return imports;
}

// ── Installed component scanning ──────────────────────────────────────────

/** Scan the UI components directory to list installed shadcn components. */
function scanInstalledComponents(rootPath: string, config: ShadcnConfig | null): InstalledComponent[] {
  const components: InstalledComponent[] = [];

  // Determine the UI directory from config or defaults
  const possibleDirs = [
    config?.aliases?.ui ? resolveAlias(config.aliases.ui, rootPath) : null,
    'src/components/ui',
    'components/ui',
    'app/components/ui',
  ].filter(Boolean) as string[];

  for (const relDir of possibleDirs) {
    const absDir = path.resolve(rootPath, relDir);
    try {
      const entries = fs.readdirSync(absDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && /\.(tsx|vue|ts|jsx)$/.test(entry.name)) {
          const baseName = entry.name.replace(/\.(tsx|vue|ts|jsx)$/, '');
          components.push({
            name: toPascalCase(baseName),
            fileName: entry.name,
            relativePath: path.join(relDir, entry.name),
          });
        } else if (entry.isDirectory()) {
          // Subdirectory-style component (e.g., dialog/index.tsx)
          try {
            const subEntries = fs.readdirSync(path.join(absDir, entry.name));
            const indexFile = subEntries.find((f) => /^index\.(tsx|vue|ts|jsx)$/.test(f));
            if (indexFile) {
              components.push({
                name: toPascalCase(entry.name),
                fileName: indexFile,
                relativePath: path.join(relDir, entry.name, indexFile),
              });
            }
            // Also count individual files in subdirectory
            for (const sub of subEntries) {
              if (/\.(tsx|vue|ts|jsx)$/.test(sub) && !sub.startsWith('index.')) {
                const baseName = sub.replace(/\.(tsx|vue|ts|jsx)$/, '');
                components.push({
                  name: toPascalCase(baseName),
                  fileName: sub,
                  relativePath: path.join(relDir, entry.name, sub),
                });
              }
            }
          } catch { /* ignore */ }
        }
      }
      if (components.length > 0) break; // found the UI directory
    } catch { /* directory doesn't exist, try next */ }
  }

  return components;
}

/** Resolve a tsconfig-style alias like @/components/ui → src/components/ui */
function resolveAlias(alias: string, _rootPath: string): string {
  return alias.replace(/^@\//, 'src/').replace(/^~\//, '');
}

// ── Plugin ────────────────────────────────────────────────────────────────

export class ShadcnPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'shadcn',
    version: '2.0.0',
    priority: 45,
    category: 'view',
    dependencies: [],
  };

  private config: ShadcnConfig | null = null;
  private isVue = false;
  private installedComponents: InstalledComponent[] = [];
  private installedComponentPaths = new Set<string>();
  private rootPath = '';

  detect(ctx: ProjectContext): boolean {
    this.rootPath = ctx.rootPath;

    // Primary: components.json
    try {
      const configPath = path.join(ctx.rootPath, 'components.json');
      const raw = fs.readFileSync(configPath, 'utf-8');
      this.config = JSON.parse(raw) as ShadcnConfig;
      this.scanComponents(ctx);
      return true;
    } catch { /* not found or parse error */ }

    const deps = {
      ...(ctx.packageJson?.dependencies as Record<string, string> | undefined),
      ...(ctx.packageJson?.devDependencies as Record<string, string> | undefined),
    };

    // shadcn-vue / reka-vue
    if ('shadcn-nuxt' in deps || 'radix-vue' in deps || 'reka-ui' in deps) {
      this.isVue = true;
      this.scanComponents(ctx);
      return true;
    }

    // Heuristic: @radix-ui + cva/tailwind-merge
    const hasRadix = Object.keys(deps).some((d) => d.startsWith('@radix-ui/'));
    const hasCva = 'class-variance-authority' in deps;
    const hasTv = 'tailwind-variants' in deps;
    const hasTailwindMerge = 'tailwind-merge' in deps;

    if (hasRadix && (hasCva || hasTv || hasTailwindMerge)) {
      this.scanComponents(ctx);
      return true;
    }

    return false;
  }

  private scanComponents(ctx: ProjectContext): void {
    this.installedComponents = scanInstalledComponents(ctx.rootPath, this.config);
    this.installedComponentPaths = new Set(
      this.installedComponents.map((c) => c.relativePath.replace(/\\/g, '/')),
    );

    // Detect Vue mode from config or file extensions
    if (!this.isVue) {
      this.isVue = this.config?.tsx === false ||
        this.installedComponents.some((c) => c.fileName.endsWith('.vue'));
    }
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'shadcn_component', category: 'ui-library', description: 'shadcn/ui component definition' },
        { name: 'shadcn_variant', category: 'ui-library', description: 'CVA/TV variant definition' },
        { name: 'shadcn_sub_component', category: 'ui-library', description: 'Compound sub-component export' },
        { name: 'shadcn_uses_radix', category: 'ui-library', description: 'Component wraps Radix primitive' },
        { name: 'shadcn_internal_dep', category: 'ui-library', description: 'Component imports another shadcn component' },
        { name: 'uses_shadcn_component', category: 'ui-library', description: 'File imports/uses a shadcn/ui component' },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (!['typescript', 'javascript', 'typescriptreact', 'javascriptreact', 'vue'].includes(language)) {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const result: FileParseResult = {
      status: 'ok',
      symbols: [],
      routes: [],
      edges: [],
      components: [],
    };

    const isShadcnFile = this.isShadcnComponentFile(filePath);

    // ── shadcn component file ──
    if (isShadcnFile) {
      if (language === 'vue') {
        this.extractVueComponent(source, filePath, result);
      } else {
        this.extractReactComponent(source, filePath, result);
      }

      // CVA definitions (both React and Vue)
      const cvaDefinitions = extractCvaDefinitions(source);
      for (const cva of cvaDefinitions) {
        result.routes!.push({
          method: 'VARIANT',
          uri: `shadcn:variant:${cva.name}`,
          metadata: {
            baseClasses: cva.baseClasses,
            variants: cva.variants,
            defaultVariants: cva.defaultVariants,
            compoundVariants: cva.compoundVariants,
          },
        });
        result.edges!.push({
          edgeType: 'shadcn_variant',
          metadata: {
            variantName: cva.name,
            type: 'cva',
            variants: Object.keys(cva.variants),
            variantValues: cva.variants,
          },
        });
      }

      // TV definitions
      const tvDefinitions = extractTvDefinitions(source);
      for (const tv of tvDefinitions) {
        result.routes!.push({
          method: 'VARIANT',
          uri: `shadcn:variant:${tv.name}`,
          metadata: {
            type: 'tv',
            slots: tv.slots,
            variants: tv.variants,
            defaultVariants: tv.defaultVariants,
          },
        });
        result.edges!.push({
          edgeType: 'shadcn_variant',
          metadata: {
            variantName: tv.name,
            type: 'tv',
            slots: tv.slots,
            variants: Object.keys(tv.variants),
          },
        });
      }

      result.frameworkRole = 'shadcn_component';
      return ok(result);
    }

    // ── Consumer file — track imports ──
    const shadcnImports = extractShadcnImports(source);
    for (const imp of shadcnImports) {
      result.edges!.push({
        edgeType: 'uses_shadcn_component',
        metadata: {
          componentName: imp.name,
          importPath: imp.path,
          isDefault: imp.isDefault,
        },
      });
    }

    // Also detect cva/tv usage outside shadcn dir (custom components)
    if (/\bcva\s*\(/.test(source)) {
      const cvaDefinitions = extractCvaDefinitions(source);
      for (const cva of cvaDefinitions) {
        result.routes!.push({
          method: 'VARIANT',
          uri: `cva:${cva.name}`,
          metadata: {
            baseClasses: cva.baseClasses,
            variants: cva.variants,
            defaultVariants: cva.defaultVariants,
          },
        });
      }
    }

    if (
      result.routes!.length === 0 &&
      result.edges!.length === 0 &&
      result.components!.length === 0
    ) {
      return ok({ status: 'ok', symbols: [] });
    }

    return ok(result);
  }

  // ── React component extraction ──────────────────────────────────────────

  private extractReactComponent(source: string, filePath: string, result: FileParseResult): void {
    const components = extractShadcnComponents(source, filePath);

    for (const comp of components) {
      result.components!.push({
        name: comp.name,
        kind: 'component',
        framework: 'shadcn',
        props: {
          hasForwardRef: comp.hasForwardRef,
          usesSlot: comp.usesSlot,
          cvaVariants: comp.cvaVariants,
          tvVariants: comp.tvVariants,
          propsInterface: comp.propsInterface,
          propFields: comp.propFields,
          usesClassName: comp.usesClassName,
          usesCn: comp.usesCn,
        },
      });

      result.routes!.push({
        method: 'COMPONENT',
        uri: `shadcn:${comp.name}`,
        handler: comp.name,
        metadata: {
          hasForwardRef: comp.hasForwardRef,
          usesSlot: comp.usesSlot,
          cvaVariants: comp.cvaVariants,
          tvVariants: comp.tvVariants,
          radixPrimitives: comp.radixImports,
          internalDeps: comp.internalImports,
          propsInterface: comp.propsInterface,
          propFields: comp.propFields,
          subComponents: comp.subComponents,
        },
      });

      result.edges!.push({
        edgeType: 'shadcn_component',
        metadata: { componentName: comp.name },
      });

      // Radix dependency edges
      for (const radixPrimitive of comp.radixImports) {
        result.edges!.push({
          edgeType: 'shadcn_uses_radix',
          metadata: { component: comp.name, radixPrimitive },
        });
      }

      // Internal component dependency edges
      for (const dep of comp.internalImports) {
        result.edges!.push({
          edgeType: 'shadcn_internal_dep',
          metadata: { component: comp.name, dependency: dep },
        });
      }

      // Sub-component edges
      for (const sub of comp.subComponents) {
        result.edges!.push({
          edgeType: 'shadcn_sub_component',
          metadata: { parent: comp.name, subComponent: sub },
        });
      }
    }
  }

  // ── Vue component extraction ────────────────────────────────────────────

  private extractVueComponent(source: string, filePath: string, result: FileParseResult): void {
    const comp = extractShadcnVueComponent(source, filePath);
    if (!comp) return;

    result.components!.push({
      name: comp.name,
      kind: 'component',
      framework: 'shadcn-vue',
      props: Object.fromEntries(comp.props.map((p) => [p, true])),
      emits: comp.emits,
      slots: comp.slots,
    });

    result.routes!.push({
      method: 'COMPONENT',
      uri: `shadcn-vue:${comp.name}`,
      handler: comp.name,
      metadata: {
        props: comp.props,
        emits: comp.emits,
        slots: comp.slots,
        radixVueImports: comp.radixVueImports,
        usesCn: comp.usesCn,
        tvVariants: comp.tvVariants,
        cvaVariants: comp.cvaVariants,
      },
    });

    result.edges!.push({
      edgeType: 'shadcn_component',
      metadata: { componentName: comp.name, framework: 'vue' },
    });

    for (const rvImport of comp.radixVueImports) {
      result.edges!.push({
        edgeType: 'shadcn_uses_radix',
        metadata: { component: comp.name, radixPrimitive: rvImport, library: 'radix-vue' },
      });
    }
  }

  // ── Cross-file resolution (Pass 2) ─────────────────────────────────────

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];
    const allFiles = ctx.getAllFiles();

    // Build map: component name → symbol ID
    const componentSymbolMap = new Map<string, { id: number; symbolId: string }>();
    for (const comp of this.installedComponents) {
      const normalizedPath = comp.relativePath.replace(/\\/g, '/');
      const file = allFiles.find((f) => f.path.replace(/\\/g, '/') === normalizedPath);
      if (!file) continue;
      const symbols = ctx.getSymbolsByFile(file.id);
      for (const sym of symbols) {
        if (sym.kind === 'class' || sym.kind === 'function' || sym.kind === 'variable') {
          componentSymbolMap.set(sym.name, { id: sym.id, symbolId: sym.symbolId });
        }
      }
    }

    // Link consumer imports to component definitions
    const consumerFiles = allFiles.filter((f) => !this.installedComponentPaths.has(f.path.replace(/\\/g, '/')));
    for (const file of consumerFiles) {
      const source = ctx.readFile(file.path);
      if (!source) continue;

      const imports = extractShadcnImports(source);
      if (imports.length === 0) continue;

      const symbols = ctx.getSymbolsByFile(file.id);
      const sourceSymbol = symbols[0]; // primary symbol in file
      if (!sourceSymbol) continue;

      for (const imp of imports) {
        const target = componentSymbolMap.get(imp.name);
        if (target) {
          edges.push({
            sourceNodeType: 'symbol',
            sourceRefId: sourceSymbol.id,
            targetNodeType: 'symbol',
            targetRefId: target.id,
            edgeType: 'uses_shadcn_component',
            resolved: true,
            metadata: { componentName: imp.name, importPath: imp.path },
          });
        }
      }
    }

    return ok(edges);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private isShadcnComponentFile(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');

    // Check against installed component paths
    if (this.installedComponentPaths.has(normalized)) return true;

    // Fallback patterns
    if (/\/components\/ui\//.test(normalized)) return true;
    if (/\/ui\//.test(normalized) && /\.(tsx|vue|jsx)$/.test(normalized)) return true;

    return false;
  }
}

// ── Utility helpers ───────────────────────────────────────────────────────

function toPascalCase(str: string): string {
  return str
    .split(/[-_]/)
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

function extractBracketBody(source: string, pos: number): string {
  let depth = 0;
  let start = pos;
  while (start < source.length && source[start] !== '[') start++;
  if (start >= source.length) return '';
  depth = 1;
  let i = start + 1;
  while (i < source.length && depth > 0) {
    if (source[i] === '[') depth++;
    else if (source[i] === ']') depth--;
    i++;
  }
  return source.slice(start + 1, i - 1);
}
