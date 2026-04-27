/**
 * Multi-pass regex extraction engine (v2).
 *
 * Improvements over regex-base.ts:
 * - **Comment stripping**: removes comments/strings before matching → no false positives
 * - **Container patterns (Pass 1)**: class/module/struct/record → extracts block body
 * - **Member patterns (Pass 2)**: runs member patterns ONLY inside container bodies → correct parent-child
 * - **Scope styles**: braces `{}`, keyword-end (`begin`/`end`), or indent-based
 * - **Doc comment capture**: extracts doc comments preceding symbols as metadata
 * - **Multi-line signatures**: looks ahead to capture complete signatures
 */
import { ok } from 'neverthrow';
import type { TraceMcpResult } from '../../../errors.js';
import type {
  FileParseResult,
  LanguagePlugin,
  PluginManifest,
  RawEdge,
  RawSymbol,
  SymbolKind,
} from '../../../plugin-api/types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CommentStyle {
  /** Line-comment prefixes (e.g. ['//', '#']). */
  line: string[];
  /** Block-comment delimiter pairs (e.g. [['/*', '*\u200b/'], ['(*', '*)']]). */
  block: [string, string][];
  /** String delimiters to skip (e.g. ['"', "'"]). */
  strings?: string[];
}

export interface ScopeConfig {
  /** How the language delimits blocks. */
  style: 'braces' | 'keyword-end' | 'indent';
  /** For keyword-end: regex matching open-scope keywords (e.g. /\bbegin\b/gi). */
  openKeywords?: RegExp;
  /** For keyword-end: regex matching close-scope keywords (e.g. /\bend\b/gi). */
  endKeywords?: RegExp;
}

export interface MemberPattern {
  kind: SymbolKind;
  pattern: RegExp;
  nameGroup?: number;
  meta?: Record<string, unknown>;
}

export interface ContainerPattern {
  kind: SymbolKind;
  pattern: RegExp;
  nameGroup?: number;
  meta?: Record<string, unknown>;
  /** Patterns to extract inside this container's body. */
  memberPatterns: MemberPattern[];
}

export interface SymbolPatternV2 {
  kind: SymbolKind;
  pattern: RegExp;
  nameGroup?: number;
  parentGroup?: number;
  meta?: Record<string, unknown>;
  /** If true, only extract when inside a container (skip top-level). */
  memberOnly?: boolean;
}

export interface ImportPatternV2 {
  pattern: RegExp;
  moduleGroup?: number;
}

export interface DocCommentConfigV2 {
  /** Doc-comment line prefixes (e.g. ['///', '## ']). */
  linePrefix?: string[];
}

export interface MultiPassConfig {
  name: string;
  language: string;
  extensions: string[];
  versions?: string[];
  priority?: number;
  comments: CommentStyle;
  scope?: ScopeConfig;
  /** Pass 1: container-level patterns (classes, modules, etc.). */
  containerPatterns?: ContainerPattern[];
  /** Pass 2: top-level and member symbols. */
  symbolPatterns?: SymbolPatternV2[];
  /** Import/dependency edge patterns. */
  importPatterns?: ImportPatternV2[];
  /** Doc comment configuration. */
  docComments?: DocCommentConfigV2;
  /** FQN separator (default '.'). */
  fqnSep?: string;
}

// ---------------------------------------------------------------------------
// Line index (binary search for O(log n) line lookups)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Comment/string stripping
// ---------------------------------------------------------------------------

/**
 * Replace all comments and string literals with spaces (preserving offsets).
 * This prevents regex patterns from matching inside comments/strings.
 */
const DEFAULT_COMMENT_STYLE: CommentStyle = {
  line: ['//'],
  block: [['/*', '*/']],
  strings: ['"', "'"],
};

