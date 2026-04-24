/**
 * Decision Memory tools — mine sessions for decisions, add/query/invalidate
 * decisions, search across the decision knowledge graph, and view timelines.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerContext } from '../../server/types.js';
import { mineSessions } from '../../memory/conversation-miner.js';
import { indexSessions } from '../../memory/session-indexer.js';
import { assembleWakeUp } from '../../memory/wake-up.js';
import type { DecisionType } from '../../memory/decision-store.js';

const DECISION_TYPES = [
  'architecture_decision', 'tech_choice', 'bug_root_cause',
  'preference', 'tradeoff', 'discovery', 'convention',
] as const;

export function registerMemoryTools(server: McpServer, ctx: ServerContext): void {
  const { projectRoot, j, decisionStore, topoStore } = ctx;
  if (!decisionStore) return;

  /** Get subproject names within this project */
  function getSubprojectNames(): string[] {
    if (!topoStore) return [];
    try {
      const repos = topoStore.getSubprojectsByProject(projectRoot);
      return repos.map(r => r.name);
    } catch { return []; }
  }

  // ── mine_sessions ─────────────────────────────────────────────────

  server.tool(
    'mine_sessions',
    'Mine Claude Code / Claw Code session logs for architectural decisions, tech choices, bug root causes, and preferences. Extracts decision-like content using pattern matching (no LLM calls). Skips already-mined sessions unless force=true. Mutates the decision store; idempotent. Use to populate the decision knowledge graph. Returns JSON: { mined, decisions_extracted, sessions_processed }.',
    {
      project_root: z.string().max(1024).optional().describe('Only mine sessions for this project path (default: all projects)'),
      force: z.boolean().optional().describe('Re-mine already processed sessions (default: false)'),
      min_confidence: z.number().min(0).max(1).optional().describe('Minimum confidence threshold for extracted decisions (default: 0.6)'),
    },
    async ({ project_root, force, min_confidence }) => {
      const result = await mineSessions(decisionStore, {
        projectRoot: project_root ?? projectRoot,
        force,
        minConfidence: min_confidence,
      });
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  // ── add_decision ──────────────────────────────────────────────────

  server.tool(
    'add_decision',
    'Manually record an architectural decision, tech choice, preference, or convention. Links to code symbols/files and optionally to a specific subproject for code-aware memory. Decisions have temporal validity — they can be invalidated later when they become outdated. Mutates the decision store (creates a new record). For automated extraction from session logs use mine_sessions instead. Returns JSON: { added: { id, title, type } }.',
    {
      title: z.string().min(1).max(200).describe('Short summary of the decision'),
      content: z.string().min(1).max(5000).describe('Full decision text — reasoning, context, tradeoffs'),
      type: z.enum(DECISION_TYPES).describe('Decision type'),
      service_name: z.string().max(256).optional().describe('Subproject name this decision is about (e.g., "auth-api", "user-service")'),
      symbol_id: z.string().max(512).optional().describe('Symbol FQN this decision is about (e.g., "src/auth/provider.ts::AuthProvider#class")'),
      file_path: z.string().max(1024).optional().describe('File path this decision is about'),
      tags: z.array(z.string().max(64)).max(20).optional().describe('Tags for categorization (e.g., ["auth", "security"])'),
    },
    async ({ title, content, type, service_name, symbol_id, file_path, tags }) => {
      const decision = decisionStore.addDecision({
        title,
        content,
        type: type as DecisionType,
        project_root: projectRoot,
        service_name,
        symbol_id,
        file_path,
        tags,
        source: 'manual',
        confidence: 1.0,
      });
      return { content: [{ type: 'text', text: j({ added: decision }) }] };
    },
  );

  // ── query_decisions ───────────────────────────────────────────────

  server.tool(
    'query_decisions',
    'Query the decision knowledge graph. Filter by type, subproject, code symbol, file path, tag, or time. Returns decisions linked to code — "why was this architecture chosen?" answered with the actual decision record. Use service_name to filter by a specific subproject within the project. Read-only. Returns JSON: { decisions: [{ id, title, type, content, tags }], total_results }.',
    {
      type: z.enum(DECISION_TYPES).optional().describe('Filter by decision type'),
      service_name: z.string().max(256).optional().describe('Filter by subproject name (e.g., "auth-api")'),
      symbol_id: z.string().max(512).optional().describe('Filter by linked symbol FQN'),
      file_path: z.string().max(1024).optional().describe('Filter by linked file path'),
      tag: z.string().max(64).optional().describe('Filter by tag'),
      search: z.string().max(500).optional().describe('Full-text search query (FTS5 with porter stemming)'),
      as_of: z.string().max(30).optional().describe('Only decisions active at this ISO timestamp'),
      include_invalidated: z.boolean().optional().describe('Include invalidated decisions (default: false)'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default: 50)'),
    },
    async ({ type, service_name, symbol_id, file_path, tag, search, as_of, include_invalidated, limit }) => {
      const decisions = decisionStore.queryDecisions({
        project_root: projectRoot,
        service_name,
        type: type as DecisionType | undefined,
        symbol_id,
        file_path,
        tag,
        search,
        as_of,
        include_invalidated,
        limit,
      });

      const stats = decisionStore.getStats(projectRoot);
      const serviceNames = getSubprojectNames();
      const result: Record<string, unknown> = { decisions, total_results: decisions.length, store_stats: stats };
      if (serviceNames.length > 0) {
        result.available_services = serviceNames;
      }
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  // ── invalidate_decision ───────────────────────────────────────────

  server.tool(
    'invalidate_decision',
    'Mark a decision as no longer valid. The decision remains in the knowledge graph for historical queries but is excluded from active queries. Use when a decision is superseded or reversed. Mutates the decision store; idempotent. Returns JSON: { invalidated: { id, title, valid_until } }.',
    {
      id: z.number().int().min(1).describe('Decision ID to invalidate'),
      valid_until: z.string().max(30).optional().describe('ISO timestamp when decision became invalid (default: now)'),
    },
    async ({ id, valid_until }) => {
      const ok = decisionStore.invalidateDecision(id, valid_until);
      if (!ok) {
        return { content: [{ type: 'text', text: j({ error: `Decision ${id} not found or already invalidated` }) }], isError: true };
      }
      const updated = decisionStore.getDecision(id);
      return { content: [{ type: 'text', text: j({ invalidated: updated }) }] };
    },
  );

  // ── get_decision_timeline ─────────────────────────────────────────

  server.tool(
    'get_decision_timeline',
    'Chronological timeline of decisions for a project, symbol, or file. Shows when decisions were made and invalidated — like git log but for architectural decisions. Read-only. Use to review decision history. Returns JSON: { timeline: [{ id, title, type, created_at, valid_until }], count }.',
    {
      symbol_id: z.string().max(512).optional().describe('Filter timeline to decisions about this symbol'),
      file_path: z.string().max(1024).optional().describe('Filter timeline to decisions about this file'),
      limit: z.number().int().min(1).max(200).optional().describe('Max entries (default: 100)'),
    },
    async ({ symbol_id, file_path, limit }) => {
      const timeline = decisionStore.getTimeline({
        project_root: projectRoot,
        symbol_id,
        file_path,
        limit,
      });
      return { content: [{ type: 'text', text: j({ timeline, count: timeline.length }) }] };
    },
  );

  // ── get_decision_stats ────────────────────────────────────────────

  server.tool(
    'get_decision_stats',
    'Overview of the decision knowledge graph: total decisions, active/invalidated counts, breakdown by type and source. Shows how much institutional knowledge is captured. Read-only. Returns JSON: { total, active, invalidated, by_type, by_source, sessions_mined }.',
    {},
    async () => {
      const stats = decisionStore.getStats(projectRoot);
      const minedCount = decisionStore.getMinedSessionCount();
      const chunkCount = decisionStore.getSessionChunkCount(projectRoot);
      const indexedSessions = decisionStore.getIndexedSessionIds(projectRoot);
      return { content: [{ type: 'text', text: j({ ...stats, sessions_mined: minedCount, sessions_indexed: indexedSessions.length, content_chunks: chunkCount }) }] };
    },
  );

  // ── index_sessions ────────────────────────────────────────────────

  server.tool(
    'index_sessions',
    'Index conversation content from Claude Code / Claw Code sessions for cross-session search. Stores chunked messages in FTS5 — enables "what did we discuss about X?" queries across all past sessions. Skips already-indexed sessions unless force=true. Mutates the session index; idempotent. Use before search_sessions. Returns JSON: { indexed, sessions_processed, chunks_stored }.',
    {
      project_root: z.string().max(1024).optional().describe('Only index sessions for this project path (default: current project)'),
      force: z.boolean().optional().describe('Re-index already processed sessions (default: false)'),
    },
    async ({ project_root, force }) => {
      const result = indexSessions(decisionStore, {
        projectRoot: project_root ?? projectRoot,
        force,
      });
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  // ── search_sessions ───────────────────────────────────────────────

  server.tool(
    'search_sessions',
    'Search across all past session conversations. Finds what was discussed, decided, or debugged in previous sessions. Full-text search with porter stemming — e.g., "why did we switch to GraphQL", "auth middleware bug", "database migration approach". Requires index_sessions to be run first. Read-only. Returns JSON: { results: [{ session_id, text, score }], total_results }.',
    {
      query: z.string().min(1).max(500).describe('Search query (FTS5 with porter stemming)'),
      limit: z.number().int().min(1).max(50).optional().describe('Max results (default: 20)'),
    },
    async ({ query, limit }) => {
      const chunkCount = decisionStore.getSessionChunkCount(projectRoot);
      if (chunkCount === 0) {
        return { content: [{ type: 'text', text: j({ message: 'No sessions indexed yet. Run index_sessions first to enable cross-session search.', hint: 'Call index_sessions to index past conversation content.' }) }] };
      }
      const results = decisionStore.searchSessions(query, {
        project_root: projectRoot,
        limit,
      });
      return { content: [{ type: 'text', text: j({ results, total_results: results.length, sessions_indexed: decisionStore.getIndexedSessionIds(projectRoot).length }) }] };
    },
  );

  // ── get_wake_up ───────────────────────────────────────────────────

  server.tool(
    'get_wake_up',
    'Compact orientation context (~300 tokens) for session start. Returns: project identity, active architectural decisions (linked to code symbols/files), and memory stats. Auto-mines sessions on first call if no decisions exist yet. Like MemPalace wake-up but code-aware — decisions are tied to the dependency graph. Use at session start for context recovery. For cross-session file/tool history use get_session_resume instead. Returns JSON: { project, decisions, stats }.',
    {
      max_decisions: z.number().int().min(1).max(30).optional().describe('Max recent decisions to include (default: 10)'),
      auto_mine: z.boolean().optional().describe('Auto-mine sessions if decision store is empty (default: true)'),
    },
    async ({ max_decisions, auto_mine }) => {
      // Auto-mine on first wake-up if store is empty
      const shouldAutoMine = auto_mine !== false;
      const stats = decisionStore.getStats(projectRoot);
      let mineResult;
      if (shouldAutoMine && stats.total === 0) {
        mineResult = await mineSessions(decisionStore, { projectRoot });
        // Also index session content for search
        const indexResult = indexSessions(decisionStore, { projectRoot });
        mineResult = { ...mineResult, ...indexResult };
      }

      const wakeUp = assembleWakeUp(decisionStore, projectRoot, {
        maxDecisions: max_decisions,
      });
      const payload: Record<string, unknown> = { ...wakeUp };
      if (mineResult) {
        payload.auto_mined = mineResult;
      }
      return { content: [{ type: 'text', text: j(payload) }] };
    },
  );
}
