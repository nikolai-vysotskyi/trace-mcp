/**
 * Evidence-Preserving Reducer (EPR) for long diagnostic/test output (TRA-1702).
 *
 * Ported from SoL-Pi's evidence-preserving-reducer (NVlabs, MIT License,
 * https://github.com/NVlabs/SoL-Pi — src/sol-pi/extensions/evidence-preserving-reducer/:
 * `receipt.ts`, `config.ts`, `provider.ts`, `candidate.ts`, `index.ts`, `archive.ts`).
 * `validateReceipt` below is a 1:1 port of SoL-Pi's `receipt.ts: validateReceipt`
 * (same schema constant, same checks, same failure reasons); the surrounding
 * orchestration (`reduceLongOutput`) mirrors their `index.ts: reduceToolResult`
 * gate order (size gates → secret gate → reduce → verify → smaller-check,
 * original untouched on any failure).
 *
 * Adapted for trace-mcp (harness-agnostic, no Pi dependency):
 * - No remote model call. The reducer behind `EvidenceReducer` is local by
 *   default (`LocalExtractiveReducer`: deterministic verbatim line selection,
 *   zero tokens, zero subprocesses, nothing leaves the process) — SoL-Pi's
 *   SECURITY.md remote-log risk class does not apply.
 * - No on-disk session archive. The archive is an in-memory content hash;
 *   readback is a re-run without reduction instead of a session artifact path.
 */

import { createHash } from 'node:crypto';

// ════════════════════════════════════════════════════════════════════════
// PORTED 1:1 FROM SoL-Pi config.ts (MIT, NVlabs)
// ════════════════════════════════════════════════════════════════════════

export const REDUCER_RECEIPT_SCHEMA = 'sol-pi-evidence-receipt/1' as const;
export const REDUCER_RECEIPT_PREFIX = 'sol_pi_evidence_receipt_v1' as const;

export const MAX_EVIDENCE_ITEMS = 12;
export const MAX_QUOTE_CHARS = 600;

/** A failing log that reads as a failure must carry failure evidence. */
export const FAILURE_SIGNAL =
  /error|failed|failure|fatal|exception|panic|timeout|unsolved|type mismatch|assert/i;

/** Precautionary secret detector — checked BEFORE any reduction. Not a complete scanner. */
export const LIKELY_SECRET =
  /(?:api[_-]?key|authorization|bearer|access[_-]?token|secret)[^\n]{0,32}[=:][^\n]+/i;

export const DEFAULT_MIN_BYTES = 4_096;
export const DEFAULT_MAX_CHARS = 600_000;

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function recordValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

// ════════════════════════════════════════════════════════════════════════
// PORTED 1:1 FROM SoL-Pi receipt.ts (MIT, NVlabs)
// ════════════════════════════════════════════════════════════════════════

export type EvidenceKind = 'fatal' | 'failure' | 'warning' | 'target' | 'summary';

export interface VerifiedEvidence {
  readonly kind: EvidenceKind;
  readonly line: number | undefined;
  readonly quote: string;
  readonly quoteSha256: string;
}

export interface ValidatedReceipt {
  readonly status: 'success' | 'failure';
  readonly uncertain: boolean;
  readonly evidence: readonly VerifiedEvidence[];
}

export type ReceiptValidation =
  | { readonly ok: true; readonly value: ValidatedReceipt }
  | { readonly ok: false; readonly reason: string };

/** Minimal archive view: validateReceipt only needs the source hash. */
export interface ReceiptArchive {
  readonly hash: string;
}

function lineNumberOf(body: string, quote: string): number | undefined {
  const index = body.indexOf(quote);
  if (index < 0) return undefined;
  let line = 1;
  for (let cursor = 0; cursor < index; cursor++) {
    if (body.charCodeAt(cursor) === 10) line++;
  }
  return line;
}

/**
 * Accept a receipt only when every claim in it can be checked against the
 * archived log: right schema, right source hash, status that matches the
 * observed exit, and quotes that appear byte for byte in the archive.
 */
