/**
 * Cross-tool `detail_level` knob.
 *
 * Borrowed wholesale from CRG v2.2.1 — adding `detail_level="minimal"` to the
 * 8 most-used tools cut their default output by 40-60% in real workflows.
 * The full payload is rarely what an agent needs; most calls are followed
 * immediately by `get_symbol`, so the first hop only needs enough to pick a
 * candidate.
 *
 * "minimal" — bare-essential fields, no scores/signatures/freshness metadata.
 *             Pick a target by name + file:line, then escalate to a deeper
 *             call if needed.
 * "default" — current behaviour. Project-friendly fields, no DB internals.
 * "full"    — everything we expose at runtime, including hints/scores.
 *             Reserved for tools that want to differentiate; for most tools
 *             "default" already means "full".
 *
 * Tools that opt in:
 *   1. Add `detail_level: DetailLevelSchema` to their Zod schema.
 *   2. Pull `detail_level` out of args.
 *   3. Run their projected response through `compactSearchItems` /
 *      `compactOutlineSymbols` / etc. — the `compact*` helpers in this file.
 *
 * Each helper is type-narrowed and field-explicit on purpose: a generic
 * "drop these keys" helper makes minimal-mode behaviour invisible at the
 * call site. Inline projections keep the contract obvious in code review.
 */
import { z } from 'zod';

export type DetailLevel = 'minimal' | 'default' | 'full';

export const DetailLevelSchema = z
  .enum(['minimal', 'default', 'full'])
  .optional()
  .describe(
    'Output verbosity. "minimal" returns ~40-60% fewer tokens (drops scores, fqn, signatures, summaries — keeps name/file/line). Use when you only need to pick a candidate before drilling in with get_symbol. Default: "default".',
  );

export function isMinimal(level: DetailLevel | undefined): boolean {
  return level === 'minimal';
}

// ─── Search results ───────────────────────────────────────────────────────

export interface SearchItemFull {
  symbol_id: string;
  name: string;
  kind: string;
  fqn?: string;
  signature?: string;
  summary?: string;
  file: string;
  line: number | null | undefined;
  score?: number;
  decorators?: string[];
  [key: string]: unknown;
}

export interface SearchItemMinimal {
  name: string;
  kind: string;
  file: string;
  line: number | null | undefined;
}

export function compactSearchItems(items: SearchItemFull[]): SearchItemMinimal[] {
  return items.map((it) => ({
    name: it.name,
    kind: it.kind,
    file: it.file,
    line: it.line,
  }));
}

// ─── Outline symbols ──────────────────────────────────────────────────────

export interface OutlineSymbolFull {
  symbolId: string;
  name: string;
  kind: string;
  signature?: string | null;
  lineStart?: number | null;
  lineEnd?: number | null;
  [key: string]: unknown;
}

export interface OutlineSymbolMinimal {
  name: string;
  kind: string;
  line: number | null | undefined;
}

export function compactOutlineSymbols(symbols: OutlineSymbolFull[]): OutlineSymbolMinimal[] {
  return symbols.map((s) => ({
    name: s.name,
    kind: s.kind,
    line: s.lineStart ?? null,
  }));
}

// ─── Find-usages references ───────────────────────────────────────────────

export interface UsageRefFull {
  edge_type?: string;
  resolution_tier?: string;
  symbol?: { name?: string; kind?: string; signature?: string; line_start?: number | null };
  file: string;
  [key: string]: unknown;
}

export interface UsageRefMinimal {
  file: string;
  line: number | null | undefined;
  name: string | undefined;
}

export function compactUsageRefs(refs: UsageRefFull[]): UsageRefMinimal[] {
  return refs.map((r) => ({
    file: r.file,
    line: r.symbol?.line_start ?? null,
    name: r.symbol?.name,
  }));
}
