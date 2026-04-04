/**
 * ShadcnPlugin — Detects shadcn/ui component library usage and extracts:
 * - Component registry from components.json config
 * - CVA (class-variance-authority) variant definitions
 * - Component composition patterns (compound components)
 * - Tailwind CSS utility class usage in component variants
 *
 * Supports shadcn/ui (React) and shadcn-vue.
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
} from '../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../errors.js';

// ── CVA variant extraction ────────────────────────────────────────────────

/**
 * Match: const xxxVariants = cva("base-classes", { variants: { ... } })
 * Also matches export const / export default
 */
const CVA_RE =
  /(?:export\s+(?:default\s+)?)?(?:const|let)\s+(\w+)\s*=\s*cva\s*\(/g;

/**
 * Match variant keys inside variants: { size: { ... }, variant: { ... } }
 */
const VARIANT_KEY_RE = /(\w+)\s*:\s*\{/g;

/**
 * Match variant values inside a variant group: sm: "...", md: "...", lg: "..."
 */
const VARIANT_VALUE_RE = /(\w+)\s*:\s*["'`]/g;

export interface CvaDefinition {
  name: string;
  baseClasses: string;
  variants: Record<string, string[]>;
  defaultVariants: Record<string, string>;
}

export interface ShadcnConfig {
  style?: string;
  rsc?: boolean;
  tsx?: boolean;
  tailwind?: { config?: string; css?: string; baseColor?: string; prefix?: string };
  aliases?: Record<string, string>;
  registryUrl?: string;
}

/** Extract CVA variant definitions from source code. */
export function extractCvaDefinitions(source: string): CvaDefinition[] {
  const defs: CvaDefinition[] = [];
  const re = new RegExp(CVA_RE.source, 'g');
  let match: RegExpExecArray | null;

  while ((match = re.exec(source)) !== null) {
    const name = match[1];
    const startPos = match.index + match[0].length;
    const body = extractParenBody(source, startPos);

    // Extract base classes (first argument — a string)
    const baseMatch = body.match(/^\s*["'`]([^"'`]*)["'`]/);
    const baseClasses = baseMatch?.[1] ?? '';

    // Extract variants block
    const variants: Record<string, string[]> = {};
    const variantsMatch = body.match(/variants\s*:\s*\{/);
    if (variantsMatch) {
      const variantsStart = body.indexOf('{', variantsMatch.index! + variantsMatch[0].length - 1);
      const variantsBody = extractBraceBody(body, variantsStart);

      // Find each variant group
      const vkRe = new RegExp(VARIANT_KEY_RE.source, 'g');
      let vkMatch: RegExpExecArray | null;
      while ((vkMatch = vkRe.exec(variantsBody)) !== null) {
        const variantName = vkMatch[1];
        const groupStart = variantsBody.indexOf('{', vkMatch.index + vkMatch[0].length - 1);
        const groupBody = extractBraceBody(variantsBody, groupStart);

        const values: string[] = [];
        const vvRe = new RegExp(VARIANT_VALUE_RE.source, 'g');
        let vvMatch: RegExpExecArray | null;
        while ((vvMatch = vvRe.exec(groupBody)) !== null) {
          values.push(vvMatch[1]);
        }
        if (values.length > 0) {
          variants[variantName] = values;
        }
      }
    }

    // Extract defaultVariants
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

    defs.push({ name, baseClasses, variants, defaultVariants });
  }

  return defs;
}

/**
 * Extract shadcn component names from cn() utility patterns and
 * forwardRef/React.forwardRef component definitions.
 */
export function extractShadcnComponents(
  source: string,
  filePath: string,
): { name: string; hasForwardRef: boolean; usesSlot: boolean; cvaVariants: string | null }[] {
  const components: { name: string; hasForwardRef: boolean; usesSlot: boolean; cvaVariants: string | null }[] = [];

  // Match: const Button = React.forwardRef<...>((...) => { ... })
  // Or: const Button = forwardRef<...>((...) => { ... })
  const forwardRefRe =
    /(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:React\.)?forwardRef(?:<[^>]*>)?\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = forwardRefRe.exec(source)) !== null) {
    const name = m[1];
    // Check if the component uses Slot from @radix-ui
    const bodyStart = m.index + m[0].length;
    const body = extractParenBody(source, bodyStart);
    const usesSlot = /\bSlot\b/.test(body);

    // Check if it references a cva variants const
    const cvaMatch = body.match(/(\w+Variants)\b/);
    components.push({
      name,
      hasForwardRef: true,
      usesSlot,
      cvaVariants: cvaMatch?.[1] ?? null,
    });
  }

  // Also match function component declarations: function Button(...)
  const fnRe = /(?:export\s+)?function\s+([A-Z]\w+)\s*\(/g;
  const existingNames = new Set(components.map((c) => c.name));
  while ((m = fnRe.exec(source)) !== null) {
    const name = m[1];
    if (existingNames.has(name)) continue;
    components.push({
      name,
      hasForwardRef: false,
      usesSlot: /\bSlot\b/.test(source),
      cvaVariants: null,
    });
  }

  return components;
}

// ── Plugin ────────────────────────────────────────────────────────────────

export class ShadcnPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'shadcn',
    version: '1.0.0',
    priority: 45,
    category: 'view',
    dependencies: [],
  };

  private config: ShadcnConfig | null = null;
  private uiDir: string | null = null;

  detect(ctx: ProjectContext): boolean {
    // Primary: check for components.json (shadcn/ui config file)
    if (ctx.configFiles.some((f) => f.endsWith('components.json'))) {
      try {
        const configPath = path.join(ctx.rootPath, 'components.json');
        const raw = fs.readFileSync(configPath, 'utf-8');
        this.config = JSON.parse(raw) as ShadcnConfig;
      } catch { /* ignore parse errors */ }
      return true;
    }

    // Secondary: check for @radix-ui packages + class-variance-authority (strong signal)
    const deps = {
      ...(ctx.packageJson?.dependencies as Record<string, string> | undefined),
      ...(ctx.packageJson?.devDependencies as Record<string, string> | undefined),
    };

    const hasRadix = Object.keys(deps).some((d) => d.startsWith('@radix-ui/'));
    const hasCva = 'class-variance-authority' in deps;
    const hasTailwindMerge = 'tailwind-merge' in deps;

    // shadcn-vue detection
    if ('shadcn-nuxt' in deps || 'radix-vue' in deps || '@radix-vue/radix-vue' in deps) {
      return true;
    }

    return hasRadix && (hasCva || hasTailwindMerge);
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'shadcn_component', category: 'ui-library', description: 'shadcn/ui component definition' },
        { name: 'shadcn_variant', category: 'ui-library', description: 'CVA variant definition for a shadcn component' },
        { name: 'uses_shadcn_component', category: 'ui-library', description: 'File imports/uses a shadcn/ui component' },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (!['typescript', 'javascript', 'typescriptreact', 'javascriptreact'].includes(language)) {
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

    const isShadcnUiFile = this.isShadcnComponentFile(filePath);

    // Extract CVA variant definitions
    const cvaDefinitions = extractCvaDefinitions(source);
    for (const cva of cvaDefinitions) {
      result.routes!.push({
        method: 'VARIANT',
        uri: `shadcn:variant:${cva.name}`,
        metadata: {
          baseClasses: cva.baseClasses,
          variants: cva.variants,
          defaultVariants: cva.defaultVariants,
        },
      });

      if (isShadcnUiFile) {
        result.edges!.push({
          edgeType: 'shadcn_variant',
          metadata: { variantName: cva.name, variants: Object.keys(cva.variants) },
        });
      }
    }

    // Extract component definitions in shadcn UI files
    if (isShadcnUiFile) {
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
          },
        });

        result.edges!.push({
          edgeType: 'shadcn_component',
          metadata: { componentName: comp.name },
        });
      }

      result.frameworkRole = 'shadcn_component';
    }

    // Track shadcn component imports in non-UI files
    if (!isShadcnUiFile) {
      const shadcnImports = extractShadcnImports(source);
      for (const imp of shadcnImports) {
        result.edges!.push({
          edgeType: 'uses_shadcn_component',
          metadata: { componentName: imp.name, importPath: imp.path },
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

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Check if a file lives in the shadcn/ui components directory. */
  private isShadcnComponentFile(filePath: string): boolean {
    // Common shadcn patterns: components/ui/*, @/components/ui/*
    const normalized = filePath.replace(/\\/g, '/');
    return /\/components\/ui\//.test(normalized) || /\/ui\//.test(normalized) && /\.(tsx|vue)$/.test(normalized);
  }
}

/** Extract imports that reference shadcn/ui component paths. */
function extractShadcnImports(source: string): { name: string; path: string }[] {
  const imports: { name: string; path: string }[] = [];

  // Match: import { Button } from "@/components/ui/button"
  // Or: import { Button } from "~/components/ui/button"
  // Or: import { Button } from "../ui/button"
  const importRe =
    /import\s*\{([^}]+)\}\s*from\s*["']([^"']*(?:components\/ui|@\/ui|~\/ui)[^"']*)["']/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(source)) !== null) {
    const names = m[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    const importPath = m[2];
    for (const name of names) {
      imports.push({ name, path: importPath });
    }
  }

  return imports;
}

// ── Shared helpers ────────────────────────────────────────────────────────

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
