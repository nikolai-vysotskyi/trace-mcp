/**
 * Pure runtime for the Insights tab.
 *
 * This file contains the React-free pieces of the insights surface:
 *   - the report catalog (3 reports for slice 1)
 *   - the JSON-RPC request envelope helper
 *   - per-report result flatteners that normalise tool payloads into a
 *     uniform { rows: Array<{ primary, secondary, badge? }> } shape
 *   - an InsightsClient contract + defaultInsightsClient that opens an
 *     ephemeral MCP session per call (same pattern as notebook-runtime.ts)
 *
 * Why is this split out from Insights.tsx? Same reason as notebook-runtime.ts:
 * the project-root vitest config has no React/jsdom toolchain, and pnpm
 * --frozen-lockfile on CI does not hoist `react` to the root node_modules.
 * Keeping the testable surface React-free avoids the import trap.
 *
 * Keep this file free of React COMPONENTS and DOM types. It does import the
 * i18n runtime (TRA-384), which reaches react-i18next: the row text these
 * flatteners build is read by a person and cannot stay English. The report
 * catalogue holds catalogue KEYS rather than resolved strings, so the picker
 * re-renders when the language changes rather than freezing whatever language
 * was active at import.
 */

import { t } from '../i18n';

const BASE = 'http://127.0.0.1:3741';

// ── Report catalog ───────────────────────────────────────────────────
// Three high-signal reports for slice 1. Extending this catalogue is a
// deliberate decision — do not auto-add tools just because they are
// read-only. Each entry maps a report id to the MCP tool it calls and
// (optionally) a transform that produces the tool arguments.

export type ReportId = 'claudemd_drift' | 'pagerank' | 'risk_hotspots';

export interface ReportDef {
  id: ReportId;
  /** Catalogue keys, not words — see the note at the top of this file. */
  titleKey: string;
  descriptionKey: string;
  mcpTool: string;
  /**
   * Build the `arguments` object for the JSON-RPC `tools/call` envelope.
   * The project root is passed through so reports that scope to a path
   * can wire it in; trace-mcp itself reads the active project from the
   * `?project=` query string so most reports take no arguments.
   */
  argTransform: (projectRoot: string) => Record<string, unknown>;
}

export const INSIGHT_REPORTS: ReportDef[] = [
  {
    id: 'claudemd_drift',
    titleKey: 'insights:reportDriftTitle',
    descriptionKey: 'insights:reportDriftDescription',
    mcpTool: 'check_claudemd_drift',
    argTransform: () => ({}),
  },
  {
    id: 'pagerank',
    titleKey: 'insights:reportPagerankTitle',
    descriptionKey: 'insights:reportPagerankDescription',
    mcpTool: 'get_pagerank',
    argTransform: () => ({ limit: 20 }),
  },
  {
    id: 'risk_hotspots',
    titleKey: 'insights:reportRiskTitle',
    descriptionKey: 'insights:reportRiskDescription',
    mcpTool: 'get_risk_hotspots',
    argTransform: () => ({ limit: 20 }),
  },
];

export const REPORT_BY_ID: Record<ReportId, ReportDef> = INSIGHT_REPORTS.reduce(
  (acc, r) => {
    acc[r.id] = r;
    return acc;
  },
  {} as Record<ReportId, ReportDef>,
);

// ── Row shape ────────────────────────────────────────────────────────
// Every report flattens to the same row shape so the renderer can use a
// single component. `primary` is the dominant label (file path / line),
// `secondary` is supporting context, and `badge` is the small chip on
// the right (severity, score, etc.).

export interface InsightRow {
  primary: string;
  secondary?: string;
  badge?: string;
}

export interface InsightRows {
  rows: InsightRow[];
}

// ── Request shaping ──────────────────────────────────────────────────

interface JsonRpcCall {
  jsonrpc: '2.0';
  id: number;
  method: 'tools/call';
  params: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

/**
 * Build the JSON-RPC `tools/call` envelope for a given report. Pure —
 * does not touch the network. Used by the default client AND by tests
 * to assert request shape without mocking fetch.
 */
export function buildRpcCall(reportId: ReportId, projectRoot: string, id: number = 2): JsonRpcCall {
  const def = REPORT_BY_ID[reportId];
  // A programmer assertion, not a message: the picker cannot produce an id
  // this map does not have, so this never reaches the error box.
  if (!def) throw new Error(`Unknown report id: ${reportId}`);
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name: def.mcpTool,
      arguments: def.argTransform(projectRoot),
    },
  };
}

// ── Result shaping ───────────────────────────────────────────────────
// Each MCP tool returns a slightly different payload. The renderer needs
// a uniform shape, so we flatten here. Defensive — if the payload is
// missing or malformed we return an empty rows array rather than throwing,
// because the renderer surfaces "0 rows" as the empty state.

function shortFile(file: string): string {
  // Strip a leading project root if it leaked through (the tool usually
  // returns repo-relative paths but we play it safe).
  return file.replace(/^.*?\/(?=src\/|packages\/|tests\/|plans\/|docs\/)/, '');
}

