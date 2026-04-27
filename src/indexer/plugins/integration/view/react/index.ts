/**
 * ReactPlugin — Standalone React (16-19) framework plugin.
 *
 * Detects React projects that are NOT Next.js or React Native (those have
 * dedicated plugins) and extracts:
 * - JSX child component rendering (react_renders)
 * - Context creation and Context.Provider usage (react_context_provides)
 * - useContext() / use() consumption (react_context_consumes)
 * - React.lazy() dynamic imports (react_lazy_loads)
 * - Custom hook usage (react_custom_hook_uses)
 * - 'use client' / 'use server' directives — React 19 (react_use_client / react_use_server)
 *
 * Uses tree-sitter-typescript for AST-based extraction of JSX/TSX.
 */
import { err, ok } from 'neverthrow';
import type { TraceMcpResult } from '../../../../../errors.js';
import { parseError } from '../../../../../errors.js';
import { getParser, type TSNode } from '../../../../../parser/tree-sitter.js';
import type {
  FileParseResult,
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  RawComponent,
  RawEdge,
  ResolveContext,
} from '../../../../../plugin-api/types.js';

// ============================================================
// Built-in hooks — we skip these when detecting custom hook usage
// ============================================================

const BUILTIN_HOOKS = new Set([
  'useState',
  'useEffect',
  'useRef',
  'useMemo',
  'useCallback',
  'useReducer',
  'useContext',
  'useLayoutEffect',
  'useImperativeHandle',
  'useDebugValue',
  'useId',
  'useTransition',
  'useDeferredValue',
  'useSyncExternalStore',
  'useInsertionEffect',
  'useOptimistic',
  'useFormStatus',
  'useActionState',
]);

// ============================================================
// AST helpers
// ============================================================

/** Walk all descendants depth-first. */
function* walk(node: TSNode): Generator<TSNode> {
  yield node;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) yield* walk(child);
  }
}

/** Get the text of a call_expression's function node (handles `foo`, `Mod.foo`, `React.lazy`). */
function callName(node: TSNode): string {
  const fn = node.childForFieldName('function');
  return fn?.text ?? '';
}

/** Get the first argument node of a call_expression. */
function firstArg(node: TSNode): TSNode | null {
  const args = node.childForFieldName('arguments');
  if (!args) return null;
  for (let i = 0; i < args.namedChildCount; i++) {
    const child = args.namedChild(i);
    if (child?.isNamed) return child;
  }
  return null;
}

/** Get the tag name of a JSX element (opening tag or self-closing). */
function jsxTagName(node: TSNode): string | null {
  if (node.type === 'jsx_self_closing_element') {
    const nameNode = node.childForFieldName('name');
    return nameNode?.text ?? null;
  }
  if (node.type === 'jsx_element') {
    const openTag = node.childForFieldName('open_tag');
    if (openTag) {
      const nameNode = openTag.childForFieldName('name');
      return nameNode?.text ?? null;
    }
  }
  return null;
}

/** Determine if a JSX tag name is a PascalCase component (not an HTML built-in). */
function isPascalCase(name: string): boolean {
  // Handle dotted names like `ThemeContext.Provider` — first segment must be uppercase
  const first = name.split('.')[0];
  return /^[A-Z]/.test(first);
}

// ============================================================
// Plugin
// ============================================================

