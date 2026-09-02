/**
 * Makefile Language Plugin — regex-based symbol extraction.
 *
 * Extracts: targets, variable definitions, define blocks, include directives.
 */

import { ok } from 'neverthrow';
import type { TraceMcpResult } from '../../../../errors.js';
import type { FileParseResult, LanguagePlugin, RawSymbol } from '../../../../plugin-api/types.js';
import { createRegexLanguagePlugin, lineAt, makeSymbolId } from '../regex-base.js';

const _plugin = createRegexLanguagePlugin({
  name: 'makefile',
  language: 'makefile',
  extensions: ['Makefile', 'makefile', '.mk', 'GNUmakefile'],
  symbolPatterns: [
    // target: [deps] (not variable assignments, not comments, not tabs)
    { kind: 'function', pattern: /^([a-zA-Z_][\w.-]*)(?:\s+[a-zA-Z_][\w.-]*)?\s*:[^=]/gm },
    // NAME = value / NAME := value / NAME ?= value / NAME += value
    { kind: 'variable', pattern: /^([A-Za-z_]\w*)\s*(?::=|\?=|\+=|=)/gm },
    // define NAME
    { kind: 'function', pattern: /^define\s+(\w+)/gm, meta: { define: true } },
    // export NAME
    { kind: 'variable', pattern: /^export\s+([A-Za-z_]\w*)/gm, meta: { exported: true } },
  ],
  importPatterns: [
    // include file.mk / -include file.mk
    { pattern: /^-?include\s+(\S+)/gm },
  ],
});

/**
 * `.PHONY: a b c` declares each of a/b/c as a target in its own right — a
 * matching rule elsewhere in the file is common but not required (generated,
 * pattern-rule-only, or include-supplied targets have none). The shared
 * regex-base engine gives one name per pattern match, so a plain symbolPattern
 * can't split a multi-target line into several symbols; handled here instead,
 * deduplicated against whatever the primary rule pattern already found.
 */
function extractPhonyTargets(
  filePath: string,
  source: string,
  existingIds: Set<string>,
): RawSymbol[] {
  const symbols: RawSymbol[] = [];
  const seen = new Set<string>();
  const lineRe = /^\.PHONY:\s*([^#\r\n]+)/gm;
  let lineMatch: RegExpExecArray | null;
  while ((lineMatch = lineRe.exec(source)) !== null) {
    const list = lineMatch[1];
    // `list` is always the tail of `lineMatch[0]` (everything after ".PHONY:"
    // and its leading whitespace) — measure from the end, not indexOf, or a
    // target that happens to be a substring of ".PHONY:" itself (e.g. "O")
    // matches inside the keyword instead of inside the list.
    const listStart = lineMatch.index + (lineMatch[0].length - list.length);
    const tokenRe = /\S+/g;
    let tokenMatch: RegExpExecArray | null;
    while ((tokenMatch = tokenRe.exec(list)) !== null) {
      const name = tokenMatch[0];
      if (name === '\\') continue; // line-continuation marker, not a target
      const symbolId = makeSymbolId(filePath, name, 'function');
      if (seen.has(symbolId) || existingIds.has(symbolId)) continue;
      seen.add(symbolId);
      const byteStart = listStart + tokenMatch.index;
      const byteEnd = byteStart + name.length;
      symbols.push({
        symbolId,
        name,
        kind: 'function',
        fqn: name,
        signature: `.PHONY: ${name}`,
        byteStart,
        byteEnd,
        lineStart: lineAt(source, byteStart),
        lineEnd: lineAt(source, byteStart),
        metadata: { phony: true },
      });
    }
  }
  return symbols;
}

export const MakefileLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  async extractSymbols(
    filePath: string,
    content: Buffer,
  ): Promise<TraceMcpResult<FileParseResult>> {
    const result = await _plugin.extractSymbols(filePath, content);
    if (result.isErr()) return result;
    const parsed = result.value;
    const existingIds = new Set(
      parsed.symbols
        .filter((s): s is RawSymbol & { symbolId: string } => s.kind === 'function' && !!s.symbolId)
        .map((s) => s.symbolId),
    );
    const phonySymbols = extractPhonyTargets(filePath, content.toString('utf-8'), existingIds);
    return ok({ ...parsed, symbols: [...parsed.symbols, ...phonySymbols] });
  }
};
