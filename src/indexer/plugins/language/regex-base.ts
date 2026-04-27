/**
 * Shared utilities for regex-based language plugins.
 * Languages that don't use tree-sitter can use these helpers for symbol extraction.
 */
import { ok } from 'neverthrow';
import type {
  LanguagePlugin,
  PluginManifest,
  FileParseResult,
  RawSymbol,
  RawEdge,
  SymbolKind,
} from '../../../plugin-api/types.js';
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
function _lineEndOffset(source: string, offset: number): number {
  const nl = source.indexOf('\n', offset);
  return nl === -1 ? source.length : nl;
}

export function makeSymbolId(
  filePath: string,
  name: string,
  kind: SymbolKind,
  parentName?: string,
): string {
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
  /** Marks this pattern as scope-defining (for scope tracking). */
  isScope?: boolean;
}

interface ImportPattern {
  pattern: RegExp;
  /** Which capture group is the module/path (default 1). */
  moduleGroup?: number;
}

export interface DocCommentConfig {
  linePrefix?: string[];
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
  /** Doc comment configuration for this language. */
  docComments?: DocCommentConfig;
  /** Enable brace-based scope tracking for parent-child. */
  scopeTracking?: boolean;
  /** Enable multi-line signature capture (up to 5 lines lookahead). */
  multiLineSignatures?: boolean;
}

// Binary-search line index
function buildLineIndex(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineAtFast(lineStarts: number[], offset: number): number {
  let lo = 0,
    hi = lineStarts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (lineStarts[mid] <= offset) lo = mid + 1;
    else hi = mid - 1;
  }
  return lo;
}

// Doc comment extraction
function extractDocComment(
  source: string,
  offset: number,
  lineStarts: number[],
  config: DocCommentConfig | undefined,
): string | undefined {
  if (!config?.linePrefix?.length) return undefined;
  const symbolLine = lineAtFast(lineStarts, offset);
  const lines: string[] = [];
  for (let ln = symbolLine - 2; ln >= 0; ln--) {
    const lineStartOff = lineStarts[ln];
    const lineEndOff = ln + 1 < lineStarts.length ? lineStarts[ln + 1] - 1 : source.length;
    const lineText = source.substring(lineStartOff, lineEndOff).trimEnd();
    if (lineText.trim() === '' && lines.length === 0) continue;
    if (lineText.trim() === '') break;
    let matched = false;
    for (const prefix of config.linePrefix!) {
      const trimmed = lineText.trimStart();
      if (trimmed.startsWith(prefix)) {
        lines.unshift(trimmed.slice(prefix.length).trim());
        matched = true;
        break;
      }
    }
    if (!matched) break;
  }
  if (lines.length === 0) return undefined;
  const doc = lines.join('\n').trim();
  return doc.length > 0 ? doc.slice(0, 500) : undefined;
}

