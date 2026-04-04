/**
 * Shared utilities for regex-based language plugins.
 * Languages that don't use tree-sitter can use these helpers for symbol extraction.
 */
import { ok } from 'neverthrow';
import type { LanguagePlugin, PluginManifest, FileParseResult, RawSymbol, RawEdge, SymbolKind } from '../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../errors.js';

/** Get 1-based line number from byte offset. */
export function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

/** Get byte offset of end of line containing `offset`. */
export function lineEndOffset(source: string, offset: number): number {
  const nl = source.indexOf('\n', offset);
  return nl === -1 ? source.length : nl;
}

export function makeSymbolId(filePath: string, name: string, kind: SymbolKind, parentName?: string): string {
  if (parentName) return `${filePath}::${parentName}::${name}#${kind}`;
  return `${filePath}::${name}#${kind}`;
}

export function makeFqn(parts: string[]): string {
  return parts.filter(Boolean).join('.');
}

/** Extract first line of a match as signature, trimming trailing `{`. */
export function extractSignature(text: string, maxLen = 120): string {
  const firstLine = text.split('\n')[0].trim();
  const braceIdx = firstLine.lastIndexOf('{');
  const sig = braceIdx > 0 ? firstLine.substring(0, braceIdx).trim() : firstLine;
  return sig.length > maxLen ? sig.slice(0, maxLen) + '…' : sig;
}

export interface SymbolPattern {
  kind: SymbolKind;
  pattern: RegExp;
  /** Which capture group is the name (default 1). */
  nameGroup?: number;
  /** Which capture group has the parent scope name (optional). */
  parentGroup?: number;
  /** Extra metadata key-value to attach. */
  meta?: Record<string, unknown>;
}

export interface ImportPattern {
  pattern: RegExp;
  /** Which capture group is the module/path (default 1). */
  moduleGroup?: number;
}

export interface RegexLanguageConfig {
  name: string;
  language: string;
  extensions: string[];
  versions?: string[];
  priority?: number;
  symbolPatterns: SymbolPattern[];
  importPatterns?: ImportPattern[];
  /** Optional FQN separator (default '.') */
  fqnSep?: string;
}

/**
 * Create a regex-based LanguagePlugin from a config object.
 */
export function createRegexLanguagePlugin(config: RegexLanguageConfig): LanguagePlugin {
  return {
    manifest: {
      name: `${config.name}-language`,
      version: '1.0.0',
      priority: config.priority ?? 6,
    } as PluginManifest,
    supportedExtensions: config.extensions,
    supportedVersions: config.versions,
    extractSymbols(filePath: string, content: Buffer): TraceMcpResult<FileParseResult> {
      const source = content.toString('utf-8');
      const symbols: RawSymbol[] = [];
      const edges: RawEdge[] = [];
      const seen = new Set<string>();

      for (const sp of config.symbolPatterns) {
        // Ensure 'g' flag to prevent infinite loop in exec()
        const flags = sp.pattern.flags.includes('g') ? sp.pattern.flags : sp.pattern.flags + 'g';
        const re = new RegExp(sp.pattern.source, flags);
        let m: RegExpExecArray | null;
        while ((m = re.exec(source)) !== null) {
          const name = m[sp.nameGroup ?? 1];
          if (!name) continue;
          const parentName = sp.parentGroup ? m[sp.parentGroup] : undefined;
          const sid = makeSymbolId(filePath, name, sp.kind, parentName);
          if (seen.has(sid)) continue;
          seen.add(sid);

          symbols.push({
            symbolId: sid,
            name,
            kind: sp.kind,
            fqn: parentName ? makeFqn([parentName, name]) : name,
            parentSymbolId: parentName ? makeSymbolId(filePath, parentName, 'class') : undefined,
            signature: extractSignature(m[0]),
            byteStart: m.index,
            byteEnd: m.index + m[0].length,
            lineStart: lineAt(source, m.index),
            lineEnd: lineAt(source, m.index + m[0].length),
            metadata: sp.meta ? { ...sp.meta } : undefined,
          });
        }
      }

      if (config.importPatterns) {
        for (const ip of config.importPatterns) {
          const flags = ip.pattern.flags.includes('g') ? ip.pattern.flags : ip.pattern.flags + 'g';
          const re = new RegExp(ip.pattern.source, flags);
          let m: RegExpExecArray | null;
          while ((m = re.exec(source)) !== null) {
            const mod = m[ip.moduleGroup ?? 1];
            if (mod) {
              edges.push({ edgeType: 'imports', metadata: { module: mod } });
            }
          }
        }
      }

      return ok({
        language: config.language,
        status: 'ok',
        symbols,
        edges: edges.length > 0 ? edges : undefined,
      });
    },
  };
}
