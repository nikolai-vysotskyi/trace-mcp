/**
 * OCaml Language Plugin — tree-sitter-based symbol extraction.
 *
 * Extracts: let/val bindings, type definitions, modules, module types,
 * classes, exceptions, and import edges (open statements).
 */
import { ok, err } from 'neverthrow';
import type {
  LanguagePlugin,
  PluginManifest,
  FileParseResult,
  RawSymbol,
  RawEdge,
  SymbolKind,
} from '../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../errors.js';
import { parseError } from '../../../../errors.js';
import { getParser, type TSNode } from '../../../../parser/tree-sitter.js';

function makeSymbolId(filePath: string, name: string, kind: string): string {
  return `${filePath}::${name}#${kind}`;
}

function extractSignature(node: TSNode): string {
  return node.text.split('\n')[0].trim();
}

/**
 * Recursively collect the text of a module path node
 * (handles both simple identifiers and dotted module paths).
 */
function collectModulePath(node: TSNode): string {
  if (node.type === 'module_path') {
    return node.text;
  }
  return node.text;
}

/**
 * Find a named child matching one of the given types.
 */
function findChildByTypes(node: TSNode, types: string[]): TSNode | null {
  for (const child of node.namedChildren) {
    if (types.includes(child.type)) return child;
  }
  return null;
}

/**
 * Extract a name from common OCaml definition node patterns.
 * Tries field names and well-known child types.
 */
function extractName(node: TSNode, ...childTypes: string[]): string | null {
  // Try named children matching the requested types
  for (const t of childTypes) {
    for (const child of node.namedChildren) {
      if (child.type === t) return child.text;
    }
  }
  return null;
}

export class OcamlLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'ocaml-language',
    version: '2.0.0',
    priority: 5,
  };

  supportedExtensions = ['.ml', '.mli'];

  async extractSymbols(
    filePath: string,
    content: Buffer,
  ): Promise<TraceMcpResult<FileParseResult>> {
    try {
      const parser = await getParser('ocaml');
      const sourceCode = content.toString('utf-8');
      const tree = parser.parse(sourceCode);
      const root: TSNode = tree.rootNode;

      const hasError = root.hasError;
      const symbols: RawSymbol[] = [];
      const edges: RawEdge[] = [];
      const warnings: string[] = [];
      const seen = new Set<string>();

      if (hasError) {
        warnings.push('Source contains syntax errors; extraction may be incomplete');
      }

      const addSymbol = (
        name: string,
        kind: SymbolKind,
        node: TSNode,
        meta?: Record<string, unknown>,
      ): void => {
        const sid = makeSymbolId(filePath, name, kind);
        if (seen.has(sid)) return;
        seen.add(sid);
        symbols.push({
          symbolId: sid,
          name,
          kind,
          fqn: name,
          signature: extractSignature(node),
          byteStart: node.startIndex,
          byteEnd: node.endIndex,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          metadata: meta,
        });
      };

      // Walk top-level children of the root node
      for (const child of root.namedChildren) {
        this.visitNode(child, addSymbol, edges);
      }

      return ok({
        language: 'ocaml',
        status: hasError ? 'partial' : 'ok',
        symbols,
        edges: edges.length > 0 ? edges : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(parseError(filePath, `OCaml parse failed: ${msg}`));
    }
  }

  /**
   * Visit a single AST node and extract symbols / edges as appropriate.
   */
  private visitNode(
    node: TSNode,
    addSymbol: (name: string, kind: SymbolKind, node: TSNode, meta?: Record<string, unknown>) => void,
    edges: RawEdge[],
  ): void {
    switch (node.type) {
      // ── let / let rec bindings ──────────────────────────────────
      case 'value_definition': {
        for (const child of node.namedChildren) {
          if (child.type === 'let_binding') {
            const nameNode = findChildByTypes(child, [
              'value_name',
              'value_pattern',
            ]);
            const name = nameNode?.text;
            if (name && /^\w+$/.test(name)) {
              addSymbol(name, 'function', child);
            }
          }
        }
        break;
      }

      // ── val specifications (.mli) ──────────────────────────────
      case 'value_specification': {
        const name = extractName(node, 'value_name');
        if (name) {
          addSymbol(name, 'function', node);
        }
        break;
      }

      // ── type definitions ───────────────────────────────────────
      case 'type_definition': {
        for (const child of node.namedChildren) {
          if (child.type === 'type_binding') {
            const name = extractName(child, 'type_constructor', 'type_constructor_path');
            if (name) {
              addSymbol(name, 'type', child);
            }
          }
        }
        break;
      }

      // ── module definitions ─────────────────────────────────────
      case 'module_definition': {
        const name = extractName(node, 'module_name', 'module_binding');
        if (name) {
          addSymbol(name, 'module', node);
        } else {
          // module_binding may wrap the name; dig one level deeper
          for (const child of node.namedChildren) {
            if (child.type === 'module_binding') {
              const innerName = extractName(child, 'module_name');
              if (innerName) {
                addSymbol(innerName, 'module', node);
              }
            }
          }
        }
        break;
      }

      // ── module type definitions ────────────────────────────────
      case 'module_type_definition': {
        const name = extractName(node, 'module_type_name');
        if (name) {
          addSymbol(name, 'type', node);
        }
        break;
      }

      // ── class definitions ──────────────────────────────────────
      case 'class_definition': {
        for (const child of node.namedChildren) {
          if (child.type === 'class_binding') {
            const name = extractName(child, 'class_name');
            if (name) {
              addSymbol(name, 'class', child);
            }
          }
        }
        break;
      }

      // ── exception definitions ──────────────────────────────────
      case 'exception_definition': {
        const name = extractName(node, 'constructor_name', 'constructor_declaration');
        if (name) {
          addSymbol(name, 'constant', node);
        } else {
          // Some grammars nest the name inside a constructor_declaration
          for (const child of node.namedChildren) {
            if (child.type === 'constructor_declaration') {
              const innerName = extractName(child, 'constructor_name');
              if (innerName) {
                addSymbol(innerName, 'constant', node);
              }
            }
          }
        }
        break;
      }

      // ── open statements (import edges) ─────────────────────────
      case 'open_statement': {
        const modNode = findChildByTypes(node, [
          'module_path',
          'module_name',
          'extended_module_path',
        ]);
        if (modNode) {
          const modPath = collectModulePath(modNode);
          if (modPath) {
            edges.push({ edgeType: 'imports', metadata: { module: modPath } });
          }
        }
        break;
      }

      // For any structure/signature wrapper nodes, recurse into children
      default: {
        if (
          node.type === 'structure' ||
          node.type === 'signature' ||
          node.type === 'module_expression'
        ) {
          for (const child of node.namedChildren) {
            this.visitNode(child, addSymbol, edges);
          }
        }
        break;
      }
    }
  }
}
