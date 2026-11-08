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
 * in its instructions. Paraphrasing that text saves a little and risks a lot;
 * dropping the second copy saves the same tokens with the instruction still
 * present, verbatim, in the block.
 *
 * The invariant
 * ─────────────
 *   nothing is reworded, and no text is removed unless the same instruction is
 *   still delivered by another source in the same startup block.
 *
 * It is enforced UNIVERSALLY, at the smallest unit of meaning:
 *
 * - a line is removed only when EVERY sentence on it has its own surviving
 *   match. Not "most of it", not "60% of its characters";
 * - a heading is removed only when EVERY non-blank line of its body has
 *   already been removed on its own evidence;
 * - each removal carries one evidence entry per sentence, so the reader can
 *   check every clause rather than the strongest one.
 *
 * The universal rule is the correction that PR #845's review forced. The first
 * implementation removed a line at 60% coverage and validated it with a
 * `.some()` check — which is the same fractional deletion this module already
 * refused at section level, one level down, and it silently deleted the
 * unmatched 40%. Both reviewers reproduced it independently. Any threshold
 * below "every unit" reintroduces the bug: prefer proposing less.
 *
 * Matching is bag-of-words with two guards the same review demanded. Polarity
 * is compared before anything else, because "Do not run tests in parallel" and
 * "Run tests in parallel" share every content word and are opposite
 * instructions. Digits and short tokens are kept, because `Node 22` and
 * `Node 18` are otherwise the same sentence.
 *
 * What this module will and will not touch
 * ────────────────────────────────────────
 * It proposes edits ONLY to files the user owns: CLAUDE.md, AGENTS.md, and a
 * project's MEMORY.md. The rest of the startup block — a third party's skill
 * descriptions, another server's instruction text, a plugin hook's output — is
 * the reference corpus: read to prove duplication, never rewritten, because we
 * cannot edit it and a local rewrite would not survive the next update of
 * whatever emits it. Those sources are reported in `notCompressible` with the
 * reason, not silently dropped.
 *
 * Nothing is written. This is a proposal with a diff and a token delta;
 * applying it is TRA-769.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { encodeDirName, listAllSessions } from './log-parser.js';
import { claudeHome } from '../shared/paths.js';

const CHARS_PER_TOKEN = 4;

/** Files below this are handshakes and aborted runs, not sessions. */
const MIN_SESSION_BYTES = 20_000;

/** Below this many content words a unit is a fragment that collides by accident. */
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

/**
 * The same, for a sentence too short for partial overlap to carry meaning.
 *
 * Near-identity, because at three or four words the difference between a rule
 * and its opposite is one token: `Never push to main` vs `Never push to prod`
 * scores 0.6 against each other. A short rule is deleted only when the block
 * says essentially the same words.
 */
const SHORT_UNIT_MATCH_MIN = 0.9;

/** Context lines around a hunk in the emitted diff. */
const DIFF_CONTEXT = 2;

/**
 * Ceiling on the diff this payload carries, in lines.
 *
 * The report rides on the startup audit's response, so it has to be bounded:
 * a tool that measures token cost must not become one. Measured payloads on
 * real projects are 200-1400 tokens; this keeps a pathological file from
 * turning that into a wall of diff. The file path and line numbers are enough
 * to read the rest locally.
 */
const MAX_DIFF_LINES = 200;

/**
 * Words that flip an instruction's meaning without changing its vocabulary.
 *
 * "Do not run tests in parallel" and "Run tests in parallel" share every
 * content word. Without this check the compressor deletes the user's
 * constraint and cites its opposite as proof — the single worst thing a tool
 * like this can do.
 */
const NEGATIONS = new Set([
  'not',
  'never',
  'no',
  'dont',
  'doesnt',
  'cannot',
  'cant',
  'avoid',
  'forbid',
  'forbidden',
  'without',
  'except',
  'stop',
  'refuse',
  'skip',
  'unless',
]);

export interface Evidence {
  /** The startup source that still delivers this — `mcp:<server>`, `skills`, `hook:<name>`. */
  saidBy: string;
  /** How that source says it, verbatim: the proof, not the claim. */
  saidAs: string;
}

