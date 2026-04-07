/**
 * TOML Language Plugin — tree-sitter-based, dialect-aware symbol extraction.
 *
 * Uses tree-sitter-toml for structured AST parsing, providing correct handling
 * of multiline values, inline tables, quoted keys, and dotted keys.
 *
 * Detects TOML dialect from filename (Cargo.toml, pyproject.toml, hugo.toml, etc.)
 * and applies specialized extraction for each dialect.
 *
 * Dialects: cargo, pyproject, hugo, rustfmt, deno, taplo, generic (fallback).
 */
import { ok, err } from 'neverthrow';
import type { LanguagePlugin, PluginManifest, FileParseResult, RawSymbol, RawEdge, SymbolKind } from '../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../errors.js';
import { parseError } from '../../../../errors.js';
import { getParser, type TSNode } from '../../../../parser/tree-sitter.js';

type TomlDialect = 'cargo' | 'pyproject' | 'hugo' | 'rustfmt' | 'deno' | 'taplo' | 'generic';

function detectDialect(filePath: string): TomlDialect {
  const basename = filePath.split('/').pop() ?? '';
  const lower = basename.toLowerCase();

  if (lower === 'cargo.toml') return 'cargo';
  if (lower === 'pyproject.toml') return 'pyproject';
  if (lower === 'hugo.toml' || lower === 'config.toml') return 'hugo';
  if (lower === 'rustfmt.toml') return 'rustfmt';
  if (lower === 'deno.toml') return 'deno';
  if (lower === 'taplo.toml' || lower === '.taplo.toml') return 'taplo';
  return 'generic';
}

function makeSymbolId(filePath: string, name: string, kind: SymbolKind, parent?: string): string {
  if (parent) return `${filePath}::${parent}::${name}#${kind}`;
  return `${filePath}::${name}#${kind}`;
}

/** Extract the key name from a table, table_array_element, or pair node. */
function extractKeyName(node: TSNode): string | undefined {
  // For table: [key] — children are "[", key, "]"
  // For table_array_element: [[key]] — children are "[[", key, "]]"
  // For pair: key = value — first named child is the key
  for (const child of node.namedChildren) {
    if (child.type === 'bare_key' || child.type === 'quoted_key') {
      return child.text;
    }
    if (child.type === 'dotted_key') {
      // Dotted keys like "tool.poetry.dependencies" — return full text
      return child.text;
    }
  }
  return undefined;
}

/** Extract the value text from a pair node. */
function extractValueText(node: TSNode): string | undefined {
  // pair has key and value children; value is the last named child
  const children = node.namedChildren;
  if (children.length >= 2) {
    return children[children.length - 1].text;
  }
  return undefined;
}

/** Unquote a TOML string value (remove surrounding quotes). */
function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, '');
}

