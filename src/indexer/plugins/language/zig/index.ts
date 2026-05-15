/**
 * Zig Language Plugin — tree-sitter-based symbol extraction (v3).
 *
 * Extracts: functions (pub/inline/export/extern), structs with fields,
 * enums with values, unions, error sets, constants, variables,
 * methods inside containers, comptime blocks, test declarations,
 * @import edges, @cImport edges, and usingnamespace edges.
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

function extractSignature(node: TSNode): string {
  const firstLine = node.text.split('\n')[0].trim();
  const braceIdx = firstLine.indexOf('{');
  if (braceIdx > 0) return firstLine.substring(0, braceIdx).trim();
  return firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
}

function isPub(node: TSNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && !c.isNamed && c.type === 'pub') return true;
  }
  return false;
}

function isConst(node: TSNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && !c.isNamed && c.type === 'const') return true;
  }
  return false;
}

function getIdentifierName(node: TSNode): string | undefined {
  for (const child of node.namedChildren) {
    if (child.type === 'identifier') return child.text;
  }
  return undefined;
}

function getContainerKind(node: TSNode): 'struct' | 'enum' | 'union' | 'error_set' | undefined {
  for (const child of node.namedChildren) {
    if (child.type === 'struct_declaration') return 'struct';
    if (child.type === 'enum_declaration') return 'enum';
    if (child.type === 'union_declaration') return 'union';
    if (child.type === 'error_set_declaration') return 'error_set';
  }
  return undefined;
}

function getTestName(node: TSNode): string | undefined {
  for (const child of node.namedChildren) {
    if (child.type === 'string') {
      for (const sc of child.namedChildren) {
        if (sc.type === 'string_content') return sc.text;
      }
      return child.text.replace(/^"|"$/g, '');
    }
    if (child.type === 'identifier') return child.text;
  }
  return undefined;
}

/** Walk entire tree for @import, @cImport, and usingnamespace edges. */
function extractEdges(root: TSNode): RawEdge[] {
  const edges: RawEdge[] = [];
  const seen = new Set<string>();
  const stack: TSNode[] = [root];

  while (stack.length > 0) {
    const node = stack.pop()!;

    if (node.type === 'builtin_function') {
      let builtinName: string | undefined;
      let importPath: string | undefined;

      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (!c) continue;
        if (c.type === 'builtin_identifier') builtinName = c.text;
        if ((builtinName === '@import' || builtinName === '@cImport') && c.type === 'arguments') {
          for (const arg of c.namedChildren) {
            if (arg.type === 'string') {
              for (const sc of arg.namedChildren) {
                if (sc.type === 'string_content') {
                  importPath = sc.text;
                  break;
                }
              }
              if (!importPath) importPath = arg.text.replace(/^"|"$/g, '');
              break;
            }
          }
        }
      }

      if (builtinName && importPath) {
        const key = `${builtinName}:${importPath}`;
        if (!seen.has(key)) {
          seen.add(key);
          const meta: Record<string, unknown> = { module: importPath };
          if (builtinName === '@cImport') meta.cImport = true;
          edges.push({ edgeType: 'imports', metadata: meta });
        }
      }
    }

    // usingnamespace — re-export / import edge
    if (node.type === 'usingnamespace') {
      for (const child of node.namedChildren) {
        if (child.type === 'identifier' || child.type === 'field_access') {
          const key = `usingnamespace:${child.text}`;
          if (!seen.has(key)) {
            seen.add(key);
            edges.push({
              edgeType: 'imports',
              metadata: { module: child.text, usingnamespace: true },
            });
          }
        }
      }
    }

    for (let i = node.childCount - 1; i >= 0; i--) {
      const c = node.child(i);
      if (c) stack.push(c);
    }
  }

  return edges;
}

