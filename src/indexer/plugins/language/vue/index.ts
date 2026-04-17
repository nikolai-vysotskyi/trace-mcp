/**
 * Vue SFC Language Plugin — extracts symbols from .vue single-file components.
 *
 * Uses @vue/compiler-sfc to parse the SFC descriptor, then:
 *   - Extracts props, emits, exposed, composables from <script setup>
 *   - Parses <script> blocks with tree-sitter-typescript for symbol extraction
 *   - Extracts custom component tags from <template>
 */
import { parse as parseSFC } from '@vue/compiler-sfc';
import { ok, err } from 'neverthrow';
import type {
  LanguagePlugin,
  PluginManifest,
  FileParseResult,
  RawSymbol,
  RawEdge,
  RawComponent,
} from '../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../errors.js';
import { parseError } from '../../../../errors.js';
import { getParser } from '../../../../parser/tree-sitter.js';
import {
  type TSNode,
  makeSymbolId,
  extractImportEdges,
  extractCallSites,
  collectLocalTypes,
  extractTypeReferences,
  extractModuleCallSites,
} from '../typescript/helpers.js';
import {
  componentNameFromPath,
  extractProps,
  extractEmits,
  extractExposed,
  extractComposables,
  extractTemplateComponents,
} from './helpers.js';