// Multi-line signature capture
function extractFullSignature(
  source: string,
  matchStart: number,
  matchText: string,
  maxLen = 200,
): string {
  const firstLine = matchText.split('\n')[0].trim();
  const countChar = (s: string, open: string, close: string) => {
    let d = 0;
    for (const c of s) {
      if (c === open) d++;
      else if (c === close) d--;
    }
    return d;
  };
  if (countChar(firstLine, '(', ')') === 0 && countChar(firstLine, '[', ']') === 0) {
    return extractSignature(matchText, maxLen);
  }
  let text = firstLine;
  let pos = source.indexOf('\n', matchStart);
  let extra = 0;
  while (pos !== -1 && pos < source.length && extra < 5) {
    const nextNl = source.indexOf('\n', pos + 1);
    const lineEnd = nextNl === -1 ? source.length : nextNl;
    const line = source.substring(pos + 1, lineEnd).trim();
    if (!line) break;
    text += ' ' + line;
    extra++;
    if (countChar(text, '(', ')') === 0 && countChar(text, '[', ']') === 0) break;
    pos = nextNl;
  }
  const braceIdx = text.lastIndexOf('{');
  const sig = braceIdx > 0 ? text.substring(0, braceIdx).trim() : text;
  const cleaned = sig.replace(/\s+/g, ' ');
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + '...' : cleaned;
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
      const lineStarts = buildLineIndex(source);

      // Scope tracking: collect scope-defining symbols first
      const scopes: Array<{ name: string; kind: SymbolKind; start: number; end: number }> = [];
      if (config.scopeTracking) {
        for (const sp of config.symbolPatterns) {
          if (!sp.isScope) continue;
          const flags = sp.pattern.flags.includes('g') ? sp.pattern.flags : sp.pattern.flags + 'g';
          const re = new RegExp(sp.pattern.source, flags);
          let m: RegExpExecArray | null;
          while ((m = re.exec(source)) !== null) {
            const name = m[sp.nameGroup ?? 1];
            if (!name) continue;
            // Find block end by indent (for indent-based languages like Nim)
            let pos = source.indexOf('\n', m.index);
            if (pos === -1) {
              scopes.push({ name, kind: sp.kind, start: m.index, end: source.length });
              continue;
            }
            const lineStart = source.lastIndexOf('\n', m.index) + 1;
            const startIndent = m.index - lineStart;
            pos++;
            let blockEnd = source.length;
            while (pos < source.length) {
              const nextNl = source.indexOf('\n', pos);
              const lineEnd = nextNl === -1 ? source.length : nextNl;
              const line = source.substring(pos, lineEnd);
              if (line.trim().length > 0) {
                const indent = line.length - line.trimStart().length;
                if (indent <= startIndent) {
                  blockEnd = pos;
                  break;
                }
              }
              pos = lineEnd + 1;
            }
            scopes.push({ name, kind: sp.kind, start: m.index, end: blockEnd });
          }
        }
        scopes.sort((a, b) => a.start - b.start);
      }

      for (const sp of config.symbolPatterns) {
        const flags = sp.pattern.flags.includes('g') ? sp.pattern.flags : sp.pattern.flags + 'g';
        const re = new RegExp(sp.pattern.source, flags);
        let m: RegExpExecArray | null;
        while ((m = re.exec(source)) !== null) {
          const name = m[sp.nameGroup ?? 1];
          if (!name) continue;
          let parentName = sp.parentGroup ? m[sp.parentGroup] : undefined;

          // Auto-detect parent from scope tracking
          if (!parentName && config.scopeTracking && !sp.isScope) {
            for (let i = scopes.length - 1; i >= 0; i--) {
              if (m.index > scopes[i].start && m.index < scopes[i].end) {
                parentName = scopes[i].name;
                break;
              }
            }
          }

          const sid = makeSymbolId(filePath, name, sp.kind, parentName);
          if (seen.has(sid)) continue;
          seen.add(sid);

          const signature = config.multiLineSignatures
            ? extractFullSignature(source, m.index, m[0])
            : extractSignature(m[0]);

          const doc = extractDocComment(source, m.index, lineStarts, config.docComments);
          const meta = sp.meta ? { ...sp.meta } : {};
          if (doc) meta.doc = doc;
          const hasMetadata = Object.keys(meta).length > 0;

          const parentKind = parentName
            ? (scopes.find((s) => s.name === parentName)?.kind ?? 'class')
            : 'class';

          symbols.push({
            symbolId: sid,
            name,
            kind: sp.kind,
            fqn: parentName ? makeFqn([parentName, name]) : name,
            parentSymbolId: parentName ? makeSymbolId(filePath, parentName, parentKind) : undefined,
            signature,
            byteStart: m.index,
            byteEnd: m.index + m[0].length,
            lineStart: lineAtFast(lineStarts, m.index),
            lineEnd: lineAtFast(lineStarts, m.index + m[0].length),
            metadata: hasMetadata ? meta : undefined,
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