export class TomlLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'toml-language',
    version: '3.0.0',
    priority: 6,
  };

  supportedExtensions = ['.toml'];

  async extractSymbols(filePath: string, content: Buffer): Promise<TraceMcpResult<FileParseResult>> {
    try {
      const parser = await getParser('toml');
      const source = content.toString('utf-8');
      const tree = parser.parse(source);
      const root: TSNode = tree.rootNode;

      const hasError = root.hasError;
      const dialect = detectDialect(filePath);
      const symbols: RawSymbol[] = [];
      const edges: RawEdge[] = [];
      const warnings: string[] = [];
      const seen = new Set<string>();

      if (hasError) {
        warnings.push('Source contains syntax errors; extraction may be incomplete');
      }

      let currentTable = '';
      let currentArrayTable = '';

      function addSymbol(
        name: string,
        kind: SymbolKind,
        lineStart: number,
        lineEnd: number,
        byteStart: number,
        byteEnd: number,
        meta?: Record<string, unknown>,
        parent?: string,
      ): void {
        const sid = makeSymbolId(filePath, name, kind, parent);
        if (seen.has(sid)) return;
        seen.add(sid);
        symbols.push({
          symbolId: sid,
          name,
          kind,
          fqn: parent ? `${parent}.${name}` : name,
          parentSymbolId: parent ? makeSymbolId(filePath, parent, 'namespace') : undefined,
          byteStart,
          byteEnd,
          lineStart,
          lineEnd,
          metadata: meta,
        });
      }

      function addEdge(module: string): void {
        edges.push({ edgeType: 'imports', metadata: { module } });
      }

      for (const child of root.namedChildren) {
        switch (child.type) {
          case 'table': {
            const tableName = extractKeyName(child);
            if (!tableName) break;
            currentTable = tableName;
            currentArrayTable = '';

            const ln = child.startPosition.row + 1;
            const lnEnd = child.endPosition.row + 1;
            const bs = child.startIndex;
            const be = child.endIndex;

            // Dialect-specific table handling
            if (dialect === 'cargo') {
              if (currentTable === 'package' || currentTable === 'features') {
                // will extract keys inside
              } else if (currentTable === 'dependencies' || currentTable.startsWith('dependencies.') ||
                         currentTable === 'dev-dependencies' || currentTable === 'build-dependencies') {
                // dependencies are handled per-key below
              } else {
                addSymbol(currentTable, 'namespace', ln, lnEnd, bs, be, { tomlKind: 'table', dialect });
              }
            } else if (dialect === 'pyproject') {
              if (currentTable === 'project' || currentTable === 'build-system' ||
                  currentTable === 'tool.poetry.dependencies' || currentTable.startsWith('tool.')) {
                // will extract keys inside
              } else {
                addSymbol(currentTable, 'namespace', ln, lnEnd, bs, be, { tomlKind: 'table', dialect });
              }
            } else if (dialect === 'hugo') {
              if (currentTable === 'params' || currentTable.startsWith('params.') ||
                  currentTable === 'menu' || currentTable.startsWith('menu.')) {
                addSymbol(currentTable, 'namespace', ln, lnEnd, bs, be, { tomlKind: 'table', dialect });
              } else {
                addSymbol(currentTable, 'namespace', ln, lnEnd, bs, be, { tomlKind: 'table', dialect });
              }
            } else {
              // generic, rustfmt, deno, taplo
              addSymbol(currentTable, 'namespace', ln, lnEnd, bs, be, { tomlKind: 'table', dialect });
            }

            // Process pairs inside this table
            this.processPairs(child, filePath, dialect, currentTable, currentArrayTable, addSymbol, addEdge);
            break;
          }

          case 'table_array_element': {
            const arrayTableName = extractKeyName(child);
            if (!arrayTableName) break;
            currentArrayTable = arrayTableName;
            currentTable = arrayTableName;

            const ln = child.startPosition.row + 1;
            const lnEnd = child.endPosition.row + 1;
            const bs = child.startIndex;
            const be = child.endIndex;

            if (dialect === 'cargo' && currentTable === 'bin') {
              // [[bin]] — will extract name from keys inside
            } else if (dialect === 'generic') {
              addSymbol(currentArrayTable, 'class', ln, lnEnd, bs, be, { tomlKind: 'array-of-tables', dialect });
            }

            // Process pairs inside this array-of-tables element
            this.processPairs(child, filePath, dialect, currentTable, currentArrayTable, addSymbol, addEdge);
            break;
          }

          case 'pair': {
            // Top-level key = value (before any table)
            this.processSinglePair(child, filePath, dialect, currentTable, currentArrayTable, addSymbol, addEdge);
            break;
          }
        }
      }

      return ok({
        language: 'toml',
        status: hasError ? 'partial' : 'ok',
        symbols,
        edges: edges.length > 0 ? edges : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
        metadata: { dialect },
      });
    } catch (e) {
      return err(parseError(filePath, e instanceof Error ? e.message : String(e)));
    }
  }

  /** Process all pair children within a table or table_array_element node. */
  private processPairs(
    parentNode: TSNode,
    filePath: string,
    dialect: TomlDialect,
    currentTable: string,
    currentArrayTable: string,
    addSymbol: (name: string, kind: SymbolKind, lineStart: number, lineEnd: number, byteStart: number, byteEnd: number, meta?: Record<string, unknown>, parent?: string) => void,
    addEdge: (module: string) => void,
  ): void {
    for (const child of parentNode.namedChildren) {
      if (child.type === 'pair') {
        this.processSinglePair(child, filePath, dialect, currentTable, currentArrayTable, addSymbol, addEdge);
      }
    }
  }

  /** Process a single pair node with dialect-specific logic. */
  private processSinglePair(
    pairNode: TSNode,
    filePath: string,
    dialect: TomlDialect,
    currentTable: string,
    currentArrayTable: string,
    addSymbol: (name: string, kind: SymbolKind, lineStart: number, lineEnd: number, byteStart: number, byteEnd: number, meta?: Record<string, unknown>, parent?: string) => void,
    addEdge: (module: string) => void,
  ): void {
    const key = extractKeyName(pairNode);
    if (!key) return;

    const valueText = extractValueText(pairNode) ?? '';
    const unquotedValue = unquote(valueText);

    const ln = pairNode.startPosition.row + 1;
    const lnEnd = pairNode.endPosition.row + 1;
    const bs = pairNode.startIndex;
    const be = pairNode.endIndex;

    switch (dialect) {
      case 'cargo':
        if (currentTable === 'package') {
          if (key === 'name' || key === 'version') {
            addSymbol(key, 'constant', ln, lnEnd, bs, be, { tomlKind: 'package-field', dialect, value: unquotedValue }, 'package');
          }
        } else if (currentTable === 'dependencies' || currentTable === 'dev-dependencies' || currentTable === 'build-dependencies') {
          addEdge(key);
        } else if (currentTable === 'features') {
          addSymbol(key, 'constant', ln, lnEnd, bs, be, { tomlKind: 'feature', dialect }, 'features');
        } else if (currentArrayTable === 'bin' && key === 'name') {
          addSymbol(unquotedValue, 'constant', ln, lnEnd, bs, be, { tomlKind: 'binary', dialect });
        } else {
          addSymbol(key, 'constant', ln, lnEnd, bs, be, { tomlKind: 'key', dialect }, currentTable || undefined);
        }
        break;

      case 'pyproject':
        if (currentTable === 'project') {
          if (key === 'name' || key === 'version') {
            addSymbol(key, 'constant', ln, lnEnd, bs, be, { tomlKind: 'project-field', dialect, value: unquotedValue }, 'project');
          }
        } else if (currentTable === 'tool.poetry.dependencies') {
          addEdge(key);
        } else if (currentTable === 'build-system' && key === 'requires') {
          // requires = ["setuptools"]
          const deps = valueText.match(/"([^"]+)"/g);
          if (deps) {
            for (const dep of deps) {
              addEdge(dep.replace(/"/g, '').split(/[><=!~]/)[0].trim());
            }
          }
        } else {
          addSymbol(key, 'constant', ln, lnEnd, bs, be, { tomlKind: 'key', dialect }, currentTable || undefined);
        }
        break;

      case 'hugo':
        if (key === 'theme') {
          addEdge(unquotedValue);
        }
        addSymbol(key, 'constant', ln, lnEnd, bs, be, { tomlKind: 'key', dialect }, currentTable || undefined);
        break;

      case 'rustfmt':
        addSymbol(key, 'constant', ln, lnEnd, bs, be, { tomlKind: 'config', dialect });
        break;

      case 'deno':
        if (currentTable === 'tasks') {
          addSymbol(key, 'function', ln, lnEnd, bs, be, { tomlKind: 'task', dialect }, 'tasks');
        } else if (currentTable === 'imports') {
          addEdge(unquotedValue);
        } else {
          addSymbol(key, 'constant', ln, lnEnd, bs, be, { tomlKind: 'key', dialect }, currentTable || undefined);
        }
        break;

      case 'taplo':
        addSymbol(key, 'constant', ln, lnEnd, bs, be, { tomlKind: 'config', dialect });
        break;

      default:
        // generic
        addSymbol(key, 'constant', ln, lnEnd, bs, be, { tomlKind: 'key', dialect }, currentTable || undefined);
        break;
    }
  }
}