export class ZigLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'zig-language',
    version: '3.0.0',
    priority: 5,
  };

  supportedExtensions = ['.zig', '.zon'];

  async extractSymbols(
    filePath: string,
    content: Buffer,
  ): Promise<TraceMcpResult<FileParseResult>> {
    try {
      const parser = await getParser('zig');
      const sourceCode = content.toString('utf-8');
      const tree = parser.parse(sourceCode);
      try {
        const root: TSNode = tree.rootNode;

        const hasError = root.hasError;
        const symbols: RawSymbol[] = [];
        const warnings: string[] = [];
        const seen = new Set<string>();

        if (hasError) {
          warnings.push('Source contains syntax errors; extraction may be incomplete');
        }

        this.walkTopLevel(root, filePath, symbols, seen);

        const edges = extractEdges(root);

        return ok({
          language: 'zig',
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
      return err(parseError(filePath, `Zig parse failed: ${msg}`));
    }
  }

  private walkTopLevel(
    root: TSNode,
    filePath: string,
    symbols: RawSymbol[],
    seen: Set<string>,
  ): void {
    for (const child of root.namedChildren) {
      switch (child.type) {
        case 'function_declaration':
          this.extractFunction(child, filePath, symbols, seen);
          break;
        case 'variable_declaration':
          this.extractVariable(child, filePath, symbols, seen);
          break;
        case 'test_declaration':
          this.extractTest(child, filePath, symbols, seen);
          break;
        case 'comptime_block':
          this.extractComptime(child, filePath, symbols, seen);
          break;
      }
    }
  }

  private addSymbol(
    symbols: RawSymbol[],
    seen: Set<string>,
    sid: string,
    name: string,
    kind: SymbolKind,
    fqn: string,
    node: TSNode,
    meta?: Record<string, unknown>,
    parentSid?: string,
  ): void {
    if (seen.has(sid)) return;
    seen.add(sid);
    symbols.push({
      symbolId: sid,
      name,
      kind,
      fqn,
      parentSymbolId: parentSid,
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: meta && Object.keys(meta).length > 0 ? meta : undefined,
    });
  }

  private extractFunction(
    node: TSNode,
    filePath: string,
    symbols: RawSymbol[],
    seen: Set<string>,
  ): void {
    const name = getIdentifierName(node);
    if (!name) return;

    const meta: Record<string, unknown> = {};
    if (isPub(node)) meta.exported = true;
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c && !c.isNamed) {
        if (c.type === 'inline') meta.inline = true;
        if (c.type === 'export') meta.export = true;
        if (c.type === 'extern') meta.extern = true;
      }
    }

    this.addSymbol(
      symbols,
      seen,
      makeSymbolId(filePath, name, 'function'),
      name,
      'function',
      name,
      node,
      meta,
    );
  }

  private extractVariable(
    node: TSNode,
    filePath: string,
    symbols: RawSymbol[],
    seen: Set<string>,
  ): void {
    const name = getIdentifierName(node);
    if (!name) return;

    const containerKind = getContainerKind(node);
    const pub = isPub(node);
    const constDecl = isConst(node);

    if (containerKind) {
      if (containerKind === 'error_set') {
        const meta: Record<string, unknown> = { zigKind: 'error_set' };
        if (pub) meta.exported = true;
        this.addSymbol(
          symbols,
          seen,
          makeSymbolId(filePath, name, 'enum'),
          name,
          'enum',
          name,
          node,
          meta,
        );
      } else {
        const kind: SymbolKind = containerKind === 'enum' ? 'enum' : 'class';
        const meta: Record<string, unknown> = { zigKind: containerKind };
        if (pub) meta.exported = true;
        this.addSymbol(
          symbols,
          seen,
          makeSymbolId(filePath, name, kind),
          name,
          kind,
          name,
          node,
          meta,
        );
      }
      // Extract members (fields, methods, nested decls)
      this.extractContainerMembers(node, filePath, name, symbols, seen);
    } else if (constDecl) {
      const meta: Record<string, unknown> = {};
      if (pub) meta.exported = true;
      this.addSymbol(
        symbols,
        seen,
        makeSymbolId(filePath, name, 'constant'),
        name,
        'constant',
        name,
        node,
        meta,
      );
    } else {
      const meta: Record<string, unknown> = {};
      if (pub) meta.exported = true;
      this.addSymbol(
        symbols,
        seen,
        makeSymbolId(filePath, name, 'variable'),
        name,
        'variable',
        name,
        node,
        meta,
      );
    }
  }

  /** Extract members from struct/enum/union/error_set body. */
  private extractContainerMembers(
    node: TSNode,
    filePath: string,
    parentName: string,
    symbols: RawSymbol[],
    seen: Set<string>,
  ): void {
    const stack: TSNode[] = [];
    for (const child of node.namedChildren) {
      if (
        child.type === 'struct_declaration' ||
        child.type === 'enum_declaration' ||
        child.type === 'union_declaration' ||
        child.type === 'error_set_declaration'
      ) {
        for (const member of child.namedChildren) {
          stack.push(member);
        }
      }
    }

    const parentKind = node.namedChildren.some((c) => c.type === 'enum_declaration')
      ? 'enum'
      : 'class';

    for (const member of stack) {
      if (member.type === 'field_declaration') {
        const fieldName = getIdentifierName(member);
        if (fieldName) {
          this.addSymbol(
            symbols,
            seen,
            makeSymbolId(filePath, fieldName, 'property', parentName),
            fieldName,
            'property',
            `${parentName}.${fieldName}`,
            member,
            undefined,
            makeSymbolId(filePath, parentName, parentKind),
          );
        }
      } else if (member.type === 'enum_field') {
        const fieldName = getIdentifierName(member);
        if (fieldName) {
          this.addSymbol(
            symbols,
            seen,
            makeSymbolId(filePath, fieldName, 'constant', parentName),
            fieldName,
            'constant',
            `${parentName}.${fieldName}`,
            member,
            undefined,
            makeSymbolId(filePath, parentName, 'enum'),
          );
        }
      } else if (member.type === 'function_declaration') {
        const funcName = getIdentifierName(member);
        if (funcName) {
          const meta: Record<string, unknown> = {};
          if (isPub(member)) meta.exported = true;
          this.addSymbol(
            symbols,
            seen,
            makeSymbolId(filePath, funcName, 'method', parentName),
            funcName,
            'method',
            `${parentName}.${funcName}`,
            member,
            meta,
            makeSymbolId(filePath, parentName, parentKind),
          );
        }
      } else if (member.type === 'variable_declaration') {
        const varName = getIdentifierName(member);
        if (varName) {
          this.addSymbol(
            symbols,
            seen,
            makeSymbolId(filePath, varName, 'constant', parentName),
            varName,
            'constant',
            `${parentName}.${varName}`,
            member,
            undefined,
            makeSymbolId(filePath, parentName, parentKind),
          );
        }
      }
    }
  }

  private extractTest(
    node: TSNode,
    filePath: string,
    symbols: RawSymbol[],
    seen: Set<string>,
  ): void {
    const name = getTestName(node);
    if (!name) return;
    this.addSymbol(
      symbols,
      seen,
      makeSymbolId(filePath, name, 'function'),
      name,
      'function',
      name,
      node,
      { test: true },
    );
  }

  private extractComptime(
    node: TSNode,
    filePath: string,
    symbols: RawSymbol[],
    seen: Set<string>,
  ): void {
    for (const child of node.namedChildren) {
      if (child.type === 'block') {
        for (const stmt of child.namedChildren) {
          if (stmt.type === 'variable_declaration')
            this.extractVariable(stmt, filePath, symbols, seen);
          else if (stmt.type === 'function_declaration')
            this.extractFunction(stmt, filePath, symbols, seen);
        }
      }
    }
  }
}