export function validateReceipt(
  raw: string,
  archive: ReceiptArchive,
  body: string,
  isError: boolean,
): ReceiptValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
  const evidenceValue = recordValue(parsed, 'evidence');
  const expectedStatus = isError ? 'failure' : 'success';
  if (
    !isRecord(parsed) ||
    parsed.schema !== REDUCER_RECEIPT_SCHEMA ||
    parsed.source_sha256 !== archive.hash ||
    parsed.status !== expectedStatus ||
    typeof parsed.uncertain !== 'boolean' ||
    !Array.isArray(evidenceValue) ||
    evidenceValue.length > MAX_EVIDENCE_ITEMS
  ) {
    return { ok: false, reason: 'schema-mismatch' };
  }
  const allowedKinds = new Set<EvidenceKind>(['fatal', 'failure', 'warning', 'target', 'summary']);
  const evidence: VerifiedEvidence[] = [];
  const seen = new Set<string>();
  for (const item of evidenceValue) {
    const kind = recordValue(item, 'kind');
    const quote = recordValue(item, 'quote');
    if (
      typeof kind !== 'string' ||
      !allowedKinds.has(kind as EvidenceKind) ||
      typeof quote !== 'string' ||
      quote.length < 1 ||
      quote.length > MAX_QUOTE_CHARS ||
      !body.includes(quote)
    ) {
      return { ok: false, reason: 'unverifiable-quote' };
    }
    const evidenceKind = kind as EvidenceKind;
    const key = `${evidenceKind}\0${quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    evidence.push({
      kind: evidenceKind,
      line: lineNumberOf(body, quote),
      quote,
      quoteSha256: sha256(quote),
    });
  }
  // A failing log that reads as a failure must carry failure evidence, or the
  // receipt would let a real failure through as a clean summary.
  if (
    isError &&
    FAILURE_SIGNAL.test(body) &&
    !evidence.some((item) => item.kind === 'fatal' || item.kind === 'failure')
  ) {
    return { ok: false, reason: 'missing-failure-evidence' };
  }
  return { ok: true, value: { status: expectedStatus, uncertain: parsed.uncertain, evidence } };
}

// ════════════════════════════════════════════════════════════════════════
// REDUCER INTERFACE (adapted: local-first instead of Pi model registry)
// ════════════════════════════════════════════════════════════════════════

export interface ReducerInput {
  /** Stable label for the produced output (e.g. `get_diagnostics:tsc`). */
  readonly command: string;
  readonly isError: boolean;
  readonly body: string;
}

/**
 * A reducer turns a long log into a candidate receipt JSON string
 * (`{"schema","source_sha256","status","uncertain","evidence":[...]}`).
 * The receipt is NEVER trusted: `reduceLongOutput` re-validates it
 * byte-for-byte via `validateReceipt` and keeps the original on any failure.
 * Inject a mock in tests for the zero-spend suite (no model, no network).
 */
export interface EvidenceReducer {
  readonly name: string;
  reduce(input: ReducerInput): Promise<string>;
}

const FATAL_PATTERN = /fatal|panic|assert/i;
const WARNING_PATTERN = /warn/i;

function classifyEvidenceKind(line: string): EvidenceKind {
  if (FATAL_PATTERN.test(line)) return 'fatal';
  if (WARNING_PATTERN.test(line)) return 'warning';
  return 'failure';
}

/**
 * Default local reducer: deterministic verbatim extraction, zero spend.
 * Picks up to MAX_EVIDENCE_ITEMS lines — failure-signal lines first (in log
 * order), then other non-empty lines to fill — sliced to MAX_QUOTE_CHARS so
 * every quote is trivially byte-for-byte verifiable. `uncertain` mirrors
 * SoL-Pi's reducer guidance: set when the log lacks a clear failure signal.
 */
export class LocalExtractiveReducer implements EvidenceReducer {
  readonly name = 'local-extractive-v1';

  async reduce(input: ReducerInput): Promise<string> {
    const { body, isError } = input;
    const lines = body.split('\n');
    const seen = new Set<string>();
    const failureLines: string[] = [];
    const otherLines: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      if (FAILURE_SIGNAL.test(trimmed)) failureLines.push(trimmed);
      else otherLines.push(trimmed);
    }
    const picked = [...failureLines, ...otherLines].slice(0, MAX_EVIDENCE_ITEMS);
    const evidence = picked.map((line) => {
      const quote = line.length > MAX_QUOTE_CHARS ? line.slice(0, MAX_QUOTE_CHARS) : line;
      if (isError) return { kind: classifyEvidenceKind(line), quote };
      const kind: EvidenceKind =
        line.startsWith('warning') || WARNING_PATTERN.test(line) ? 'warning' : 'summary';
      return { kind, quote };
    });
    return JSON.stringify({
      schema: REDUCER_RECEIPT_SCHEMA,
      source_sha256: sha256(body),
      status: isError ? 'failure' : 'success',
      uncertain: failureLines.length === 0,
      evidence,
    });
  }
}

export const localExtractiveReducer = new LocalExtractiveReducer();

// ════════════════════════════════════════════════════════════════════════
// ORCHESTRATION (mirrors SoL-Pi index.ts reduceToolResult gate order)
// ════════════════════════════════════════════════════════════════════════

export type ReductionOutcome =
  | {
      readonly applied: true;
      readonly receipt: string;
      readonly receiptBytes: number;
      readonly sourceBytes: number;
      readonly sourceLines: number;
      readonly sourceSha256: string;
      readonly evidenceCount: number;
      readonly uncertain: boolean;
    }
  | { readonly applied: false; readonly reason: string };

export interface ReduceLongOutputOptions {
  readonly body: string;
  readonly command: string;
  readonly isError: boolean;
  readonly reducer?: EvidenceReducer;
  readonly minBytes?: number;
  readonly maxChars?: number;
}

export function receiptText(
  command: string,
  source: { hash: string; bytes: number; lines: number },
  validated: ValidatedReceipt,
  reducerName: string,
): string {
  const lines = [
    REDUCER_RECEIPT_PREFIX,
    `status=${validated.status}`,
    `uncertain=${validated.uncertain}`,
    `command_sha256=${sha256(command)}`,
    `source_sha256=${source.hash}`,
    `source_bytes=${source.bytes}`,
    `source_lines=${source.lines}`,
    `reducer=${reducerName}`,
    'verified_evidence:',
  ];
  for (const item of validated.evidence) {
    lines.push(
      `- kind=${item.kind} line=${item.line} quote_sha256=${item.quoteSha256} quote=${JSON.stringify(item.quote)}`,
    );
  }
  if (validated.evidence.length === 0) lines.push('- none');
  lines.push(
    'authority=trace-mcp retains diagnosis, repair, rerun, and pass/fail adjudication',
    'readback=rerun without reduction for the full output when exact context is needed',
  );
  return lines.join('\n');
}

/**
 * Reduce a long log to a verified receipt. Fail-open throughout: any gate or
 * verification failure returns `{ applied: false, reason }` and the caller
 * keeps the original output untouched.
 */
export async function reduceLongOutput(
  options: ReduceLongOutputOptions,
): Promise<ReductionOutcome> {
  const {
    body,
    command,
    isError,
    reducer = localExtractiveReducer,
    minBytes = DEFAULT_MIN_BYTES,
    maxChars = DEFAULT_MAX_CHARS,
  } = options;

  const sourceBytes = Buffer.byteLength(body, 'utf8');
  if (sourceBytes < minBytes) return { applied: false, reason: 'source-too-small' };
  if (body.length > maxChars) return { applied: false, reason: 'source-over-max-chars' };
  if (LIKELY_SECRET.test(body)) return { applied: false, reason: 'likely-secret' };

  const archive = { hash: sha256(body) };
  const sourceLines = body.length === 0 ? 0 : body.split('\n').length;

  let raw: string;
  try {
    raw = await reducer.reduce({ command, isError, body });
  } catch {
    return { applied: false, reason: 'reducer-error' };
  }

  const checked = validateReceipt(raw, archive, body, isError);
  if (!checked.ok) return { applied: false, reason: checked.reason };

  const receipt = receiptText(
    command,
    { hash: archive.hash, bytes: sourceBytes, lines: sourceLines },
    checked.value,
    reducer.name,
  );
  const receiptBytes = Buffer.byteLength(receipt, 'utf8');
  if (receiptBytes >= sourceBytes) {
    return { applied: false, reason: 'receipt-not-smaller' };
  }
  return {
    applied: true,
    receipt,
    receiptBytes,
    sourceBytes,
    sourceLines,
    sourceSha256: archive.hash,
    evidenceCount: checked.value.evidence.length,
    uncertain: checked.value.uncertain,
  };
}
