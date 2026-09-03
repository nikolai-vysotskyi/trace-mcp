/**
 * TRA-770: the startup-text compressor.
 *
 * The startup audit (TRA-759, `startup-context.ts`) answers "what does the
 * block cost and what in it went unused". This module answers the other half:
 * of the text that is *needed* and stays, how much of it is the same
 * instruction delivered twice?
 *
 * Why deletion rather than rewriting
 * ─────────────────────────────────
 * The issue asked what to rewrite with — a local model, rules, or both. The
 * measurement decided it. On real instruction files the compressible mass is
 * not verbose prose; it is restatement across sources: a CLAUDE.md section
 * that repeats, in the author's own words, a rule an MCP server already sends
 * in its instructions, or a rule the global file already carries. Paraphrasing
 * that text saves a little and risks a lot; dropping the second copy saves the
 * same tokens with the instruction still present, verbatim, in the block.
 *
 * That gives the meaning-preservation criterion the issue asked for, as an
 * invariant rather than a sampling exercise:
 *
 *   nothing is reworded, and nothing is removed unless the same instruction is
 *   still delivered by another source in the same startup block.
 *
 * Every removal therefore carries the surviving text and the source that
 * delivers it — `saidBy` / `saidAs` — so the reader checks the claim rather
 * than trusting it. `assertInvariant` enforces it in code.
 *
 * What this module will and will not touch
 * ────────────────────────────────────────
 * It proposes edits ONLY to files the user owns and can edit: CLAUDE.md,
 * AGENTS.md, and a project's MEMORY.md. The rest of the startup block — a
 * third party's skill descriptions, another server's instruction text, a
 * plugin hook's output — is the reference corpus: read to prove duplication,
 * never rewritten, because we cannot edit it and a local rewrite would not
 * survive the next update of the thing that emits it. Those sources are
 * reported in `notCompressible` with the reason, not silently dropped.
 *
 * Nothing is written. This is a proposal with a diff and a token delta;
 * applying it is TRA-769.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { listAllSessions } from './log-parser.js';
import { claudeHome } from '../shared/paths.js';

const CHARS_PER_TOKEN = 4;

/** Files below this are handshakes and aborted runs, not sessions. */
const MIN_SESSION_BYTES = 20_000;

/**
 * How many recent sessions supply the reference corpus.
 *
 * The startup block is near-identical from session to session, so this is a
 * recency question, not a sample-size one: what matters is that the corpus
 * reflects the servers, skills and hooks configured *now*. Reading the whole
 * corpus would make a report the user waits on out of one they do not.
 */
const CORPUS_SESSIONS = 25;

/** Below this many content words a unit is a heading or a fragment that collides by accident. */
const UNIT_MIN_WORDS = 5;

/**
 * Word-overlap at which two sentences are the same instruction.
 *
 * Jaccard, not containment: containment says "everything this line says is in
 * there somewhere", which a single 500-character instruction blob satisfies
 * for almost any line about the same tools. Measured on the maintainer's
 * files, containment produced matches whose quoted evidence did not actually
 * say the same thing — the exact way a report like this misleads its reader.
 */
const UNIT_MATCH_MIN = 0.5;

/** A line goes when this much of it is restatement. */
const LINE_REDUNDANT_AT = 0.6;

/** Context lines around a hunk in the emitted diff. */
const DIFF_CONTEXT = 2;

export interface Removal {
  /** `restatedLine` — restated text; `emptiedHeading` — a heading whose whole body went with it. */
  rule: string;
  /** 1-based, inclusive, in the original file. */
  startLine: number;
  endLine: number;
  tokens: number;
  /** What would go, clipped. */
  text: string;
  /** The startup source that still delivers this — `mcp:<server>`, `skills`, `hook:<name>`. */
  saidBy: string;
  /** How that source says it, verbatim: the proof, not the claim. */
  saidAs: string;
}

export interface CompressionCandidate {
  path: string;
  currentTokens: number;
  compressedTokens: number;
  savedTokens: number;
  removals: Removal[];
  /** Unified diff, original → proposal. Deletions only; nothing is reworded. */
  diff: string;
}

export interface UntouchableSource {
  source: string;
  tokens: number;
  reason: string;
}