export function stripCommentsAndStrings(
  source: string,
  style: CommentStyle = DEFAULT_COMMENT_STYLE,
): string {
  const chars = [...source];
  const len = source.length;
  let i = 0;

  while (i < len) {
    // Check string delimiters
    if (style.strings) {
      let matched = false;
      for (const delim of style.strings) {
        if (source.startsWith(delim, i)) {
          const start = i;
          i += delim.length;
          // Find closing delimiter (handle escape with backslash)
          while (i < len) {
            if (source[i] === '\\') {
              i += 2;
              continue;
            }
            if (source.startsWith(delim, i)) {
              i += delim.length;
              break;
            }
            i++;
          }
          // Blank out the string (keep newlines for line counting)
          for (let j = start; j < i && j < len; j++) {
            if (chars[j] !== '\n') chars[j] = ' ';
          }
          matched = true;
          break;
        }
      }
      if (matched) continue;
    }

    // Check block comments
    let blockMatched = false;
    for (const [open, close] of style.block) {
      if (source.startsWith(open, i)) {
        const start = i;
        i += open.length;
        const endIdx = source.indexOf(close, i);
        i = endIdx === -1 ? len : endIdx + close.length;
        for (let j = start; j < i && j < len; j++) {
          if (chars[j] !== '\n') chars[j] = ' ';
        }
        blockMatched = true;
        break;
      }
    }
    if (blockMatched) continue;

    // Check line comments
    let lineMatched = false;
    for (const prefix of style.line) {
      if (source.startsWith(prefix, i)) {
        const start = i;
        while (i < len && source[i] !== '\n') i++;
        for (let j = start; j < i; j++) chars[j] = ' ';
        lineMatched = true;
        break;
      }
    }
    if (lineMatched) continue;

    i++;
  }

  return chars.join('');
}

// ---------------------------------------------------------------------------
// Scope / block extraction
// ---------------------------------------------------------------------------

/**
 * Find the end of a block starting at `openOffset`.
 * Returns the byte offset just after the closing delimiter.
 */
function findBlockEnd(
  stripped: string,
  openOffset: number,
  scopeConfig: ScopeConfig | undefined,
): number {
  const style = scopeConfig?.style ?? 'braces';

  if (style === 'braces') {
    return findBraceBlockEnd(stripped, openOffset);
  }
  if (style === 'keyword-end') {
    return findKeywordBlockEnd(stripped, openOffset, scopeConfig!);
  }
  return findIndentBlockEnd(stripped, openOffset);
}

function findBraceBlockEnd(source: string, start: number): number {
  let depth = 0;
  let foundOpen = false;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') {
      depth++;
      foundOpen = true;
    } else if (source[i] === '}') {
      depth--;
      if (foundOpen && depth === 0) return i + 1;
    }
  }
  return source.length;
}

function findKeywordBlockEnd(source: string, start: number, config: ScopeConfig): number {
  const { openKeywords, endKeywords } = config;
  if (!openKeywords || !endKeywords) return source.length;

  let depth = 0;
  // Scan from start
  const text = source.slice(start);
  const openRe = new RegExp(openKeywords.source, `${openKeywords.flags.replace('g', '')}g`);
  const endRe = new RegExp(endKeywords.source, `${endKeywords.flags.replace('g', '')}g`);

  // Collect all open/close keyword positions
  const events: Array<{ offset: number; type: 'open' | 'close' }> = [];

  let m: RegExpExecArray | null;
  while ((m = openRe.exec(text)) !== null) {
    events.push({ offset: m.index, type: 'open' });
  }
  while ((m = endRe.exec(text)) !== null) {
    events.push({ offset: m.index, type: 'close' });
  }
  events.sort((a, b) => a.offset - b.offset);

  for (const ev of events) {
    if (ev.type === 'open') depth++;
    else {
      depth--;
      if (depth <= 0) return start + ev.offset + 3; // 'end'.length
    }
  }

  return source.length;
}

function findIndentBlockEnd(source: string, start: number): number {
  const lineStart = source.lastIndexOf('\n', start) + 1;
  const startIndent = start - lineStart;

  let pos = source.indexOf('\n', start);
  if (pos === -1) return source.length;
  pos++;

  while (pos < source.length) {
    const nextNl = source.indexOf('\n', pos);
    const lineEnd = nextNl === -1 ? source.length : nextNl;
    const line = source.substring(pos, lineEnd);
    if (line.trim().length > 0) {
      const indent = line.length - line.trimStart().length;
      if (indent <= startIndent) return pos;
    }
    pos = lineEnd + 1;
  }
  return source.length;
}

// ---------------------------------------------------------------------------
// Doc comment extraction
// ---------------------------------------------------------------------------