export interface Removal {
  /** `restatedLine` — every sentence on it is said elsewhere; `emptiedHeading` — its whole body has gone. */
  rule: string;
  /** 1-based, in the original file. One removal is one line. */
  line: number;
  tokens: number;
  /** What would go, clipped. */
  text: string;
  /**
   * One entry per sentence on the line, in order — the universal proof.
   * Empty only for `emptiedHeading`, which removes a label, not an instruction.
   */
  evidence: Evidence[];
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
   * Sized from the log, so the reader sees what it costs even though this tool
   * does not offer to touch it.
   */
  notCompressible: UntouchableSource[];
  totalSavedTokens: number;
  /** The rule every removal satisfies, said out loud rather than implied. */
  invariant: string;
  /** Which session's startup block the evidence came from, and when it ran. */
  evidenceFrom: string;
  notes: string[];
  scanMs: number;
}

// --- Text units ---

/**
 * Compare on content words.
 *
 * Markdown punctuation is how the same rule looks different in two files — one
 * writes it as a table row, the other as a bullet — so it is stripped before
 * comparing.
 *
 * Digits and short tokens are KEPT. Dropping them, as the first version did,
 * made `Require Node 22` and `Require Node 18` identical, and `v1`/`v2`/`CI`
 * vanish the same way. A version number is usually the whole point of the
 * sentence it appears in.
 */