export class VueLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'vue-language',
    version: '1.0.0',
    priority: 10,
  };

  supportedExtensions = ['.vue'];

  async extractSymbols(filePath: string, content: Buffer): Promise<TraceMcpResult<FileParseResult>> {
    try {
      const sourceCode = content.toString('utf-8');
      const { descriptor, errors } = parseSFC(sourceCode, {
        filename: filePath,
      });

      const warnings: string[] = [];
      const symbols: RawSymbol[] = [];
      const edges: RawEdge[] = [];
      let status: 'ok' | 'partial' = 'ok';

      if (errors.length > 0) {
        status = 'partial';
        warnings.push(`SFC parse errors: ${errors.map((e) => e.message).join('; ')}`);
      }

      const componentName = componentNameFromPath(filePath);
      const componentSymbolId = makeSymbolId(filePath, componentName, 'class');

      // Create the component-level symbol
      symbols.push({
        symbolId: componentSymbolId,
        name: componentName,
        kind: 'class',
        byteStart: 0,
        byteEnd: content.length,
        lineStart: 1,
        lineEnd: sourceCode.split('\n').length,
        metadata: {
          framework: 'vue',
          sfc: true,
        },
      });

      // Extract from <script setup>
      let props: string[] = [];
      let emits: string[] = [];
      let exposed: string[] = [];
      let composables: string[] = [];

      if (descriptor.scriptSetup) {
        const setupContent = descriptor.scriptSetup.content;
        props = extractProps(setupContent);
        emits = extractEmits(setupContent);
        exposed = extractExposed(setupContent);
        composables = extractComposables(setupContent);

        // Extract import edges from script setup via tree-sitter
        const setupEdges = await this.parseScriptEdges(setupContent);
        edges.push(...setupEdges);

        // The whole <script setup> body is effectively module-level. Emit a
        // `__module__` pseudo-symbol to attribute its calls. We deliberately
        // do NOT extract individual function/variable declarations from here
        // — they're implementation details of the component setup block and
        // would bloat symbol counts with private locals.
        const setupModuleSym = await this.buildModuleSymbol(setupContent, filePath, '_setup');
        if (setupModuleSym) symbols.push(setupModuleSym);
      }

      // Extract from <script> (Options API or regular)
      if (descriptor.script) {
        const scriptContent = descriptor.script.content;
        const scriptSymbols = await this.parseScriptSymbols(scriptContent, filePath);
        symbols.push(...scriptSymbols);

        const scriptEdges = await this.parseScriptEdges(scriptContent);
        edges.push(...scriptEdges);

        const scriptModuleSym = await this.buildModuleSymbol(scriptContent, filePath, '_script');
        if (scriptModuleSym) symbols.push(scriptModuleSym);
      }

      // Extract template components
      let templateComponents: string[] = [];
      if (descriptor.template) {
        templateComponents = extractTemplateComponents(descriptor.template.content);
      }

      // Store template components + composables in component symbol metadata
      if (templateComponents.length > 0 || composables.length > 0) {
        const meta = symbols[0].metadata as Record<string, unknown>;
        if (templateComponents.length > 0) meta.templateComponents = templateComponents;
        if (composables.length > 0) meta.composables = composables;
        if (props.length > 0) meta.props = props;
        if (emits.length > 0) meta.emits = emits;
        if (exposed.length > 0) meta.exposed = exposed;
      }

      // Build the RawComponent
      const component: RawComponent = {
        name: componentName,
        kind: 'component',
        framework: 'vue',
        ...(props.length > 0 && {
          props: Object.fromEntries(props.map((p) => [p, { type: 'unknown' }])),
        }),
        ...(emits.length > 0 && { emits }),
        ...(composables.length > 0 && { composables }),
      };

      return ok({
        language: 'vue',
        status,
        symbols,
        edges: edges.length > 0 ? edges : undefined,
        components: [component],
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(parseError(filePath, `Vue SFC parse failed: ${msg}`));
    }
  }

  /**
   * Parse a script block with tree-sitter to extract import edges.
   */
  private async parseScriptEdges(scriptContent: string): Promise<RawEdge[]> {
    try {
      const parser = await getParser('typescript');
      const tree = parser.parse(scriptContent);
      return extractImportEdges(tree.rootNode as TSNode);
    } catch {
      return [];
    }
  }

  /**
   * Parse a <script> block with tree-sitter to extract top-level symbols.
   * Used for Options API / non-setup scripts.
   */
  private async parseScriptSymbols(scriptContent: string, filePath: string): Promise<RawSymbol[]> {
    try {
      const parser = await getParser('typescript');
      const tree = parser.parse(scriptContent);
      const root: TSNode = tree.rootNode;
      const symbols: RawSymbol[] = [];

      for (const node of root.namedChildren) {
        if (node.type === 'export_statement') {
          for (const child of node.namedChildren) {
            if (child.type === 'object' || child.type === 'call_expression') {
              // export default { ... } — Options API component definition
              // We don't double-extract as the SFC itself is the component
              continue;
            }
            this.extractScriptNode(child, filePath, symbols);
          }
        } else {
          this.extractScriptNode(node, filePath, symbols);
        }
      }
      return symbols;
    } catch {
      return [];
    }
  }

  private extractScriptNode(node: TSNode, filePath: string, symbols: RawSymbol[]): void {
    const nameNode = node.childForFieldName('name');
    const name = nameNode?.text;
    if (!name) return;

    let kind: 'function' | 'class' | 'variable' | 'type' | 'interface' | 'enum' | undefined;
    switch (node.type) {
      case 'function_declaration':
        kind = 'function';
        break;
      case 'class_declaration':
        kind = 'class';
        break;
      case 'lexical_declaration':
      case 'variable_declarator':
        kind = 'variable';
        break;
      case 'type_alias_declaration':
        kind = 'type';
        break;
      case 'interface_declaration':
        kind = 'interface';
        break;
      case 'enum_declaration':
        kind = 'enum';
        break;
    }

    if (!kind) return;

    // For function/method declarations: collect call sites, localTypes, typeRefs
    const metadata: Record<string, unknown> = {};
    if (kind === 'function' || kind === 'class') {
      const callSites = extractCallSites(node);
      if (callSites.length > 0) metadata.callSites = callSites;
      const localTypes = collectLocalTypes(node);
      if (Object.keys(localTypes).length > 0) metadata.localTypes = localTypes;
      const typeRefs = extractTypeReferences(node);
      if (typeRefs.length > 0) metadata.typeRefs = typeRefs;
    }

    symbols.push({
      symbolId: makeSymbolId(filePath, name, kind),
      name,
      kind,
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    });
  }

  /**
   * Build a synthetic `__module__` pseudo-symbol representing the Vue SFC's
   * script body. Captures module-level call sites so calls inside `<script setup>`
   * or non-named Options-API bodies can be attributed to something in the call graph.
   */
  private async buildModuleSymbol(scriptContent: string, filePath: string, suffix: string = ''): Promise<RawSymbol | null> {
    try {
      const parser = await getParser('typescript');
      const tree = parser.parse(scriptContent);
      const root: TSNode = tree.rootNode;
      // For Vue SFCs we pass skipLexicalFunctionBodies:false because local
      // `const foo = () => {…}` declarations in <script setup> are NOT extracted
      // as standalone symbols — their calls must be captured at module level.
      const callSites = extractModuleCallSites(root, { skipLexicalFunctionBodies: false });
      const typeRefs = extractTypeReferences(root);
      if (callSites.length === 0 && typeRefs.length === 0) return null;
      const baseName = filePath.split('/').pop()?.replace(/\.vue$/, '') ?? '__module__';
      const tag = suffix ? `__module__${suffix}` : '__module__';
      return {
        symbolId: makeSymbolId(filePath, tag, 'namespace'),
        name: `${tag}:${baseName}`,
        kind: 'namespace',
        signature: `(sfc ${suffix || 'script'} body) ${filePath}`,
        byteStart: 0,
        byteEnd: scriptContent.length,
        lineStart: 1,
        lineEnd: scriptContent.split('\n').length,
        metadata: {
          synthetic: true,
          moduleBody: true,
          ...(callSites.length > 0 ? { callSites } : {}),
          ...(typeRefs.length > 0 ? { typeRefs } : {}),
        },
      };
    } catch {
      return null;
    }
  }
}