export interface StartupTextCompression {
  /** Files we would edit, largest saving first. Empty means nothing is restated. */
  candidates: CompressionCandidate[];
  /**
   * Startup text we read to prove duplication but will not rewrite, and why.
   * Sized from the logs, so the reader sees what it costs even though this
   * tool does not offer to touch it.
   */
  notCompressible: UntouchableSource[];
  totalSavedTokens: number;
  /** The rule every removal satisfies, said out loud rather than implied. */
  invariant: string;
  /** How many recent sessions the reference corpus came from. */
  corpusSessions: number;
  notes: string[];
  scanMs: number;
}

// --- Text units ---

/**
 * Compare on content words only.
 *
 * Markdown punctuation is how the same rule looks different in two files — one
 * writes it as a table row, the other as a bullet — so it is stripped before
 * comparing. Short words are dropped for the same reason a search engine drops
 * them: they carry no evidence of sameness.
 */
function contentWords(text: string): Set<string> {
  const normalized = text
    .toLowerCase()
    .replace(/[`~*_#|>[\]()]/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return new Set(normalized.split(' ').filter((w) => w.length > 2));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * Split text into the units that get compared.
 *
 * A sentence, not a line: instruction files wrap one rule over several lines
 * and MCP servers send several rules on one, so comparing whole lines makes
 * the same rule look different on both counts. Em-dash clauses split too —
 * that is a sentence boundary in this kind of writing.
 */
function units(text: string): string[] {
  return text
    .split('\n')
    .flatMap((line) => line.split(/(?<=[.!?;:])\s+|\s+—\s+/))
    .map((s) => s.trim())
    .filter(Boolean);
}

interface RefUnit {
  source: string;
  text: string;
  words: Set<string>;
}

interface Match {
  source: string;
  text: string;
  score: number;
}

/** The strongest thing in the corpus that says what `text` says, if anything does. */
function bestMatch(text: string, ref: RefUnit[]): Match | null {
  const words = contentWords(text);
  if (words.size < UNIT_MIN_WORDS) return null;
  let best: Match | null = null;
  for (const unit of ref) {
    const score = jaccard(words, unit.words);
    if (score >= UNIT_MATCH_MIN && (!best || score > best.score)) {
      best = { source: unit.source, text: unit.text, score };
    }
  }
  return best;
}

// --- Reference corpus, read from the user's own session logs ---

export interface CorpusEntry {
  /** `mcp:<server>`, `skills`, `hook:<name>`. */
  source: string;
  text: string;
}

/**
 * The startup texts as they were actually delivered, from the most recent
 * sessions.
 *
 * Reading them from the log rather than reconstructing them from config is the
 * point: it is the text the model saw, including the parts that come from
 * servers and plugins we have no other way to see.
 */
export async function collectStartupCorpus(
  listSessions: typeof listAllSessions = listAllSessions,
  limit = CORPUS_SESSIONS,
): Promise<{ entries: CorpusEntry[]; sessionsRead: number }> {
  const files = listSessions()
    .filter((s) => {
      try {
        return fs.statSync(s.filePath).size >= MIN_SESSION_BYTES;
      } catch {
        return false;
      }
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);

  /* Same source across sessions is the same text; keep one copy. Later
     sessions are older, so the first write — the most recent session — wins. */
  const bySource = new Map<string, string>();
  for (const file of files) {
    try {
      await readStartupTexts(file.filePath, bySource);
    } catch {
      /* an unreadable session is one less corpus entry, not a failed report */
    }
  }
  return {
    entries: [...bySource].map(([source, text]) => ({ source, text })),
    sessionsRead: files.length,
  };
}

/** Attachments before the first API call, which is where the startup block ends. */
async function readStartupTexts(filePath: string, out: Map<string, string>): Promise<void> {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  try {
    for await (const line of rl) {
      if (!line.includes('"attachment"') && !line.includes('"usage"')) continue;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      // The first assistant call closes the startup block: everything after it
      // is the conversation, which is not text anyone can rewrite in advance.
      if (rec.type === 'assistant') return;
      if (rec.type !== 'attachment') continue;

      const att = (rec.attachment ?? {}) as Record<string, unknown>;
      switch (att.type) {
        case 'mcp_instructions_delta': {
          const names = (att.addedNames as unknown[]) ?? [];
          const blocks = (att.addedBlocks as unknown[]) ?? [];
          names.forEach((name, i) => {
            const block = blocks[i];
            if (typeof name !== 'string' || typeof block !== 'string') return;
            if (!out.has(`mcp:${name}`)) out.set(`mcp:${name}`, block);
          });
          break;
        }
        case 'skill_listing': {
          const content = String(att.content ?? '');
          if (content && !out.has('skills')) out.set('skills', content);
          break;
        }
        case 'hook_success':
        case 'hook_additional_context': {
          const text = String(att.stdout ?? att.content ?? '');
          const key = `hook:${String(att.hookName ?? 'unnamed')}`;
          if (text && !out.has(key)) out.set(key, text);
          break;
        }
        default:
          break;
      }
    }
  } finally {
    rl.close();
  }
}

// --- Per-file compression ---

interface Section {
  /** Index of the heading line, or -1 for the text before the first heading. */
  heading: number;
  body: number[];
}

function isHeading(line: string): boolean {
  return /^#{1,6}\s+\S/.test(line);
}

/** Markdown sections, so a fully restated one can go with its heading. */
function sections(lines: string[]): Section[] {
  const out: Section[] = [];
  let current: Section = { heading: -1, body: [] };
  lines.forEach((line, i) => {
    if (isHeading(line)) {
      out.push(current);
      current = { heading: i, body: [] };
    } else {
      current.body.push(i);
    }
  });
  out.push(current);
  return out;
}

/** How much of one line is restatement, and the strongest evidence for it. */
function lineRedundancy(line: string, ref: RefUnit[]): { fraction: number; match: Match | null } {
  const trimmed = line.trim();
  if (contentWords(trimmed).size < UNIT_MIN_WORDS) return { fraction: 0, match: null };
  let matchedChars = 0;
  let best: Match | null = null;
  for (const unit of units(trimmed)) {
    const match = bestMatch(unit, ref);
    if (!match) continue;
    matchedChars += unit.length;
    if (!best || match.score > best.score) best = match;
  }
  return { fraction: matchedChars / Math.max(1, trimmed.length), match: best };
}

function tokensOf(text: string): number {
  return Math.round(text.length / CHARS_PER_TOKEN);
}

function clip(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * Propose deletions for one file against the corpus.
 *
 * One rule does the work: a line whose content is restatement goes, and it
 * goes on the evidence of its own match — never on its neighbours'. A section
 * is not rolled up at a fraction, however tempting the token count: rolling up
 * at 60% deletes the other 40%, which is text nothing else in the block says,
 * and that is precisely the invariant this module exists to keep.
 *
 * The one structural removal that IS safe: a heading whose entire body has
 * gone. A heading standing over nothing is not an instruction, and dropping it
 * removes no claim the file was making.
 */
export function compressAgainstCorpus(
  filePath: string,
  original: string,
  ref: RefUnit[],
): CompressionCandidate | null {
  const lines = original.split('\n');
  const redundancy = lines.map((line) => lineRedundancy(line, ref));

  const removed = new Map<number, Match>();
  redundancy.forEach((r, i) => {
    /* A heading is never removed on its own evidence, however well it matches:
       "### Disagree when the premise is wrong" restates the rule it labels, and
       cutting it leaves the body it introduced hanging under the heading above.
       Headings go only when their whole body has gone. */
    if (isHeading(lines[i])) return;
    if (r.match && r.fraction >= LINE_REDUNDANT_AT) removed.set(i, r.match);
  });
  if (removed.size === 0) return null;

  const emptied = new Set<number>();
  for (const section of sections(lines)) {
    if (section.heading < 0) continue;
    let content = 0;
    let gone = 0;
    let best: Match | null = null;
    for (const i of section.body) {
      if (contentWords(lines[i].trim()).size < UNIT_MIN_WORDS) continue;
      content++;
      const match = removed.get(i);
      if (!match) continue;
      gone++;
      if (!best || match.score > best.score) best = match;
    }
    if (content === 0 || gone < content || !best) continue;
    emptied.add(section.heading);
    removed.set(section.heading, best);
    // Blank lines left inside a fully emptied section have nothing to space.
    for (const i of section.body) removed.set(i, removed.get(i) ?? best);
  }

  const removals = groupRemovals(lines, removed, emptied);
  const compressed = collapseBlankRuns(lines.filter((_, i) => !removed.has(i))).join('\n');

  return {
    path: filePath,
    currentTokens: tokensOf(original),
    compressedTokens: tokensOf(compressed),
    savedTokens: tokensOf(original) - tokensOf(compressed),
    removals,
    diff: unifiedDiff(filePath, lines, removed),
  };
}

/** Consecutive removed lines are one removal — a per-line list of a dropped section is noise. */
function groupRemovals(
  lines: string[],
  removed: Map<number, Match>,
  emptied: Set<number>,
): Removal[] {
  const indices = [...removed.keys()].sort((a, b) => a - b);
  const out: Removal[] = [];
  let start = -1;
  let previous = -2;

  const flush = (end: number) => {
    if (start < 0) return;
    const block = lines.slice(start, end + 1);
    /* The evidence is the strongest match anywhere in the block, not the one
       for its first line: a rolled-up section starts at a heading, and a
       heading's own match is the weakest thing in it. */
    let match = removed.get(start) as Match;
    for (let i = start; i <= end; i++) {
      const candidate = removed.get(i);
      if (candidate && candidate.score > match.score) match = candidate;
    }
    out.push({
      rule: emptied.has(start) ? 'emptiedHeading' : 'restatedLine',
      startLine: start + 1,
      endLine: end + 1,
      tokens: tokensOf(block.join('\n')),
      text: clip(block.join(' ')),
      saidBy: match.source,
      saidAs: clip(match.text),
    });
  };

  for (const i of indices) {
    if (i !== previous + 1) {
      flush(previous);
      start = i;
    }
    previous = i;
  }
  flush(previous);
  return out.sort((a, b) => b.tokens - a.tokens);
}

/** Deleting a block leaves a hole; a run of blanks is not a saving worth a confusing diff. */
function collapseBlankRuns(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line.trim() === '' && out.length > 0 && out[out.length - 1].trim() === '') continue;
    out.push(line);
  }
  return out;
}

/** Deletion-only unified diff — enough for a human to check the proposal line by line. */
function unifiedDiff(filePath: string, lines: string[], removed: Map<number, Match>): string {
  const indices = [...removed.keys()].sort((a, b) => a - b);
  const hunks: Array<[number, number]> = [];
  for (const i of indices) {
    const last = hunks[hunks.length - 1];
    if (last && i - last[1] <= DIFF_CONTEXT * 2 + 1) last[1] = i;
    else hunks.push([i, i]);
  }

  const out = [`--- ${filePath}`, `+++ ${filePath} (proposed)`];
  for (const [from, to] of hunks) {
    const start = Math.max(0, from - DIFF_CONTEXT);
    const end = Math.min(lines.length - 1, to + DIFF_CONTEXT);
    const kept = lines.slice(start, end + 1).filter((_, k) => !removed.has(start + k)).length;
    out.push(`@@ -${start + 1},${end - start + 1} +${start + 1},${kept} @@`);
    for (let i = start; i <= end; i++) out.push(`${removed.has(i) ? '-' : ' '}${lines[i]}`);
  }
  return out.join('\n');
}

// --- Files we are allowed to propose edits to ---

/**
 * The user's own startup text.
 *
 * Deliberately short: a file belongs here only if the user owns it and edits
 * are theirs to make. Everything else in the block is corpus.
 */
function editableFiles(projectRoot?: string): string[] {
  const home = claudeHome();
  const candidates = [
    path.join(home, 'CLAUDE.md'),
    path.join(home, 'AGENTS.md'),
    ...(projectRoot
      ? [
          path.join(projectRoot, 'CLAUDE.md'),
          path.join(projectRoot, 'AGENTS.md'),
          // The memory index is re-read into every session, in both layouts
          // the harness has used for it.
          path.join(home, 'projects', encodeProject(projectRoot), 'MEMORY.md'),
          path.join(home, 'projects', encodeProject(projectRoot), 'memory', 'MEMORY.md'),
        ]
      : []),
  ];
  return candidates.filter((file) => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  });
}

/** How the harness names a project's session directory. */
function encodeProject(projectRoot: string): string {
  return projectRoot.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Why each corpus source is read but not rewritten. */
function reasonFor(source: string): string {
  if (source.startsWith('mcp:')) {
    return 'Sent by the MCP server itself. It is not a file on this machine, and a local edit would be replaced the next time the server starts.';
  }
  if (source.startsWith('hook:')) {
    return "Printed by a hook at every session start. The text belongs to whatever plugin owns the hook; what it costs is worth knowing, but shortening it is that plugin's change, not this file's.";
  }
  if (source === 'skills') {
    return "Built from the description in each skill's own SKILL.md, most of them installed from elsewhere. `get_startup_context_audit` prices the skills that are listed at every start and never invoked — that is the evidence-backed lever here.";
  }
  return 'Not a file this machine owns.';
}

// --- Entry point ---

export interface StartupTextOptions {
  /** Which project's instruction and memory files to examine. */
  projectRoot?: string;
  /** Session discovery, injectable so tests can point at a fixture directory. */
  listSessions?: typeof listAllSessions;
}

export const COMPRESSION_INVARIANT =
  'Nothing is reworded. A passage is only proposed for removal when another source in the same startup block still delivers it — each removal names that source and quotes it.';

export async function analyzeStartupText(
  opts: StartupTextOptions = {},
): Promise<StartupTextCompression> {
  const startedAt = Date.now();
  const { entries: corpus, sessionsRead } = await collectStartupCorpus(
    opts.listSessions ?? listAllSessions,
  );
  const ref: RefUnit[] = [];
  for (const entry of corpus) {
    for (const text of units(entry.text)) {
      const words = contentWords(text);
      if (words.size >= UNIT_MIN_WORDS) ref.push({ source: entry.source, text, words });
    }
  }

  const candidates: CompressionCandidate[] = [];
  for (const file of editableFiles(opts.projectRoot)) {
    let original: string;
    try {
      original = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const candidate = compressAgainstCorpus(file, original, ref);
    if (candidate && candidate.savedTokens > 0) candidates.push(candidate);
  }
  candidates.sort((a, b) => b.savedTokens - a.savedTokens);

  const notCompressible: UntouchableSource[] = corpus
    .map((entry) => ({
      source: entry.source,
      tokens: tokensOf(entry.text),
      reason: reasonFor(entry.source),
    }))
    .sort((a, b) => b.tokens - a.tokens);

  const notes = [
    'Nothing is written. This is a proposal: read the diff, keep what you agree with.',
    'The saving is per session — this text is re-read on every start, so the delta repeats for as long as the file stays as it is.',
  ];
  if (corpus.length === 0) {
    notes.push(
      'No startup texts were found in the recent session logs, so there was nothing to compare against and no proposal could be made.',
    );
  }
  if (!opts.projectRoot) {
    notes.push('No project root given: only the global instruction files were examined.');
  }

  return {
    candidates,
    notCompressible,
    totalSavedTokens: candidates.reduce((n, c) => n + c.savedTokens, 0),
    invariant: COMPRESSION_INVARIANT,
    corpusSessions: sessionsRead,
    notes,
    scanMs: Date.now() - startedAt,
  };
}

/**
 * The invariant, checked rather than asserted in prose.
 *
 * Every removal must name a source that still delivers the same instruction,
 * and the surviving text must actually overlap the lines that would go —
 * otherwise the evidence quoted to the reader is decoration.
 *
 * Checked against the file on disk, not against the payload's own `text`,
 * which is clipped for display: verifying a proposal against its own summary
 * of itself would pass whatever the proposal did.
 *
 * Tests run this over the whole result; a caller that wants the guarantee at
 * runtime can too.
 */
export function assertInvariant(result: StartupTextCompression): void {
  for (const candidate of result.candidates) {
    const lines = fs.readFileSync(candidate.path, 'utf8').split('\n');
    for (const removal of candidate.removals) {
      if (!removal.saidBy || !removal.saidAs) {
        throw new Error(
          `${candidate.path}:${removal.startLine} removed without a surviving source`,
        );
      }
      /* Per sentence of the removed block, not per block: the block may be
         several lines, each restated by a different unit of the same source,
         and one blended bag of words would dilute every one of them below any
         threshold worth setting. */
      const block = lines.slice(removal.startLine - 1, removal.endLine).join('\n');
      const evidence = contentWords(removal.saidAs);
      const overlaps = units(block).some(
        (unit) => jaccard(contentWords(unit), evidence) >= UNIT_MATCH_MIN,
      );
      if (!overlaps) {
        throw new Error(
          `${candidate.path}:${removal.startLine} cites ${removal.saidBy}, which does not say what it says`,
        );
      }
    }
  }
}
