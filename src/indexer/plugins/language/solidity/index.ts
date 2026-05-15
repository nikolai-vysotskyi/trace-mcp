/**
 * Solidity Language Plugin — tree-sitter-based symbol extraction.
 *
 * Extracts: contracts, interfaces, libraries, structs, enums, events,
 * modifiers, errors, functions, state variables, constants, and import edges.
 */
import { err, ok } from 'neverthrow';
import type { TraceMcpResult } from '../../../../errors.js';
import { parseError } from '../../../../errors.js';
import { getParser, type TSNode } from '../../../../parser/tree-sitter.js';
import type {
  FileParseResult,
  LanguagePlugin,
  PluginManifest,
  RawEdge,
  RawSymbol,
  SymbolKind,
} from '../../../../plugin-api/types.js';

function makeSymbolId(filePath: string, name: string, kind: string, parent?: string): string {
  return parent ? `${filePath}::${parent}.${name}#${kind}` : `${filePath}::${name}#${kind}`;
}

function extractSignature(node: TSNode, maxLen = 120): string {
  const firstLine = node.text.split('\n')[0].trim();
  return firstLine.length > maxLen ? `${firstLine.slice(0, maxLen)}…` : firstLine;
}

function getNameText(node: TSNode, ...childTypes: string[]): string | null {
  for (const t of childTypes) {
    for (const child of node.namedChildren) {
      if (child.type === t) return child.text;
    }
  }
  return null;
}

function getVisibility(node: TSNode): string | undefined {
  for (const child of node.namedChildren) {
    if (child.type === 'visibility') return child.text;
  }
  return undefined;
}