export class ReactPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'react',
    version: '1.0.0',
    priority: 20,
    category: 'view',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    const deps = {
      ...(ctx.packageJson?.dependencies as Record<string, string> | undefined),
      ...(ctx.packageJson?.devDependencies as Record<string, string> | undefined),
    };
    // React standalone: has react, but NOT next or react-native (those have their own plugins)
    return 'react' in deps && !('next' in deps) && !('react-native' in deps);
  }

  registerSchema() {
    return {
      edgeTypes: [
        {
          name: 'react_renders',
          category: 'react',
          description: 'Parent component renders child via JSX',
        },
        {
          name: 'react_context_provides',
          category: 'react',
          description: 'Context.Provider usage',
        },
        {
          name: 'react_context_consumes',
          category: 'react',
          description: 'useContext() or use() call',
        },
        {
          name: 'react_lazy_loads',
          category: 'react',
          description: 'React.lazy(() => import("./X"))',
        },
        {
          name: 'react_custom_hook_uses',
          category: 'react',
          description: 'Component calls a custom hook',
        },
        {
          name: 'react_use_client',
          category: 'react',
          description: "'use client' directive (React 19)",
        },
        {
          name: 'react_use_server',
          category: 'react',
          description: "'use server' directive (React 19)",
        },
      ],
    };
  }

  async extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): Promise<TraceMcpResult<FileParseResult>> {
    if (!['typescript', 'typescriptreact', 'javascript', 'javascriptreact'].includes(language)) {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    if (!source.trim()) {
      return ok({ status: 'ok', symbols: [] });
    }

    const result: FileParseResult = {
      status: 'ok',
      symbols: [],
      edges: [],
      components: [],
    };

    // 1. 'use client' / 'use server' directives (regex — first string statement)
    this.extractDirectives(source, result);

    // 2-7. AST-based extraction
    try {
      const useTsx = /\.(tsx|jsx)$/.test(filePath);
      const parser = await getParser(useTsx ? 'tsx' : 'typescript');
      const tree = parser.parse(source);
      const root: TSNode = tree.rootNode;

      for (const node of walk(root)) {
        switch (node.type) {
          case 'call_expression':
            this.visitCallExpression(node, result);
            break;
          case 'jsx_self_closing_element':
          case 'jsx_element':
            this.visitJsxElement(node, result);
            break;
        }
      }
    } catch (e) {
      return err(parseError(filePath, `tree-sitter parse failed: ${e}`));
    }

    return ok(result);
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    // Cross-file resolution (e.g., linking context providers to consumers by
    // matching context names) could be added here in the future.
    return ok([]);
  }

  // ============================================================
  // Private extraction methods
  // ============================================================

  /** 1. 'use client' / 'use server' directives */
  private extractDirectives(source: string, result: FileParseResult): void {
    // Match the first string literal statement at file start (after comments/whitespace)
    const match = source.match(/^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*['"]use (client|server)['"]/);
    if (match) {
      const directive = match[1] as 'client' | 'server';
      if (directive === 'client') {
        result.frameworkRole = 'client-component';
        result.edges!.push({
          edgeType: 'react_use_client',
          metadata: { directive: 'use client' },
        });
      } else {
        result.frameworkRole = 'server-action';
        result.edges!.push({
          edgeType: 'react_use_server',
          metadata: { directive: 'use server' },
        });
      }
    }
  }

  /** Visit call_expression nodes for context creation, useContext, React.lazy, custom hooks. */
  private visitCallExpression(node: TSNode, result: FileParseResult): void {
    const name = callName(node);

    // 2. Context creation: createContext() or React.createContext()
    if (name === 'createContext' || name === 'React.createContext') {
      // Try to get the variable name: const ThemeContext = createContext(...)
      const parent = node.parent;
      let contextName = 'UnnamedContext';
      if (parent?.type === 'variable_declarator') {
        const nameNode = parent.childForFieldName('name');
        if (nameNode) contextName = nameNode.text;
      }

      result.components!.push({
        name: contextName,
        kind: 'context',
        framework: 'react',
      } as RawComponent);
      return;
    }

    // 4. useContext(ThemeContext) or use(ThemeContext) — React 19
    if (name === 'useContext' || name === 'use') {
      const arg = firstArg(node);
      if (arg && arg.type === 'identifier') {
        result.edges!.push({
          edgeType: 'react_context_consumes',
          metadata: { contextName: arg.text },
        });
      }
      return;
    }

    // 5. React.lazy(() => import('./Foo')) or lazy(() => import('./Foo'))
    if (name === 'React.lazy' || name === 'lazy') {
      const arg = firstArg(node);
      const importPath = this.extractLazyImportPath(arg);
      if (importPath) {
        result.edges!.push({
          edgeType: 'react_lazy_loads',
          metadata: { importPath },
        });
      }
      return;
    }

    // 6. Custom hook usage: useFoo() where useFoo starts with 'use' + uppercase
    if (/^use[A-Z]/.test(name) && !BUILTIN_HOOKS.has(name)) {
      result.edges!.push({
        edgeType: 'react_custom_hook_uses',
        metadata: { hookName: name },
      });
    }
  }

  /** Visit JSX elements for child component rendering and Context.Provider. */
  private visitJsxElement(node: TSNode, result: FileParseResult): void {
    const tag = jsxTagName(node);
    if (!tag) return;

    // 3. Context.Provider: <ThemeContext.Provider>
    if (tag.endsWith('.Provider') && isPascalCase(tag)) {
      const contextName = tag.replace(/\.Provider$/, '');
      result.edges!.push({
        edgeType: 'react_context_provides',
        metadata: { contextName },
      });
      return;
    }

    // 7. JSX child component rendering: PascalCase tag names
    if (isPascalCase(tag)) {
      // Skip dotted names that aren't providers (e.g. Foo.Bar is still a component render)
      result.edges!.push({
        edgeType: 'react_renders',
        metadata: { componentName: tag },
      });
    }
  }

  /** Extract the dynamic import path from a lazy() arrow function body. */
  private extractLazyImportPath(arg: TSNode | null): string | null {
    if (!arg) return null;

    // Walk into the arrow function body to find import('...')
    for (const child of walk(arg)) {
      if (child.type === 'call_expression') {
        const fn = child.childForFieldName('function');
        if (fn?.type === 'import') {
          const importArg = firstArg(child);
          if (importArg && (importArg.type === 'string' || importArg.type === 'template_string')) {
            // Strip quotes
            return importArg.text.replace(/^['"`]|['"`]$/g, '');
          }
        }
      }
    }
    return null;
  }
}
