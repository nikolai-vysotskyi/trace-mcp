/**
 * Decision-store export helpers — human-readable dumps of the SQLite-backed
 * decision knowledge graph.
 *
 * Two output formats:
 *   - jsonl     one decision per line, full DecisionRow with tags parsed
 *               from the stored JSON column into a real string[].
 *   - markdown  grouped by decision type then by service_name (when the
 *               result set spans multiple services). Each decision rendered
 *               with title heading, metadata block, and content body.
 *
 * Pure functions: caller passes a DecisionStore + options, gets back a string
 * plus the row count. No I/O, no side effects — backing both the
 * `export_decisions` MCP tool and the `trace-mcp memory export` CLI command.
 */

import type { DecisionRow, DecisionStore, DecisionType } from './decision-store.js';

/** Hard cap to prevent multi-GB dumps from a runaway agent call. */
export const EXPORT_LIMIT_MAX = 5000;
/** Default row cap when the caller omits `limit`. */
export const EXPORT_LIMIT_DEFAULT = 500;

export interface ExportOptions {
  project_root?: string;
  service_name?: string;
  type?: DecisionType;
  /**
   * Git-branch filter forwarded as-is to queryDecisions. Accepts the same
   * three modes the store supports: `'all'`, branch name, or `null` for
   * branch-agnostic rows. Omit for no filter.
   */
  git_branch?: string | null | 'all';
  include_invalidated?: boolean;
  /** Capped at {@link EXPORT_LIMIT_MAX}; defaults to {@link EXPORT_LIMIT_DEFAULT}. */
  limit?: number;
}

export interface ExportResult {
  content: string;
  count: number;
}

/**
 * Normalised representation of a decision used by both exporters.
 *
 * Compared to {@link DecisionRow}, this carries `tags` as a real string[]
 * (parsed from the stored JSON column). When the stored value is malformed
 * JSON the original raw string is preserved on `_tags_raw` so debuggers can
 * still see what was on disk.
 */
export interface ExportDecision extends Omit<DecisionRow, 'tags'> {
  tags: string[];
  /** Present only when the on-disk tags column failed JSON.parse. */
  _tags_raw?: string;
}

function clampLimit(limit?: number): number {
  if (limit === undefined || limit === null) return EXPORT_LIMIT_DEFAULT;
  if (!Number.isFinite(limit) || limit <= 0) return EXPORT_LIMIT_DEFAULT;
  return Math.min(Math.floor(limit), EXPORT_LIMIT_MAX);
}

function fetchRows(store: DecisionStore, opts: ExportOptions): DecisionRow[] {
  return store.queryDecisions({
    project_root: opts.project_root,
    service_name: opts.service_name,
    type: opts.type,
    git_branch: opts.git_branch,
    include_invalidated: opts.include_invalidated,
    limit: clampLimit(opts.limit),
  });
}

/**
 * Parse the stringified-JSON `tags` column into a real string[]. When the
 * column is malformed (legacy / hand-edited DB), return an empty array and
 * surface the raw bytes via `_tags_raw` so the export still serialises
 * losslessly.
 */
function normaliseDecision(row: DecisionRow): ExportDecision {
  const { tags: rawTags, ...rest } = row;
  if (rawTags === null || rawTags === undefined || rawTags === '') {
    return { ...rest, tags: [] };
  }
  try {
    const parsed = JSON.parse(rawTags);
    if (Array.isArray(parsed)) {
      const onlyStrings = parsed.filter((t): t is string => typeof t === 'string');
      return { ...rest, tags: onlyStrings };
    }
    return { ...rest, tags: [], _tags_raw: rawTags };
  } catch {
    return { ...rest, tags: [], _tags_raw: rawTags };
  }
}

/**
 * JSONL export — one decision per line, full normalised payload. Each line
 * is itself valid JSON and the whole document is JSONL (newline-delimited).
 */
export function exportDecisionsAsJsonl(
  store: DecisionStore,
  opts: ExportOptions = {},
): ExportResult {
  const rows = fetchRows(store, opts);
  const lines = rows.map((row) => JSON.stringify(normaliseDecision(row)));
  return { content: lines.join('\n'), count: rows.length };
}

/**
 * Markdown export — decisions grouped by type, then by service_name when
 * the result set spans more than one service. Each decision is rendered
 * with a `## title` heading, an optional metadata block, and the content
 * body terminated by a horizontal rule.
 */
export function exportDecisionsAsMarkdown(
  store: DecisionStore,
  opts: ExportOptions = {},
): ExportResult {
  const rows = fetchRows(store, opts).map(normaliseDecision);

  // Decide whether to add per-service subheaders. Grouping by service is
  // noise when the dump is single-service.
  const services = new Set<string>();
  for (const row of rows) {
    services.add(row.service_name ?? '');
  }
  const multiService = services.size > 1;

  const byType = new Map<DecisionType, ExportDecision[]>();
  for (const row of rows) {
    const bucket = byType.get(row.type);
    if (bucket) {
      bucket.push(row);
    } else {
      byType.set(row.type, [row]);
    }
  }

  const out: string[] = [];
  for (const [type, decisions] of byType) {
    out.push(`# ${type}`);
    out.push('');

    if (multiService) {
      const byService = new Map<string, ExportDecision[]>();
      for (const d of decisions) {
        const key = d.service_name ?? '(no service)';
        const bucket = byService.get(key);
        if (bucket) bucket.push(d);
        else byService.set(key, [d]);
      }
      for (const [service, scoped] of byService) {
        out.push(`### Service: ${service}`);
        out.push('');
        for (const d of scoped) renderDecision(out, d);
      }
    } else {
      for (const d of decisions) renderDecision(out, d);
    }
  }

  return { content: out.join('\n').replace(/\n+$/, '\n'), count: rows.length };
}

/**
 * Append a single decision to the markdown buffer. Newline discipline:
 * each metadata line ends with a two-space hard-break so markdown
 * renderers respect the line layout without collapsing into a paragraph.
 */
function renderDecision(out: string[], d: ExportDecision): void {
  out.push(`## ${d.title}`);
  out.push('');
  out.push(`**Type:** ${d.type}  `);
  out.push(`**Created:** ${d.created_at}  `);
  if (d.service_name) out.push(`**Service:** ${d.service_name}  `);
  if (d.file_path) out.push(`**File:** \`${d.file_path}\`  `);
  if (d.symbol_id) out.push(`**Symbol:** \`${d.symbol_id}\`  `);
  if (d.tags.length > 0) out.push(`**Tags:** ${d.tags.join(', ')}  `);
  if (d.valid_until) out.push(`**Invalidated:** ${d.valid_until}  `);
  out.push('');
  out.push(d.content);
  out.push('');
  out.push('---');
  out.push('');
}
