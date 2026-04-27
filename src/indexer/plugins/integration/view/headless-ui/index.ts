/**
 * HeadlessUiPlugin — Detects Headless UI and Radix UI primitive usage:
 * - Headless UI (Tailwind Labs): @headlessui/react, @headlessui/vue
 * - Radix UI primitives: @radix-ui/react-* (standalone, not via shadcn)
 * - Ark UI (Chakra's headless primitives): @ark-ui/react, @ark-ui/vue
 *
 * Extracts:
 * - Compound component patterns (Menu.Button, Dialog.Panel, etc.)
 * - Render prop / slot patterns
 * - Controlled state bindings (open, onOpenChange, etc.)
 * - Accessibility attributes used with primitives
 */
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

// ── Extraction helpers ────────────────────────────────────────────────────

/** Known Headless UI compound component roots. */
const HEADLESS_UI_ROOTS = new Set([
  'Combobox',
  'Dialog',
  'Disclosure',
  'Listbox',
  'Menu',
  'Popover',
  'RadioGroup',
  'Switch',
  'Tab',
  'Transition',
  'CloseButton',
  'Field',
  'Fieldset',
  'Input',
  'Label',
  'Legend',
  'Select',
  'Textarea',
  'Description',
  'Button',
]);

/** Known Radix UI primitive roots. */
const RADIX_ROOTS = new Set([
  'Accordion',
  'AlertDialog',
  'AspectRatio',
  'Avatar',
  'Checkbox',
  'Collapsible',
  'ContextMenu',
  'Dialog',
  'DropdownMenu',
  'Form',
  'HoverCard',
  'Label',
  'Menubar',
  'NavigationMenu',
  'Popover',
  'Progress',
  'RadioGroup',
  'ScrollArea',
  'Select',
  'Separator',
  'Slider',
  'Switch',
  'Tabs',
  'Toast',
  'Toggle',
  'ToggleGroup',
  'Tooltip',
  'VisuallyHidden',
]);

interface CompoundComponentUsage {
  root: string; // e.g. 'Dialog'
  parts: string[]; // e.g. ['Trigger', 'Content', 'Close']
  library: 'headless-ui' | 'radix' | 'ark-ui';
}

interface HeadlessImport {
  name: string;
  package: string;
  library: 'headless-ui' | 'radix' | 'ark-ui';
}

/** Extract imports from headless UI libraries. */
function extractHeadlessImports(source: string): HeadlessImport[] {
  const imports: HeadlessImport[] = [];

  // Headless UI: import { Dialog, Menu } from '@headlessui/react'
  const headlessRe = /import\s*\{([^}]+)\}\s*from\s*["'](@headlessui\/(?:react|vue))["']/g;
  let m: RegExpExecArray | null;
  while ((m = headlessRe.exec(source)) !== null) {
    const names = m[1]
      .split(',')
      .map((n) =>
        n
          .trim()
          .split(/\s+as\s+/)[0]
          .trim(),
      )
      .filter(Boolean);
    for (const name of names) {
      imports.push({ name, package: m[2], library: 'headless-ui' });
    }
  }

  // Radix UI: import * as Dialog from '@radix-ui/react-dialog'
  const radixStarRe = /import\s*\*\s*as\s+(\w+)\s+from\s*["'](@radix-ui\/react-[\w-]+)["']/g;
  while ((m = radixStarRe.exec(source)) !== null) {
    imports.push({ name: m[1], package: m[2], library: 'radix' });
  }

  // Radix UI named: import { Root, Trigger, Content } from '@radix-ui/react-dialog'
  const radixNamedRe = /import\s*\{([^}]+)\}\s*from\s*["'](@radix-ui\/react-[\w-]+)["']/g;
  while ((m = radixNamedRe.exec(source)) !== null) {
    const names = m[1]
      .split(',')
      .map((n) =>
        n
          .trim()
          .split(/\s+as\s+/)[0]
          .trim(),
      )
      .filter(Boolean);
    for (const name of names) {
      imports.push({ name, package: m[2], library: 'radix' });
    }
  }

  // Ark UI: import { Dialog } from '@ark-ui/react'
  const arkRe = /import\s*\{([^}]+)\}\s*from\s*["'](@ark-ui\/(?:react|vue|solid))["']/g;
  while ((m = arkRe.exec(source)) !== null) {
    const names = m[1]
      .split(',')
      .map((n) =>
        n
          .trim()
          .split(/\s+as\s+/)[0]
          .trim(),
      )
      .filter(Boolean);
    for (const name of names) {
      imports.push({ name, package: m[2], library: 'ark-ui' });
    }
  }

  return imports;
}

/** Detect compound component usage patterns (Root.Trigger, Dialog.Panel, etc.) */
function extractCompoundComponents(
  source: string,
  imports: HeadlessImport[],
): CompoundComponentUsage[] {
  const usages: CompoundComponentUsage[] = [];
  const importedNames = new Map(imports.map((i) => [i.name, i.library]));

  for (const [name, library] of importedNames) {
    // Find compound patterns: Name.Part in JSX
    const compoundRe = new RegExp(`<${name}\\.(\\w+)`, 'g');
    const parts = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = compoundRe.exec(source)) !== null) {
      parts.add(m[1]);
    }

    // Also check root usage
    const rootUsed = new RegExp(`<${name}[\\s/>]`).test(source);

    if (parts.size > 0 || rootUsed) {
      usages.push({
        root: name,
        parts: [...parts],
        library,
      });
    }
  }

  return usages;
}

