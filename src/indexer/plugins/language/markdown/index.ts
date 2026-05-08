/**
 * Markdown Language Plugin — Knowledge Graph Intelligence.
 *
 * Models a markdown vault (Obsidian, Logseq, plain MD) as a graph:
 *   - one `note` symbol per file (kind: namespace, fqn: `note:<basename>`)
 *   - heading sections nested inside the note (kind: class)
 *   - tags as constants (kind: constant, fqn: `tag:<name>`) parented to their note
 *   - frontmatter parsed from YAML and stored on note metadata
 *   - wikilinks (`[[X]]`, `[[X#H]]`, `[[X|alias]]`, `![[X]]`) and markdown
 *     links to `.md` files captured on note metadata for Pass 2 resolution
 *
 * SymbolKind reuse rationale (v1): we map note→namespace, section→class,
 * tag→constant rather than introduce new kinds. New kinds ripple through DB
 * schema, search, scoring, and the desktop graph view; reuse keeps blast
 * radius minimal while preserving semantic richness via metadata flags.
 */

import path from 'node:path';
import { ok } from 'neverthrow';
import YAML from 'yaml';
import type { TraceMcpResult } from '../../../../errors.js';
import type {
  FileParseResult,
  LanguagePlugin,
  PluginManifest,
  RawSymbol,
} from '../../../../plugin-api/types.js';

export const NOTE_FQN_PREFIX = 'note:';
export const TAG_FQN_PREFIX = 'tag:';

export interface WikilinkRef {
  target: string;
  alias?: string;
  section?: string;
  /** Block reference id (Obsidian `[[X#^block-id]]`). */
  blockRef?: string;
  embed?: boolean;
  line: number;
  raw: string;
}

export interface MdLinkRef {
  target: string;
  text: string;
  line: number;
}

