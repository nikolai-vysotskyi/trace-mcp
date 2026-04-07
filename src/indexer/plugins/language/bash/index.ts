/**
 * Bash/Shell Language Plugin — tree-sitter-based symbol extraction.
 *
 * Extracts: function definitions, readonly/exported constants, exported variables.
 * Import edges: `source file.sh` and `. file.sh` commands.
 */
import { ok, err } from 'neverthrow';
import type { LanguagePlugin, PluginManifest, FileParseResult, RawSymbol, RawEdge, SymbolKind } from '../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../errors.js';
import { parseError } from '../../../../errors.js';
import { getParser, type TSNode } from '../../../../parser/tree-sitter.js';

function makeSymbolId(filePath: string, name: string, kind: string): string {
  return `${filePath}::${name}#${kind}`;
}

function extractSignature(node: TSNode): string {
  return node.text.split('\n')[0].trim();
}

export class BashLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = { name: 'bash-language', version: '2.0.0', priority: 5 };
  supportedExtensions = ['.sh', '.bash', '.zsh'];

  async extractSymbols(filePath: string, content: Buffer): Promise<TraceMcpResult<FileParseResult>> {
    try {
      const parser = await getParser('bash');
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

      for (const child of root.namedChildren) {
        switch (child.type) {
          case 'function_definition':
            this.extractFunction(child, filePath, symbols, seen);
            break;
          case 'declaration_command':
            this.extractDeclaration(child, filePath, symbols, seen);
            break;
          case 'variable_assignment':
            this.extractTopLevelVariable(child, filePath, symbols, seen);
            break;
          case 'command':
            this.extractSourceEdge(child, filePath, edges);
            break;
        }
      }

      return ok({
        language: 'bash',
        status: hasError ? 'partial' : 'ok',
        symbols,
        edges: edges.length > 0 ? edges : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(parseError(filePath, `Bash parse failed: ${msg}`));
    }
  }

  /** Extract `function name { ... }` and `name() { ... }` */
  private extractFunction(node: TSNode, filePath: string, symbols: RawSymbol[], seen: Set<string>): void {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    const name = nameNode.text;
    const id = makeSymbolId(filePath, name, 'function');
    if (seen.has(id)) return;
    seen.add(id);

    symbols.push({
      symbolId: id,
      name,
      kind: 'function',
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
    });
  }

  /**
   * Extract from `declaration_command` nodes:
   * - `readonly NAME=...` → constant (UPPERCASE names only)
   * - `declare -r NAME=...` → constant (UPPERCASE names only)
   * - `export NAME=...` → variable with exported metadata
   */
  private extractDeclaration(node: TSNode, filePath: string, symbols: RawSymbol[], seen: Set<string>): void {
    // Determine the declaration type from the first child (word)
    const firstChild = node.namedChildren[0];
    if (!firstChild) return;

    const commandWord = firstChild.type === 'word' ? firstChild.text : node.children[0]?.text;
    if (!commandWord) return;

    // Check for declare -r (readonly via declare)
    const isDeclareReadonly = commandWord === 'declare' && node.text.includes('-r');
    const isReadonly = commandWord === 'readonly' || isDeclareReadonly;
    const isExport = commandWord === 'export';

    if (!isReadonly && !isExport) return;

    // Find variable_assignment children to get name=value pairs
    for (const child of node.namedChildren) {
      if (child.type === 'variable_assignment') {
        const varNameNode = child.childForFieldName('name');
        if (!varNameNode) continue;

        const name = varNameNode.text;
        const isUpperCase = /^[A-Z_][A-Z0-9_]*$/.test(name);

        let kind: SymbolKind;
        let meta: Record<string, unknown> | undefined;

        if (isReadonly && isUpperCase) {
          kind = 'constant';
        } else if (isExport && isUpperCase) {
          kind = 'variable';
          meta = { exported: true };
        } else if (isExport) {
          // Export of lowercase variable — still meaningful
          kind = 'variable';
          meta = { exported: true };
        } else {
          // readonly with lowercase name — skip (too noisy)
          continue;
        }

        const id = makeSymbolId(filePath, name, kind);
        if (seen.has(id)) continue;
        seen.add(id);

        symbols.push({
          symbolId: id,
          name,
          kind,
          signature: extractSignature(node),
          byteStart: node.startIndex,
          byteEnd: node.endIndex,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          metadata: meta,
        });
      }
    }
  }

  /**
   * Extract top-level UPPERCASE variable assignments as constants.
   * Only UPPER_CASE names to avoid noise from general shell variables.
   */
  private extractTopLevelVariable(node: TSNode, filePath: string, symbols: RawSymbol[], seen: Set<string>): void {
    const varNameNode = node.childForFieldName('name');
    if (!varNameNode) return;

    const name = varNameNode.text;
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) return;

    const id = makeSymbolId(filePath, name, 'constant');
    if (seen.has(id)) return;
    seen.add(id);

    symbols.push({
      symbolId: id,
      name,
      kind: 'constant',
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
    });
  }

  /**
   * Extract `source file.sh` and `. file.sh` as import edges.
   */
  private extractSourceEdge(node: TSNode, filePath: string, edges: RawEdge[]): void {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    const cmdName = nameNode.text;
    if (cmdName !== 'source' && cmdName !== '.') return;

    // The argument is the next named child after the command name
    const args = node.namedChildren.filter(c => c.id !== nameNode.id);
    if (args.length === 0) return;

    const target = args[0].text;
    // Skip variable interpolation and complex expressions
    if (target.includes('$') || target.includes('`')) return;

    // Strip quotes
    const cleanTarget = target.replace(/^["']|["']$/g, '');
    if (!cleanTarget) return;

    edges.push({
      sourceSymbolId: filePath,
      targetSymbolId: cleanTarget,
      edgeType: 'sources',
      metadata: { raw: cleanTarget },
    });
  }
}