export class SolidityLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'solidity-language',
    version: '2.0.0',
    priority: 5,
  };

  supportedExtensions = ['.sol'];

  async extractSymbols(
    filePath: string,
    content: Buffer,
  ): Promise<TraceMcpResult<FileParseResult>> {
    try {
      const parser = await getParser('solidity');
      const sourceCode = content.toString('utf-8');
      const tree = parser.parse(sourceCode);
      try {
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
          parent?: string,
          meta?: Record<string, unknown>,
        ): void => {
          const sid = makeSymbolId(filePath, name, kind, parent);
          if (seen.has(sid)) return;
          seen.add(sid);
          symbols.push({
            symbolId: sid,
            name,
            kind,
            fqn: parent ? `${parent}.${name}` : name,
            parentSymbolId: parent ? makeSymbolId(filePath, parent, 'class') : undefined,
            signature: extractSignature(node),
            byteStart: node.startIndex,
            byteEnd: node.endIndex,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            metadata: meta,
          });
        };

        for (const child of root.namedChildren) {
          this.visitTopLevel(child, addSymbol, edges);
        }

        return ok({
          language: 'solidity',
          status: hasError ? 'partial' : 'ok',
          symbols,
          edges: edges.length > 0 ? edges : undefined,
          warnings: warnings.length > 0 ? warnings : undefined,
        });
      } finally {
        tree.delete();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(parseError(filePath, `Solidity parse failed: ${msg}`));
    }
  }

  private visitTopLevel(
    node: TSNode,
    addSymbol: (
      name: string,
      kind: SymbolKind,
      node: TSNode,
      parent?: string,
      meta?: Record<string, unknown>,
    ) => void,
    edges: RawEdge[],
  ): void {
    switch (node.type) {
      // ── pragma ─────────────────────────────────────────────────
      case 'pragma_directive':
        // skip, no symbol
        break;

      // ── import ─────────────────────────────────────────────────
      case 'import_directive': {
        const source = getNameText(node, 'string', 'import_path');
        if (source) {
          const mod = source.replace(/^["']|["']$/g, '');
          edges.push({ edgeType: 'imports', metadata: { module: mod } });
        }
        break;
      }

      // ── contract / interface / library ─────────────────────────
      case 'contract_declaration':
      case 'interface_declaration':
      case 'library_declaration': {
        const name = getNameText(node, 'identifier');
        if (!name) break;
        const kind: SymbolKind = node.type === 'interface_declaration' ? 'interface' : 'class';
        const meta: Record<string, unknown> = {};
        if (node.type === 'library_declaration') meta.library = true;
        if (node.type === 'contract_declaration') {
          // check abstract
          for (const c of node.children) {
            if (c.type === 'abstract' || c.text === 'abstract') {
              meta.abstract = true;
              break;
            }
          }
        }
        // inheritance
        const inheritance = getNameText(node, 'inheritance_specifier');
        if (inheritance) meta.extends = inheritance;

        addSymbol(name, kind, node, undefined, Object.keys(meta).length > 0 ? meta : undefined);
        // Extract members
        this.visitContractBody(node, name, addSymbol);
        break;
      }

      // ── top-level struct ──────────────────────────────────────
      case 'struct_declaration': {
        const name = getNameText(node, 'identifier');
        if (name) addSymbol(name, 'class', node, undefined, { struct: true });
        break;
      }

      // ── top-level enum ────────────────────────────────────────
      case 'enum_declaration': {
        const name = getNameText(node, 'identifier');
        if (name) addSymbol(name, 'enum', node);
        break;
      }

      // ── top-level function (Solidity ≥ 0.7.1) ────────────────
      case 'function_definition': {
        const name = getNameText(node, 'identifier');
        if (name) addSymbol(name, 'function', node);
        break;
      }

      // ── top-level error definition ────────────────────────────
      case 'error_declaration': {
        const name = getNameText(node, 'identifier');
        if (name) addSymbol(name, 'constant', node, undefined, { error: true });
        break;
      }

      // ── top-level event ───────────────────────────────────────
      case 'event_definition': {
        const name = getNameText(node, 'identifier');
        if (name) addSymbol(name, 'property', node, undefined, { event: true });
        break;
      }

      // ── user-defined value type (Solidity ≥ 0.8.8) ───────────
      case 'user_defined_type_definition': {
        const name = getNameText(node, 'identifier');
        if (name) addSymbol(name, 'type', node);
        break;
      }

      // ── using directive ───────────────────────────────────────
      case 'using_directive': {
        // using LibName for Type;
        const lib = getNameText(node, 'user_defined_type', 'identifier');
        if (lib) {
          edges.push({ edgeType: 'imports', metadata: { module: lib } });
        }
        break;
      }

      default:
        // Recurse into source_unit children if wrapper
        if (node.type === 'source_unit') {
          for (const child of node.namedChildren) {
            this.visitTopLevel(child, addSymbol, edges);
          }
        }
        break;
    }
  }

  private visitContractBody(
    contractNode: TSNode,
    contractName: string,
    addSymbol: (
      name: string,
      kind: SymbolKind,
      node: TSNode,
      parent?: string,
      meta?: Record<string, unknown>,
    ) => void,
  ): void {
    for (const child of contractNode.namedChildren) {
      switch (child.type) {
        case 'function_definition': {
          const name = getNameText(child, 'identifier');
          if (name) {
            const vis = getVisibility(child);
            const meta: Record<string, unknown> = {};
            if (vis) meta.visibility = vis;
            // check for view/pure/payable
            for (const c of child.namedChildren) {
              if (
                c.type === 'state_mutability' ||
                c.text === 'view' ||
                c.text === 'pure' ||
                c.text === 'payable'
              ) {
                meta.mutability = c.text;
              }
            }
            addSymbol(
              name,
              'method',
              child,
              contractName,
              Object.keys(meta).length > 0 ? meta : undefined,
            );
          }
          break;
        }
        case 'modifier_definition': {
          const name = getNameText(child, 'identifier');
          if (name) addSymbol(name, 'method', child, contractName, { modifier: true });
          break;
        }
        case 'event_definition': {
          const name = getNameText(child, 'identifier');
          if (name) addSymbol(name, 'property', child, contractName, { event: true });
          break;
        }
        case 'error_declaration': {
          const name = getNameText(child, 'identifier');
          if (name) addSymbol(name, 'constant', child, contractName, { error: true });
          break;
        }
        case 'struct_declaration': {
          const name = getNameText(child, 'identifier');
          if (name) addSymbol(name, 'class', child, contractName, { struct: true });
          break;
        }
        case 'enum_declaration': {
          const name = getNameText(child, 'identifier');
          if (name) addSymbol(name, 'enum', child, contractName);
          break;
        }
        case 'state_variable_declaration': {
          const name = getNameText(child, 'identifier');
          if (name) {
            const vis = getVisibility(child);
            const isConstant =
              child.text.includes(' constant ') || child.text.includes(' immutable ');
            const kind: SymbolKind = isConstant ? 'constant' : 'property';
            const meta: Record<string, unknown> = {};
            if (vis) meta.visibility = vis;
            if (isConstant) meta.constant = true;
            addSymbol(
              name,
              kind,
              child,
              contractName,
              Object.keys(meta).length > 0 ? meta : undefined,
            );
          }
          break;
        }
        case 'constructor_definition': {
          addSymbol('constructor', 'method', child, contractName);
          break;
        }
        case 'fallback_receive_definition': {
          const text = child.text.trim();
          const fnName = text.startsWith('receive') ? 'receive' : 'fallback';
          addSymbol(fnName, 'method', child, contractName, { special: true });
          break;
        }
        // recurse into contract_body if present
        case 'contract_body': {
          this.visitContractBody(child, contractName, addSymbol);
          break;
        }
      }
    }
  }
}
