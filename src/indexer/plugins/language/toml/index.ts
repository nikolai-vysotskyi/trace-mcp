/**
 * TOML Language Plugin — dialect-aware symbol extraction.
 *
 * Detects TOML dialect from filename (Cargo.toml, pyproject.toml, hugo.toml, etc.)
 * and applies specialized extraction for each dialect.
 *
 * Dialects: cargo, pyproject, hugo, rustfmt, deno, taplo, generic (fallback).
 */
import { ok } from 'neverthrow';
import type { LanguagePlugin, PluginManifest, FileParseResult, RawSymbol, RawEdge, SymbolKind } from '../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../errors.js';

type TomlDialect = 'cargo' | 'pyproject' | 'hugo' | 'rustfmt' | 'deno' | 'taplo' | 'generic';

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

function makeSymbolId(filePath: string, name: string, kind: SymbolKind, parent?: string): string {
  if (parent) return `${filePath}::${parent}::${name}#${kind}`;
  return `${filePath}::${name}#${kind}`;
}

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

export class TomlLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'toml-language',
    version: '2.0.0',
    priority: 6,
  };

  supportedExtensions = ['.toml'];

  extractSymbols(filePath: string, content: Buffer): TraceMcpResult<FileParseResult> {
    const source = content.toString('utf-8');
    const dialect = detectDialect(filePath);
    const symbols: RawSymbol[] = [];
    const edges: RawEdge[] = [];
    const seen = new Set<string>();

    const lines = source.split('\n');
    let currentTable = '';
    let currentArrayTable = '';
    let byteOffset = 0;

    function addSymbol(name: string, kind: SymbolKind, line: number, offset: number, meta?: Record<string, unknown>, parent?: string): void {
      const sid = makeSymbolId(filePath, name, kind, parent);
      if (seen.has(sid)) return;
      seen.add(sid);
      symbols.push({
        symbolId: sid,
        name,
        kind,
        fqn: parent ? `${parent}.${name}` : name,
        parentSymbolId: parent ? makeSymbolId(filePath, parent, 'namespace') : undefined,
        byteStart: offset,
        byteEnd: offset + name.length,
        lineStart: line,
        lineEnd: line,
        metadata: meta,
      });
    }

    function addEdge(module: string): void {
      edges.push({ edgeType: 'imports', metadata: { module } });
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;
      const lineOffset = byteOffset;

      // [[array-of-tables]]
      const arrayTableMatch = line.match(/^\s*\[\[([a-zA-Z_][a-zA-Z0-9_.-]*)\]\]/);
      if (arrayTableMatch) {
        currentArrayTable = arrayTableMatch[1];
        currentTable = arrayTableMatch[1];

        if (dialect === 'cargo' && currentTable === 'bin') {
          // [[bin]] — will extract name from keys inside
        } else if (dialect === 'generic') {
          addSymbol(currentArrayTable, 'class', lineNum, lineOffset, { tomlKind: 'array-of-tables', dialect });
        }

        byteOffset += line.length + 1;
        continue;
      }

      // [table]
      const tableMatch = line.match(/^\s*\[([a-zA-Z_][a-zA-Z0-9_.-]*)\](?!\])/);
      if (tableMatch) {
        currentTable = tableMatch[1];
        currentArrayTable = '';

        // Dialect-specific table handling
        if (dialect === 'cargo') {
          if (currentTable === 'package' || currentTable === 'features') {
            // will extract keys inside
          } else if (currentTable === 'dependencies' || currentTable.startsWith('dependencies.') ||
                     currentTable === 'dev-dependencies' || currentTable === 'build-dependencies') {
            // dependencies are handled per-key below
          } else {
            addSymbol(currentTable, 'namespace', lineNum, lineOffset, { tomlKind: 'table', dialect });
          }
        } else if (dialect === 'pyproject') {
          if (currentTable === 'project' || currentTable === 'build-system' ||
              currentTable === 'tool.poetry.dependencies' || currentTable.startsWith('tool.')) {
            // will extract keys inside
          } else {
            addSymbol(currentTable, 'namespace', lineNum, lineOffset, { tomlKind: 'table', dialect });
          }
        } else if (dialect === 'hugo') {
          if (currentTable === 'params' || currentTable.startsWith('params.') ||
              currentTable === 'menu' || currentTable.startsWith('menu.')) {
            addSymbol(currentTable, 'namespace', lineNum, lineOffset, { tomlKind: 'table', dialect });
          } else {
            addSymbol(currentTable, 'namespace', lineNum, lineOffset, { tomlKind: 'table', dialect });
          }
        } else {
          // generic, rustfmt, deno, taplo
          addSymbol(currentTable, 'namespace', lineNum, lineOffset, { tomlKind: 'table', dialect });
        }

        byteOffset += line.length + 1;
        continue;
      }

      // key = value
      const kvMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*(.*)/);
      if (kvMatch) {
        const key = kvMatch[1];
        const value = kvMatch[2].trim();
        const unquoted = value.replace(/^["']|["']$/g, '');

        switch (dialect) {
          case 'cargo':
            if (currentTable === 'package') {
              if (key === 'name' || key === 'version') {
                addSymbol(key, 'constant', lineNum, lineOffset, { tomlKind: 'package-field', dialect, value: unquoted }, 'package');
              }
            } else if (currentTable === 'dependencies' || currentTable === 'dev-dependencies' || currentTable === 'build-dependencies') {
              addEdge(key);
            } else if (currentTable === 'features') {
              addSymbol(key, 'constant', lineNum, lineOffset, { tomlKind: 'feature', dialect }, 'features');
            } else if (currentArrayTable === 'bin' && key === 'name') {
              addSymbol(unquoted, 'constant', lineNum, lineOffset, { tomlKind: 'binary', dialect });
            } else {
              addSymbol(key, 'constant', lineNum, lineOffset, { tomlKind: 'key', dialect }, currentTable || undefined);
            }
            break;

          case 'pyproject':
            if (currentTable === 'project') {
              if (key === 'name' || key === 'version') {
                addSymbol(key, 'constant', lineNum, lineOffset, { tomlKind: 'project-field', dialect, value: unquoted }, 'project');
              }
            } else if (currentTable === 'tool.poetry.dependencies') {
              addEdge(key);
            } else if (currentTable === 'build-system' && key === 'requires') {
              // requires = ["setuptools"]
              const deps = value.match(/"([^"]+)"/g);
              if (deps) {
                for (const dep of deps) {
                  addEdge(dep.replace(/"/g, '').split(/[><=!~]/)[0].trim());
                }
              }
            } else {
              addSymbol(key, 'constant', lineNum, lineOffset, { tomlKind: 'key', dialect }, currentTable || undefined);
            }
            break;

          case 'hugo':
            if (key === 'theme') {
              addEdge(unquoted);
            }
            addSymbol(key, 'constant', lineNum, lineOffset, { tomlKind: 'key', dialect }, currentTable || undefined);
            break;

          case 'rustfmt':
            addSymbol(key, 'constant', lineNum, lineOffset, { tomlKind: 'config', dialect });
            break;

          case 'deno':
            if (currentTable === 'tasks') {
              addSymbol(key, 'function', lineNum, lineOffset, { tomlKind: 'task', dialect }, 'tasks');
            } else if (currentTable === 'imports') {
              addEdge(unquoted);
            } else {
              addSymbol(key, 'constant', lineNum, lineOffset, { tomlKind: 'key', dialect }, currentTable || undefined);
            }
            break;

          case 'taplo':
            addSymbol(key, 'constant', lineNum, lineOffset, { tomlKind: 'config', dialect });
            break;

          default:
            // generic
            addSymbol(key, 'constant', lineNum, lineOffset, { tomlKind: 'key', dialect }, currentTable || undefined);
            break;
        }

        byteOffset += line.length + 1;
        continue;
      }

      byteOffset += line.length + 1;
    }

    return ok({
      language: 'toml',
      status: 'ok',
      symbols,
      edges: edges.length > 0 ? edges : undefined,
      metadata: { dialect },
    });
  }
}