export function flattenDriftRows(payload: unknown): InsightRows {
  const p = payload as {
    issues?: Array<{
      file?: string;
      line?: number;
      category?: string;
      issue?: string;
      severity?: string;
      fix?: string;
    }>;
  };
  const issues = Array.isArray(p?.issues) ? p.issues : [];
  const rows = issues.map((it) => {
    const location = it.line ? `${shortFile(it.file ?? '?')}:${it.line}` : shortFile(it.file ?? '?');
    return {
      primary: t('insights:rowIssue', {
        location,
        issue: it.issue ?? t('insights:noDescription'),
      }),
      secondary: it.fix ? t('insights:rowFix', { fix: it.fix }) : it.category,
      badge: it.severity,
    };
  });
  return { rows };
}

export function flattenPagerankRows(payload: unknown): InsightRows {
  // Tool returns a bare array; the JSON-RPC content unwrap in the client
  // produces either an array directly or an envelope { items: [...] }.
  const arr = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { items?: unknown[] })?.items)
      ? (payload as { items: Array<{ file?: string; score?: number }> }).items
      : [];
  const rows = (arr as Array<{ file?: string; score?: number }>).map((it) => ({
    primary: shortFile(it.file ?? '?'),
    secondary:
      typeof it.score === 'number'
        ? t('insights:rowScore', { score: it.score.toFixed(4) })
        : undefined,
    badge: typeof it.score === 'number' ? it.score.toFixed(3) : undefined,
  }));
  return { rows };
}

export function flattenRiskHotspotRows(payload: unknown): InsightRows {
  const p = payload as {
    hotspots?: Array<{
      file?: string;
      score?: number;
      complexity?: number;
      commits?: number;
      confidence_level?: string;
    }>;
  };
  const hotspots = Array.isArray(p?.hotspots) ? p.hotspots : [];
  const rows = hotspots.map((it) => ({
    primary: shortFile(it.file ?? '?'),
    secondary: t(
      it.confidence_level ? 'insights:rowHotspotConfidence' : 'insights:rowHotspot',
      {
        complexity: it.complexity ?? '?',
        commits: it.commits ?? '?',
        confidence: it.confidence_level,
      },
    ),
    badge: typeof it.score === 'number' ? it.score.toFixed(1) : undefined,
  }));
  return { rows };
}

export function flattenReport(reportId: ReportId, payload: unknown): InsightRows {
  switch (reportId) {
    case 'claudemd_drift':
      return flattenDriftRows(payload);
    case 'pagerank':
      return flattenPagerankRows(payload);
    case 'risk_hotspots':
      return flattenRiskHotspotRows(payload);
  }
}

// ── Daemon client ────────────────────────────────────────────────────
// Mirrors the JSON-RPC dance in notebook-runtime.ts: initialize → send
// notifications/initialized → tools/call. We use a fresh session per
// call — cheap enough for occasional report refreshes. Replace with a
// pooled session if Insights becomes a heavy surface.

export interface InsightsClient {
  runReport(reportId: ReportId, root: string): Promise<InsightRows>;
}

export const defaultInsightsClient: InsightsClient = {
  async runReport(reportId, root) {
    const initRes = await fetch(`${BASE}/mcp?project=${encodeURIComponent(root)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'trace-mcp-insights', version: '0.1.0' },
        },
      }),
    });
    if (!initRes.ok) throw new Error(t('insights:errorInit', { status: initRes.status }));
    const sessionId = initRes.headers.get('mcp-session-id') ?? '';
    if (!sessionId) throw new Error(t('insights:errorNoSession'));
    await initRes.text().catch(() => '');
    await fetch(`${BASE}/mcp?project=${encodeURIComponent(root)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
    }).then((r) => r.text().catch(() => ''));

    const callRes = await fetch(`${BASE}/mcp?project=${encodeURIComponent(root)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify(buildRpcCall(reportId, root)),
    });
    if (!callRes.ok) {
      throw new Error(
        t('insights:errorHttp', {
          status: callRes.status,
          detail: await callRes.text().catch(() => ''),
        }),
      );
    }
    const ct = callRes.headers.get('content-type') ?? '';
    let payload: unknown;
    if (ct.includes('text/event-stream')) {
      const raw = await callRes.text();
      for (const line of raw.split('\n')) {
        const frame = line.trim();
        if (!frame.startsWith('data:')) continue;
        try {
          payload = JSON.parse(frame.slice(5).trim());
          break;
        } catch {
          // skip non-JSON frames
        }
      }
    } else {
      payload = await callRes.json();
    }
    const rpc = payload as {
      error?: { message?: string };
      result?: { content?: Array<{ type: string; text?: string }> };
    };
    if (rpc?.error) throw new Error(rpc.error.message ?? t('insights:errorToolFailed'));
    const first = rpc?.result?.content?.[0];
    let toolResult: unknown = rpc?.result ?? payload;
    if (first?.type === 'text' && typeof first.text === 'string') {
      try {
        toolResult = JSON.parse(first.text);
      } catch {
        toolResult = first.text;
      }
    }
    return flattenReport(reportId, toolResult);
  },
};