export interface NoteMetadata {
  note: true;
  frontmatter?: Record<string, unknown>;
  /** Obsidian-style alternative names for this note (frontmatter `aliases:`). */
  aliases?: string[];
  tags?: string[];
  wikilinks?: WikilinkRef[];
  mdLinks?: MdLinkRef[];
  /** Block-reference anchors defined inside this note (`text ^block-id`). */
  blockRefs?: string[];
  wordCount?: number;
  [key: string]: unknown;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
// [[Note]] | [[Note|alias]] | [[Note#Section]] | [[Note#^block-id]] | [[Note#Section|alias]] | leading ! for embed
const WIKILINK_RE = /(!?)\[\[([^\]\n|#]+)(?:#([^\]\n|]+))?(?:\|([^\]\n]+))?\]\]/g;
// #tag — Obsidian-style; first char letter; allows /, -, _ for nested tags
const TAG_RE = /(^|[\s(])#([A-Za-z][\w/-]*)/g;
// [text](target) — markdown link, excluding leading ! (image syntax)
const MD_LINK_RE = /(?<!!)\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
// Headings: # … ###### with optional trailing #s; ATX style only
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/gm;
// Fenced code blocks — strip before tag/wikilink scanning to avoid `# foo`
// inside code being treated as a tag
const FENCED_CODE_RE = /^```[\s\S]*?^```/gm;
// Obsidian block-reference anchor: `text ^block-id` at end of a paragraph/line
const BLOCK_REF_RE = /(?:^|\s)\^([A-Za-z0-9][\w-]*)\s*$/gm;

/** Normalise a wikilink target / basename for case- and unicode-insensitive lookup. */
export function normalizeKey(s: string): string {
  return s.normalize('NFC').toLowerCase();
}

function buildLineIndex(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineAtFast(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (lineStarts[mid] <= offset) lo = mid + 1;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Replace fenced code blocks with same-length whitespace so byte offsets
 * stay aligned but we don't pick up tags/wikilinks inside code.
 */
function maskCodeBlocks(source: string): string {
  return source.replace(FENCED_CODE_RE, (m) => m.replace(/[^\n]/g, ' '));
}

function parseFrontmatter(source: string): {
  frontmatter?: Record<string, unknown>;
  bodyOffset: number;
  body: string;
} {
  const fm = FRONTMATTER_RE.exec(source);
  if (!fm) return { bodyOffset: 0, body: source };
  let frontmatter: Record<string, unknown> | undefined;
  try {
    const parsed = YAML.parse(fm[1]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      frontmatter = parsed as Record<string, unknown>;
    }
  } catch {
    // malformed YAML — leave undefined, body starts after the closing fence
  }
  return {
    frontmatter,
    bodyOffset: fm[0].length,
    body: source.slice(fm[0].length),
  };
}

function collectFrontmatterTags(fm: Record<string, unknown> | undefined): string[] {
  if (!fm) return [];
  const out: string[] = [];
  const t = fm.tags;
  if (typeof t === 'string') {
    for (const part of t.split(/[\s,]+/)) if (part) out.push(part.replace(/^#/, ''));
  } else if (Array.isArray(t)) {
    for (const item of t) {
      if (typeof item === 'string') out.push(item.replace(/^#/, ''));
    }
  }
  return out;
}

function collectFrontmatterAliases(fm: Record<string, unknown> | undefined): string[] {
  if (!fm) return [];
  const out: string[] = [];
  const a = fm.aliases ?? fm.alias;
  if (typeof a === 'string') {
    out.push(a);
  } else if (Array.isArray(a)) {
    for (const item of a) {
      if (typeof item === 'string') out.push(item);
    }
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

function deriveSignature(fm: Record<string, unknown> | undefined, body: string): string {
  const title = typeof fm?.title === 'string' ? fm.title : undefined;
  if (title) return title.slice(0, 200);
  const firstHeading = /^#\s+(.+)/m.exec(body);
  if (firstHeading) return firstHeading[1].trim().slice(0, 200);
  const firstPara =
    body
      .trim()
      .split(/\n{2,}/)[0]
      ?.trim() ?? '';
  return firstPara.replace(/\s+/g, ' ').slice(0, 160);
}

export const MarkdownLanguagePlugin = class implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'markdown-language',
    version: '2.1.0',
    priority: 3,
  };

  // .qmd is Quarto, a Markdown variant that adds typed code chunks. The body
  // is plain Markdown plus fenced executable blocks, which our plugin already
  // tolerates — accept the extension here, matching graphify v0.7.9.
  supportedExtensions = ['.md', '.mdx', '.markdown', '.qmd'];
  supportedVersions = undefined;

  extractSymbols(filePath: string, content: Buffer): TraceMcpResult<FileParseResult> {
    const source = content.toString('utf-8');
    const basename = path.basename(filePath, path.extname(filePath));
    const lineStarts = buildLineIndex(source);

    const { frontmatter, bodyOffset, body } = parseFrontmatter(source);
    const scanBody = maskCodeBlocks(body);

    const fmTags = collectFrontmatterTags(frontmatter);
    const aliases = collectFrontmatterAliases(frontmatter);
    const inlineTags = new Set<string>();
    let tm: RegExpExecArray | null;
    TAG_RE.lastIndex = 0;
    while ((tm = TAG_RE.exec(scanBody)) !== null) {
      inlineTags.add(tm[2]);
    }
    const allTags = Array.from(new Set([...fmTags, ...inlineTags]));

    const wikilinks: WikilinkRef[] = [];
    WIKILINK_RE.lastIndex = 0;
    let wm: RegExpExecArray | null;
    while ((wm = WIKILINK_RE.exec(scanBody)) !== null) {
      const isEmbed = wm[1] === '!';
      const target = wm[2].trim();
      if (!target) continue;
      const rawSection = wm[3]?.trim() || undefined;
      const alias = wm[4]?.trim() || undefined;
      const offset = bodyOffset + wm.index;
      // [[X#^id]] is a block reference; everything else is a section name
      let section: string | undefined;
      let blockRef: string | undefined;
      if (rawSection) {
        if (rawSection.startsWith('^')) blockRef = rawSection.slice(1);
        else section = rawSection;
      }
      wikilinks.push({
        target,
        ...(alias && { alias }),
        ...(section && { section }),
        ...(blockRef && { blockRef }),
        ...(isEmbed && { embed: true }),
        line: lineAtFast(lineStarts, offset),
        raw: wm[0],
      });
    }

    const blockRefs: string[] = [];
    BLOCK_REF_RE.lastIndex = 0;
    let br: RegExpExecArray | null;
    const seenBlockRef = new Set<string>();
    while ((br = BLOCK_REF_RE.exec(scanBody)) !== null) {
      const id = br[1];
      if (!seenBlockRef.has(id)) {
        seenBlockRef.add(id);
        blockRefs.push(id);
      }
    }

    const mdLinks: MdLinkRef[] = [];
    MD_LINK_RE.lastIndex = 0;
    let lm: RegExpExecArray | null;
    while ((lm = MD_LINK_RE.exec(scanBody)) !== null) {
      const target = lm[2];
      const offset = bodyOffset + lm.index;
      mdLinks.push({
        text: lm[1],
        target,
        line: lineAtFast(lineStarts, offset),
      });
    }

    const wordCount = scanBody.split(/\s+/).filter(Boolean).length;
    const noteSymbolId = `${filePath}::${basename}#namespace`;
    const noteFqn = `${NOTE_FQN_PREFIX}${basename}`;

    const noteMetadata: NoteMetadata = {
      note: true,
      ...(frontmatter && { frontmatter }),
      ...(aliases.length > 0 && { aliases }),
      ...(allTags.length > 0 && { tags: allTags }),
      ...(wikilinks.length > 0 && { wikilinks }),
      ...(mdLinks.length > 0 && { mdLinks }),
      ...(blockRefs.length > 0 && { blockRefs }),
      wordCount,
    };

    const symbols: RawSymbol[] = [];
    symbols.push({
      symbolId: noteSymbolId,
      name: basename,
      kind: 'namespace',
      fqn: noteFqn,
      signature: deriveSignature(frontmatter, body),
      byteStart: 0,
      byteEnd: source.length,
      lineStart: 1,
      lineEnd: lineStarts.length,
      metadata: noteMetadata,
    });

    HEADING_RE.lastIndex = 0;
    const headings: { level: number; name: string; offset: number }[] = [];
    let hm: RegExpExecArray | null;
    while ((hm = HEADING_RE.exec(scanBody)) !== null) {
      headings.push({
        level: hm[1].length,
        name: hm[2].trim(),
        offset: bodyOffset + hm.index,
      });
    }
    const seenSection = new Set<string>();
    for (let i = 0; i < headings.length; i++) {
      const h = headings[i];
      if (!h.name) continue;
      const next = headings[i + 1];
      const sectionEnd = next ? next.offset : source.length;
      const dedupeKey = h.name.toLowerCase();
      if (seenSection.has(dedupeKey)) continue;
      seenSection.add(dedupeKey);
      symbols.push({
        symbolId: `${filePath}::${basename}#${h.name}#class`,
        name: h.name,
        kind: 'class',
        fqn: `${noteFqn}#${h.name}`,
        parentSymbolId: noteSymbolId,
        signature: `${'#'.repeat(h.level)} ${h.name}`,
        byteStart: h.offset,
        byteEnd: sectionEnd,
        lineStart: lineAtFast(lineStarts, h.offset),
        lineEnd: lineAtFast(lineStarts, sectionEnd),
        metadata: { heading: true, level: h.level },
      });
    }

    for (const tag of allTags) {
      symbols.push({
        symbolId: `${filePath}::${basename}::tag::${tag}#constant`,
        name: tag,
        kind: 'constant',
        fqn: `${TAG_FQN_PREFIX}${tag}`,
        parentSymbolId: noteSymbolId,
        signature: `#${tag}`,
        byteStart: 0,
        byteEnd: 0,
        lineStart: 1,
        lineEnd: 1,
        metadata: { tag: true, source: fmTags.includes(tag) ? 'frontmatter' : 'inline' },
      });
    }

    return ok({
      language: 'markdown',
      status: 'ok',
      symbols,
    });
  }
};