function extractDocComment(
  originalSource: string,
  offset: number,
  lineStarts: number[],
  config: DocCommentConfigV2 | undefined,
): string | undefined {
  if (!config?.linePrefix?.length) return undefined;

  const symbolLine = lineAtFast(lineStarts, offset);
  const lines: string[] = [];

  for (let ln = symbolLine - 2; ln >= 0; ln--) {
    const lineStartOff = lineStarts[ln];
    const lineEndOff = ln + 1 < lineStarts.length ? lineStarts[ln + 1] - 1 : originalSource.length;
    const lineText = originalSource.substring(lineStartOff, lineEndOff).trimEnd();

    if (lineText.trim() === '' && lines.length === 0) continue;
    if (lineText.trim() === '') break;

    let matched = false;
    for (const prefix of config.linePrefix) {
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

// ---------------------------------------------------------------------------
// Signature helpers
// ---------------------------------------------------------------------------

function extractSignature(text: string, maxLen = 120): string {
  const firstLine = text.split('\n')[0].trim();
  const braceIdx = firstLine.lastIndexOf('{');
  const sig = braceIdx > 0 ? firstLine.substring(0, braceIdx).trim() : firstLine;
  return sig.length > maxLen ? `${sig.slice(0, maxLen)}…` : sig;
}

function makeSymbolId(
  filePath: string,
  name: string,
  kind: SymbolKind,
  parentName?: string,
): string {
  if (parentName) return `${filePath}::${parentName}::${name}#${kind}`;
  return `${filePath}::${name}#${kind}`;
}

// ---------------------------------------------------------------------------
// Main factory
// ---------------------------------------------------------------------------

export function createMultiPassPlugin(config: MultiPassConfig): LanguagePlugin {
  return {
    manifest: {
      name: `${config.name}-language`,
      version: '2.0.0',
      priority: config.priority ?? 6,
    } as PluginManifest,
    supportedExtensions: config.extensions,
    supportedVersions: config.versions,

    extractSymbols(filePath: string, content: Buffer): TraceMcpResult<FileParseResult> {
      const originalSource = content.toString('utf-8');
      const stripped = stripCommentsAndStrings(originalSource, config.comments);
      const lineStarts = buildLineIndex(originalSource);

      const symbols: RawSymbol[] = [];
      const edges: RawEdge[] = [];
      const seen = new Set<string>();

      // Track container ranges for memberOnly filtering
      const containerRanges: Array<{ name: string; kind: SymbolKind; start: number; end: number }> =
        [];

      // ── Pass 1: Containers ───────────────────────────────────────────
      if (config.containerPatterns) {
        for (const cp of config.containerPatterns) {
          const flags = cp.pattern.flags.includes('g') ? cp.pattern.flags : `${cp.pattern.flags}g`;
          const re = new RegExp(cp.pattern.source, flags);
          let m: RegExpExecArray | null;

          while ((m = re.exec(stripped)) !== null) {
            const name = m[cp.nameGroup ?? 1];
            if (!name) continue;

            const sid = makeSymbolId(filePath, name, cp.kind);
            if (seen.has(sid)) continue;
            seen.add(sid);

            // Find block extent — start from the opening delimiter within the match
            // For brace-based scoping, find the { within the match text
            const matchEnd = m.index + m[0].length;
            const braceInMatch = stripped.lastIndexOf('{', matchEnd - 1);
            const scopeStart = braceInMatch >= m.index ? braceInMatch : matchEnd;
            const blockEnd = findBlockEnd(stripped, scopeStart, config.scope);
            containerRanges.push({ name, kind: cp.kind, start: m.index, end: blockEnd });

            // Doc comment
            const doc = extractDocComment(originalSource, m.index, lineStarts, config.docComments);
            const meta = { ...cp.meta };
            if (doc) meta.doc = doc;
            const hasMetadata = Object.keys(meta).length > 0;

            symbols.push({
              symbolId: sid,
              name,
              kind: cp.kind,
              signature: extractSignature(originalSource.substring(m.index, m.index + 200)),
              byteStart: m.index,
              byteEnd: blockEnd,
              lineStart: lineAtFast(lineStarts, m.index),
              lineEnd: lineAtFast(lineStarts, blockEnd),
              metadata: hasMetadata ? meta : undefined,
            });

            // ── Pass 2: Members inside this container ────────────────
            const bodyStart = m.index + m[0].length;
            const bodyText = stripped.substring(bodyStart, blockEnd);
            const bodyOriginal = originalSource.substring(bodyStart, blockEnd);

            for (const mp of cp.memberPatterns ?? []) {
              const mFlags = mp.pattern.flags.includes('g')
                ? mp.pattern.flags
                : `${mp.pattern.flags}g`;
              const mRe = new RegExp(mp.pattern.source, mFlags);
              let mm: RegExpExecArray | null;

              while ((mm = mRe.exec(bodyText)) !== null) {
                const memberName = mm[mp.nameGroup ?? 1];
                if (!memberName) continue;

                const mSid = makeSymbolId(filePath, memberName, mp.kind, name);
                if (seen.has(mSid)) continue;
                seen.add(mSid);

                const absOffset = bodyStart + mm.index;
                const memberDoc = extractDocComment(
                  originalSource,
                  absOffset,
                  lineStarts,
                  config.docComments,
                );
                const memberMeta = { ...mp.meta };
                if (memberDoc) memberMeta.doc = memberDoc;
                const hasMemberMeta = Object.keys(memberMeta).length > 0;

                symbols.push({
                  symbolId: mSid,
                  name: memberName,
                  kind: mp.kind,
                  fqn: `${name}${config.fqnSep ?? '.'}${memberName}`,
                  parentSymbolId: sid,
                  signature: extractSignature(bodyOriginal.substring(mm.index, mm.index + 200)),
                  byteStart: absOffset,
                  byteEnd: absOffset + mm[0].length,
                  lineStart: lineAtFast(lineStarts, absOffset),
                  lineEnd: lineAtFast(lineStarts, absOffset + mm[0].length),
                  metadata: hasMemberMeta ? memberMeta : undefined,
                });
              }
            }
          }
        }
      }

      // ── Pass 3: Top-level symbols ──────────────────────────────────
      if (config.symbolPatterns) {
        for (const sp of config.symbolPatterns) {
          const flags = sp.pattern.flags.includes('g') ? sp.pattern.flags : `${sp.pattern.flags}g`;
          const re = new RegExp(sp.pattern.source, flags);
          let m: RegExpExecArray | null;

          while ((m = re.exec(stripped)) !== null) {
            const name = m[sp.nameGroup ?? 1];
            if (!name) continue;

            // Check if inside a container
            const insideContainer = containerRanges.find(
              (c) => m!.index >= c.start && m!.index < c.end,
            );

            // memberOnly patterns only match inside containers
            if (sp.memberOnly && !insideContainer) continue;

            // Skip if already extracted as a member in pass 2
            const parentName = sp.parentGroup ? m[sp.parentGroup] : insideContainer?.name;
            const sid = makeSymbolId(filePath, name, sp.kind, parentName);
            if (seen.has(sid)) continue;
            seen.add(sid);

            const doc = extractDocComment(originalSource, m.index, lineStarts, config.docComments);
            const meta = { ...sp.meta };
            if (doc) meta.doc = doc;
            const hasMetadata = Object.keys(meta).length > 0;

            symbols.push({
              symbolId: sid,
              name,
              kind: sp.kind,
              fqn: parentName ? `${parentName}${config.fqnSep ?? '.'}${name}` : name,
              parentSymbolId: parentName
                ? makeSymbolId(filePath, parentName, insideContainer?.kind ?? 'class')
                : undefined,
              signature: extractSignature(originalSource.substring(m.index, m.index + 200)),
              byteStart: m.index,
              byteEnd: m.index + m[0].length,
              lineStart: lineAtFast(lineStarts, m.index),
              lineEnd: lineAtFast(lineStarts, m.index + m[0].length),
              metadata: hasMetadata ? meta : undefined,
            });
          }
        }
      }

      // ── Pass 4: Import edges (deduplicated) ─────────────────────────
      if (config.importPatterns) {
        const seenEdges = new Set<string>();
        for (const ip of config.importPatterns) {
          const flags = ip.pattern.flags.includes('g') ? ip.pattern.flags : `${ip.pattern.flags}g`;
          const re = new RegExp(ip.pattern.source, flags);
          let m: RegExpExecArray | null;

          while ((m = re.exec(stripped)) !== null) {
            const mod = m[ip.moduleGroup ?? 1];
            if (mod && !seenEdges.has(mod)) {
              seenEdges.add(mod);
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
