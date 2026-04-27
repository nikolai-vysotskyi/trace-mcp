/**
 * Session Content Indexer — indexes conversation content from Claude Code / Claw Code
 * JSONL session logs into searchable chunks. Enables cross-session semantic search:
 * "what did we discuss about auth last week?"
 *
 * Chunks are stored in the decision store's session_chunks table with FTS5.
 * Each chunk = one assistant or user message, truncated to ~500 tokens.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { listAllSessions } from '../analytics/log-parser.js';
import { logger } from '../logger.js';
import type { DecisionStore, SessionChunkInput } from './decision-store.js';

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

export interface IndexResult {
  sessions_scanned: number;
  sessions_indexed: number;
  sessions_skipped: number;
  chunks_added: number;
  errors: number;
  duration_ms: number;
}

// ════════════════════════════════════════════════════════════════════════
// CHUNKING
// ════════════════════════════════════════════════════════════════════════

/** Max chars per chunk (~500 tokens ≈ 2000 chars) */
const MAX_CHUNK_CHARS = 2000;

/** Minimum message length to index (skip trivial messages) */
const MIN_MESSAGE_CHARS = 50;

function extractTextFromMessage(msg: any): { text: string; files: string[] } {
  const textParts: string[] = [];
  const files: string[] = [];

  const content = msg.content;
  if (typeof content === 'string') {
    textParts.push(content);
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item === 'string') {
        textParts.push(item);
      } else if (typeof item === 'object' && item !== null) {
        if (item.type === 'text' && typeof item.text === 'string') {
          textParts.push(item.text);
        }
        if (item.type === 'tool_use' && item.input) {
          const input = item.input as Record<string, unknown>;
          if (typeof input.file_path === 'string') files.push(input.file_path);
          if (typeof input.path === 'string') files.push(input.path);
        }
      }
    }
  }

  const text = textParts.join('\n').trim();
  return { text, files };
}

function truncateChunk(text: string): string {
  if (text.length <= MAX_CHUNK_CHARS) return text;
  // Cut at last sentence boundary within limit
  const truncated = text.slice(0, MAX_CHUNK_CHARS);
  const lastPeriod = truncated.lastIndexOf('. ');
  if (lastPeriod > MAX_CHUNK_CHARS * 0.5) {
    return truncated.slice(0, lastPeriod + 1);
  }
  return `${truncated}...`;
}

// ════════════════════════════════════════════════════════════════════════
// INDEXER
// ════════════════════════════════════════════════════════════════════════

function indexSessionFile(
  filePath: string,
  projectPath: string,
  decisionStore: DecisionStore,
): number {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim());
  const sessionId = path.basename(filePath, '.jsonl');

  const chunks: SessionChunkInput[] = [];
  let chunkIndex = 0;

  for (const line of lines) {
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    const timestamp = record.timestamp || '';
    let role: 'user' | 'assistant' | null = null;
    let msg: any = null;

    // Claude Code format
    if (record.type === 'assistant' || record.type === 'user') {
      role = record.type;
      msg = record.message;
    }
    // Claw Code format
    if (record.type === 'message') {
      msg = record.message;
      if (msg?.role === 'assistant') role = 'assistant';
      else if (msg?.role === 'user') role = 'user';
    }

    if (!role || !msg) continue;

    const { text, files } = extractTextFromMessage(msg);
    if (text.length < MIN_MESSAGE_CHARS) continue;

    const truncated = truncateChunk(text);
    chunks.push({
      session_id: sessionId,
      project_root: projectPath,
      chunk_index: chunkIndex++,
      role,
      content: truncated,
      timestamp,
      referenced_files: files.length > 0 ? files : undefined,
    });
  }

  if (chunks.length > 0) {
    return decisionStore.addSessionChunks(chunks);
  }
  return 0;
}

/**
 * Index all Claude Code / Claw Code sessions for cross-session content search.
 * Skips already-indexed sessions (by session_id).
 */
export function indexSessions(
  decisionStore: DecisionStore,
  opts: {
    projectRoot?: string;
    force?: boolean;
  } = {},
): IndexResult {
  const start = Date.now();
  const sessions = listAllSessions();

  let scanned = 0;
  let indexed = 0;
  let skipped = 0;
  let chunksAdded = 0;
  let errors = 0;

  for (const session of sessions) {
    scanned++;

    if (opts.projectRoot && session.projectPath !== opts.projectRoot) {
      skipped++;
      continue;
    }

    const sessionId = path.basename(session.filePath, '.jsonl');
    if (!opts.force && decisionStore.isSessionIndexed(sessionId)) {
      skipped++;
      continue;
    }

    try {
      const added = indexSessionFile(session.filePath, session.projectPath, decisionStore);
      chunksAdded += added;
      indexed++;
    } catch (e) {
      logger.warn({ error: e, file: session.filePath }, 'Failed to index session content');
      errors++;
    }
  }

  return {
    sessions_scanned: scanned,
    sessions_indexed: indexed,
    sessions_skipped: skipped,
    chunks_added: chunksAdded,
    errors,
    duration_ms: Date.now() - start,
  };
}