/** Detect controlled state patterns (open, onOpenChange, etc.) */
function extractControlledState(source: string): string[] {
  const patterns: string[] = [];
  const stateProps = [
    'open',
    'onOpenChange',
    'onClose',
    'value',
    'onChange',
    'onValueChange',
    'checked',
    'onCheckedChange',
    'selected',
    'onSelect',
    'defaultOpen',
    'defaultValue',
    'defaultChecked',
    'asChild',
    'forceMount',
  ];

  for (const prop of stateProps) {
    const re = new RegExp(`\\b${prop}\\s*=`, 'g');
    if (re.test(source)) {
      patterns.push(prop);
    }
  }

  return patterns;
}

// ── Plugin ────────────────────────────────────────────────────────────────

export class HeadlessUiPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'headless-ui',
    version: '1.0.0',
    priority: 44,
    category: 'view',
    dependencies: [],
  };

  private detectedLibraries: Set<'headless-ui' | 'radix' | 'ark-ui'> = new Set();

  detect(ctx: ProjectContext): boolean {
    const deps = {
      ...(ctx.packageJson?.dependencies as Record<string, string> | undefined),
      ...(ctx.packageJson?.devDependencies as Record<string, string> | undefined),
    };

    if ('@headlessui/react' in deps || '@headlessui/vue' in deps) {
      this.detectedLibraries.add('headless-ui');
    }

    // Only detect Radix if NOT shadcn (shadcn plugin handles its own Radix usage)
    const hasShadcn = ctx.configFiles.some((f) => f.endsWith('components.json'));
    if (!hasShadcn) {
      const hasRadix = Object.keys(deps).some((d) => d.startsWith('@radix-ui/react-'));
      if (hasRadix) {
        this.detectedLibraries.add('radix');
      }
    }

    if ('@ark-ui/react' in deps || '@ark-ui/vue' in deps || '@ark-ui/solid' in deps) {
      this.detectedLibraries.add('ark-ui');
    }

    return this.detectedLibraries.size > 0;
  }

  registerSchema() {
    return {
      edgeTypes: [
        {
          name: 'headless_compound_component',
          category: 'ui-library',
          description: 'Compound component usage (Root + Parts)',
        },
        {
          name: 'uses_headless_primitive',
          category: 'ui-library',
          description: 'Imports headless UI primitive',
        },
        {
          name: 'headless_controlled_state',
          category: 'ui-library',
          description: 'Controlled state binding on headless primitive',
        },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (
      !['typescript', 'javascript', 'typescriptreact', 'javascriptreact', 'vue'].includes(language)
    ) {
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

    // Extract imports
    const imports = extractHeadlessImports(source);
    if (imports.length === 0) {
      return ok({ status: 'ok', symbols: [] });
    }

    for (const imp of imports) {
      result.edges!.push({
        edgeType: 'uses_headless_primitive',
        metadata: { name: imp.name, package: imp.package, library: imp.library },
      });
    }

    // Extract compound component patterns
    const compounds = extractCompoundComponents(source, imports);
    for (const comp of compounds) {
      result.routes!.push({
        method: 'COMPONENT',
        uri: `${comp.library}:${comp.root}`,
        handler: comp.root,
        metadata: { parts: comp.parts, library: comp.library },
      });

      result.components!.push({
        name: comp.root,
        kind: 'component',
        framework: comp.library,
        props: { parts: comp.parts },
      });

      result.edges!.push({
        edgeType: 'headless_compound_component',
        metadata: {
          root: comp.root,
          parts: comp.parts,
          library: comp.library,
        },
      });
    }

    // Extract controlled state patterns
    const controlledProps = extractControlledState(source);
    if (controlledProps.length > 0) {
      result.edges!.push({
        edgeType: 'headless_controlled_state',
        metadata: { props: controlledProps },
      });
    }

    result.frameworkRole = 'headless_ui_component';

    return ok(result);
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}