function contentWords(text: string): Set<string> {
  const normalized = text
    .toLowerCase()
    .replace(/[`~*_#|>[\]()]/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return new Set(normalized.split(' ').filter((w) => w.length > 2 || /\d/.test(w)));
}

/** Whether a unit states a prohibition, on the same normalisation as the words. */
function isNegated(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .split(/\s+/);
  return words.some((w) => NEGATIONS.has(w));
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
 *
 * A colon is NOT a boundary. It introduces a list rather than ending a
 * thought, so splitting on it turns "Skip openers:" into a two-word fragment
 * that no evidence can ever prove — which, under the universal rule, silently
 * freezes every list in the file.
 */
function units(text: string): string[] {
  return text
    .split('\n')
    .flatMap((line) => line.split(/(?<=[.!?;])\s+|\s+—\s+/))
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * A unit with no content words at all — a stray bullet, a lone bracket.
 *
 * This is the ONLY thing a line may carry without proof. "Short" is not on
 * that list: `Never push to main.` is three words and an instruction, and
 * treating brevity as triviality is how the first version deleted it.
 */
function isEmptyUnit(text: string): boolean {
  return contentWords(text).size === 0;
}

/**
 * How close a match must be to authorise deleting a unit.
 *
 * A short sentence has too few words for partial overlap to mean anything —
 * `Never push to main.` and `Never push to prod.` are 3/4 alike and opposite
 * in effect — so it has to be near-identical to its evidence. Longer sentences
 * can be recognised through rewording at the usual threshold.
 */
function thresholdFor(words: Set<string>): number {
  return words.size < UNIT_MIN_WORDS ? SHORT_UNIT_MATCH_MIN : UNIT_MATCH_MIN;
}

/** The digits a unit commits to: `Node 22` is not `Node 18`. */
function numbers(words: Set<string>): Set<string> {
  return new Set([...words].filter((w) => /\d/.test(w)));
}

function sameNumbers(a: Set<string>, b: Set<string>): boolean {
  const na = numbers(a);
  const nb = numbers(b);
  if (na.size !== nb.size) return false;
  for (const n of na) if (!nb.has(n)) return false;
  return true;
}

interface RefUnit {
  source: string;
  text: string;
  words: Set<string>;
  negated: boolean;
}

interface Match extends Evidence {
  score: number;
}

/** The strongest thing in the corpus that says what `text` says, if anything does. */
function bestMatch(text: string, ref: RefUnit[]): Match | null {
  const words = contentWords(text);
  if (words.size === 0) return null;
  const negated = isNegated(text);
  const floor = thresholdFor(words);
  let best: Match | null = null;
  for (const unit of ref) {
    // Polarity and numbers are checked before the score, so no amount of shared
    // vocabulary can outvote them: they are what the sentence commits to.
    if (unit.negated !== negated) continue;
    if (!sameNumbers(words, unit.words)) continue;
    const score = jaccard(words, unit.words);
    if (score >= floor && (!best || score > best.score)) {
      best = { saidBy: unit.source, saidAs: unit.text, score };
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

export interface StartupCorpus {
  entries: CorpusEntry[];
  /** The session the block was read from — provenance for every claim made from it. */
  sessionPath: string;
  sessionMtime: number;
}

/**
 * The startup texts of ONE session: the most recent one in this project.
 *
 * One session, not a union of many. Unioning sources across sessions was a
 * review finding and a real defect: a server that was configured last month
 * and removed since would still "prove" that today's CLAUDE.md repeats it,
 * and the user would delete a rule nothing delivers any more. A single startup
 * block is the only thing that can honestly stand behind "another source in
 * the same startup block still says this".
 *
 * Scoped to the project for the same reason: another project's servers and
 * hooks are not evidence about this project's session.
 */
export async function collectStartupCorpus(
  listSessions: typeof listAllSessions = listAllSessions,
  projectRoot?: string,
): Promise<StartupCorpus | null> {
  const files = listSessions(projectRoot)
    .filter((s) => {
      try {
        return fs.statSync(s.filePath).size >= MIN_SESSION_BYTES;
      } catch {
        return false;
      }
    })
    .sort((a, b) => b.mtime - a.mtime);

  for (const file of files) {
    try {
      const texts = new Map<string, string>();
      await readStartupTexts(file.filePath, texts);
      if (texts.size === 0) continue;
      return {
        entries: [...texts].map(([source, text]) => ({ source, text })),
        sessionPath: file.filePath,
        sessionMtime: file.mtime,
      };
    } catch {
      /* an unreadable session is one less candidate, not a failed report */
    }
  }
  return null;
}

/**
 * Attachments before the first assistant record, which is where the startup
 * block ends.
 *
 * The cheap substring pre-filter must admit `"assistant"` itself. Filtering on
 * `"usage"` — as the first version did — skipped assistant records that carry
 * no usage block, so the boundary never fired and mid-session hook output was
 * collected as startup evidence. Found in review, reproduced from a log.
 */
async function readStartupTexts(filePath: string, out: Map<string, string>): Promise<void> {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  try {
    for await (const line of rl) {
      if (!line.includes('"attachment"') && !line.includes('"assistant"')) continue;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      // Everything after the first call is conversation, not text anyone can
      // rewrite in advance.
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

/** Markdown sections, so a fully removed one can drop its heading too. */
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

/**
 * Evidence for a line, or null if any part of it is unaccounted for.
 *
 * Universal by construction: one entry per non-trivial sentence, and a single
 * unmatched sentence rejects the whole line. A line whose sentences are all
 * trivial is rejected too — there is nothing to prove about it.
 */
function lineEvidence(line: string, ref: RefUnit[]): Evidence[] | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const out: Evidence[] = [];
  for (const unit of units(trimmed)) {
    // Only a unit with no words at all rides along unproven.
    if (isEmptyUnit(unit)) continue;
    const match = bestMatch(unit, ref);
    if (!match) return null;
    out.push({ saidBy: match.saidBy, saidAs: match.saidAs });
  }
  return out.length > 0 ? out : null;
}

function tokensOf(text: string): number {
  return Math.round(text.length / CHARS_PER_TOKEN);
}

function clip(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * Propose deletions for one file against the corpus.
 *
 * Two rules, both universal. A line goes when every sentence on it is said
 * elsewhere. A heading goes when every non-blank line of its body has already
 * gone on its own evidence — never by bulk-adding the body, which is how the
 * first version deleted short instructions that nothing else said.
 */
function compressAgainstCorpus(
  filePath: string,
  original: string,
  ref: RefUnit[],
): CompressionCandidate | null {
  const lines = original.split('\n');

  const removed = new Map<number, Removal>();
  lines.forEach((line, i) => {
    /* A heading is never removed on its own evidence, however well it matches:
       "### Disagree when the premise is wrong" restates the rule it labels, and
       cutting it leaves the body it introduced under the heading above. */
    if (isHeading(line)) return;
    const evidence = lineEvidence(line, ref);
    if (!evidence) return;
    removed.set(i, {
      rule: 'restatedLine',
      line: i + 1,
      tokens: tokensOf(line),
      text: clip(line),
      evidence,
    });
  });
  if (removed.size === 0) return null;

  for (const section of sections(lines)) {
    if (section.heading < 0) continue;
    const nonBlank = section.body.filter((i) => lines[i].trim() !== '');
    if (nonBlank.length === 0 || !nonBlank.every((i) => removed.has(i))) continue;
    removed.set(section.heading, {
      rule: 'emptiedHeading',
      line: section.heading + 1,
      tokens: tokensOf(lines[section.heading]),
      text: clip(lines[section.heading]),
      // A heading whose body has gone is a label over nothing; it makes no
      // claim of its own, so there is nothing to cite for it.
      evidence: [],
    });
  }

  /* Blank lines stranded between removals are folded into the removal set
     rather than collapsed afterwards, so the diff the reader checks and the
     `savedTokens` they are quoted describe the same file. */
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() !== '' || removed.has(i)) continue;
    const prevRemoved = removed.has(i - 1);
    const nextBlankOrRemoved = i + 1 >= lines.length || removed.has(i + 1);
    if (prevRemoved && nextBlankOrRemoved) {
      removed.set(i, {
        rule: 'strandedBlank',
        line: i + 1,
        tokens: 0,
        text: '',
        evidence: [],
      });
    }
  }

  const compressed = lines.filter((_, i) => !removed.has(i)).join('\n');
  const removals = [...removed.values()]
    .filter((r) => r.rule !== 'strandedBlank')
    .sort((a, b) => b.tokens - a.tokens);

  return {
    path: filePath,
    currentTokens: tokensOf(original),
    compressedTokens: tokensOf(compressed),
    savedTokens: tokensOf(original) - tokensOf(compressed),
    removals,
    diff: unifiedDiff(filePath, lines, new Set(removed.keys())),
  };
}

/** Deletion-only unified diff — enough for a human to check the proposal line by line. */
function unifiedDiff(filePath: string, lines: string[], removed: Set<number>): string {
  const indices = [...removed].sort((a, b) => a - b);
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
    if (out.length > MAX_DIFF_LINES) {
      out.push(
        `… diff truncated at ${MAX_DIFF_LINES} lines; every removal is listed in \`removals\``,
      );
      break;
    }
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
          // The memory index is re-read into every session. `encodeDirName` is
          // the harness's own encoder, reused rather than reimplemented — a
          // hand-rolled one dropped underscores and dots and never found the
          // file for a project path containing either.
          path.join(home, 'projects', encodeDirName(projectRoot), 'MEMORY.md'),
          path.join(home, 'projects', encodeDirName(projectRoot), 'memory', 'MEMORY.md'),
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

/** Why each corpus source is read but not rewritten. */
function reasonFor(source: string): string {
  if (source.startsWith('mcp:')) {
    return 'Sent by the MCP server itself. Not a file on this machine, and a local edit would be replaced the next time the server starts.';
  }
  if (source.startsWith('hook:')) {
    return "Printed by a hook at every session start. The text belongs to whichever plugin owns the hook; shortening it is that plugin's change, not this file's.";
  }
  if (source === 'skills') {
    return "Built from each skill's own SKILL.md, most of them installed from elsewhere. `recommendations` prices the skills listed at every start and never invoked — that is the evidence-backed lever here.";
  }
  return 'Not a file this machine owns.';
}

// --- Entry point ---

export interface StartupTextOptions {
  /** Which project's instruction and memory files to examine, and whose sessions to read. */
  projectRoot?: string;
  /** Session discovery, injectable so tests can point at a fixture directory. */
  listSessions?: typeof listAllSessions;
}

const COMPRESSION_INVARIANT =
  'Nothing is reworded. A line is only proposed for removal when EVERY sentence on it is still delivered by another source in the same startup block, and each removal cites that source per sentence. A heading goes only once its whole body has.';

export async function analyzeStartupText(
  opts: StartupTextOptions = {},
): Promise<StartupTextCompression> {
  const startedAt = Date.now();
  const corpus = await collectStartupCorpus(opts.listSessions ?? listAllSessions, opts.projectRoot);

  const ref: RefUnit[] = [];
  for (const entry of corpus?.entries ?? []) {
    for (const text of units(entry.text)) {
      const words = contentWords(text);
      // Short corpus units are kept: they are the only thing that can prove a
      // short rule, and the stricter threshold is what keeps that honest.
      if (words.size > 0) {
        ref.push({ source: entry.source, text, words, negated: isNegated(text) });
      }
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

  const notCompressible: UntouchableSource[] = (corpus?.entries ?? [])
    .map((entry) => ({
      source: entry.source,
      tokens: tokensOf(entry.text),
      reason: reasonFor(entry.source),
    }))
    .sort((a, b) => b.tokens - a.tokens);

  const notes = [
    'Nothing is written. This is a proposal: read the diff, keep what you agree with.',
    'The saving is per session — this text is re-read on every start, so the delta repeats for as long as the file stays as it is.',
    "Evidence comes from ONE startup block, the most recent in this project. Sources are not unioned across sessions: a server configured last month and removed since must not prove that today's file repeats it.",
  ];
  if (!corpus) {
    notes.push(
      "No startup block was found in this project's recent session logs, so there was nothing to compare against and no proposal could be made.",
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
    evidenceFrom: corpus
      ? `${corpus.sessionPath} (${new Date(corpus.sessionMtime).toISOString()})`
      : 'no startup block found',
    notes,
    scanMs: Date.now() - startedAt,
  };
}

/**
 * The invariant, checked rather than asserted in prose.
 *
 * Universal, and deliberately so: EVERY non-trivial sentence of EVERY removed
 * line must carry evidence that overlaps it and agrees with it in polarity.
 * The first version used `.some()` — one matching sentence vouching for a whole
 * block — and both reviewers used exactly that hole to delete text nothing
 * else said. `.some()` cannot establish this claim; only `.every()` can.
 *
 * Checked against the file on disk, not the payload's own clipped `text`:
 * verifying a proposal against its own summary of itself would pass whatever
 * the proposal did.
 */
export function assertInvariant(result: StartupTextCompression): void {
  for (const candidate of result.candidates) {
    const lines = fs.readFileSync(candidate.path, 'utf8').split('\n');
    for (const removal of candidate.removals) {
      const line = lines[removal.line - 1] ?? '';
      const at = `${candidate.path}:${removal.line}`;

      if (removal.rule === 'emptiedHeading') {
        if (!isHeading(line)) throw new Error(`${at} removed as a heading but is not one`);
        continue;
      }

      const claims = units(line.trim()).filter((u) => !isEmptyUnit(u));
      if (claims.length === 0) throw new Error(`${at} removed with nothing to prove about it`);
      if (removal.evidence.length !== claims.length) {
        throw new Error(
          `${at} removes ${claims.length} sentences but cites ${removal.evidence.length}`,
        );
      }
      claims.forEach((claim, i) => {
        const cited = removal.evidence[i];
        if (!cited?.saidBy || !cited.saidAs) {
          throw new Error(`${at} removes a sentence with no surviving source`);
        }
        if (isNegated(claim) !== isNegated(cited.saidAs)) {
          throw new Error(`${at} cites ${cited.saidBy}, which states the opposite`);
        }
        const claimWords = contentWords(claim);
        const citedWords = contentWords(cited.saidAs);
        if (!sameNumbers(claimWords, citedWords)) {
          throw new Error(`${at} cites ${cited.saidBy}, which names different values`);
        }
        if (jaccard(claimWords, citedWords) < thresholdFor(claimWords)) {
          throw new Error(`${at} cites ${cited.saidBy}, which does not say what it says`);
        }
      });
    }
  }
}
