import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { logger } from '../logger.js';

// --- Interfaces ---

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

export interface ToolCallEvent {
  toolId: string;
  sessionId: string;
  timestamp: string;
  model: string;
  toolName: string; // full name: "Read", "mcp__jcodemunch__search"
  toolServer: string; // "builtin", "jcodemunch", "phpstorm", etc.
  toolShortName: string; // "Read", "search", "search_symbol"
  inputParams: Record<string, unknown>;
  inputSizeChars: number;
  targetFile?: string; // extracted from input params
}

export interface ToolResultEvent {
  toolId: string;
  outputSizeChars: number;
  isError: boolean;
}

interface SessionSummary {
  sessionId: string;
  projectPath: string;
  startedAt: string;
  endedAt: string;
  model: string;
  usage: TokenUsage;
  toolCallCount: number;
}

export interface ParsedSession {
  summary: SessionSummary;
  toolCalls: ToolCallEvent[];
  toolResults: Map<string, ToolResultEvent>;
}

type ClientType = 'claude-code' | 'claw-code' | 'hermes';

// --- Constants ---

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const CLAW_SESSIONS_DIR_NAME = '.claw/sessions'; // per-project: <project>/.claw/sessions/

// --- Helpers ---

/** Extract server name from tool name. "mcp__server__tool" → "server", "Read" → "builtin" */
export function parseToolName(fullName: string): { server: string; shortName: string } {
  const match = fullName.match(/^mcp__([^_]+)__(.+)$/);
  if (match) return { server: match[1], shortName: match[2] };
  return { server: 'builtin', shortName: fullName };
}

/** Extract target file from tool input params */
export function extractTargetFile(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  // Built-in tools
  if (input.file_path && typeof input.file_path === 'string') return input.file_path;
  if (input.path && typeof input.path === 'string') return input.path;
  // Bash commands with cat/head/tail
  if (toolName === 'Bash' && typeof input.command === 'string') {
    const m = input.command.match(
      /(?:cat|head|tail|less|more)\s+(?:-[a-zA-Z0-9]+\s+)*["']?([^\s"'|;>-][^\s"'|;>]*)/,
    );
    if (m) return m[1];
  }
  return undefined;
}

// --- Parser ---

/** Parse tool_use input — Claw Code stores it as a JSON string, Claude Code as an object */
function parseToolInput(input: unknown): Record<string, unknown> {
  if (typeof input === 'string') {
    try {
      return JSON.parse(input);
    } catch {
      return {};
    }
  }
  if (input && typeof input === 'object') return input as Record<string, unknown>;
  return {};
}

/** Process an assistant message (shared between Claude Code and Claw Code) */
function processAssistantMessage(
  msg: any,
  timestamp: string,
  sessionId: string,
  model: string,
  usage: TokenUsage,
  toolCalls: ToolCallEvent[],
): { model: string; toolCallCount: number } {
  let currentModel = model;
  let toolCallCount = 0;

  if (msg.model && !currentModel) currentModel = msg.model;

  // Accumulate usage
  if (msg.usage) {
    usage.inputTokens += msg.usage.input_tokens || 0;
    usage.outputTokens += msg.usage.output_tokens || 0;
    usage.cacheReadTokens += msg.usage.cache_read_input_tokens || 0;
    usage.cacheCreateTokens += msg.usage.cache_creation_input_tokens || 0;
  }

  // Extract tool calls
  const content = msg.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item !== 'object' || item === null) continue;
      if (item.type === 'tool_use') {
        const { server, shortName } = parseToolName(item.name || '');
        const inputParams = parseToolInput(item.input);
        const inputJson = JSON.stringify(inputParams);
        toolCalls.push({
          toolId: item.id || '',
          sessionId,
          timestamp,
          model: msg.model || currentModel,
          toolName: item.name || '',
          toolServer: server,
          toolShortName: shortName,
          inputParams,
          inputSizeChars: inputJson.length,
          targetFile: extractTargetFile(item.name || '', inputParams),
        });
        toolCallCount++;
      }
    }
  }

  return { model: currentModel, toolCallCount };
}

/** Process a tool result (shared between Claude Code and Claw Code) */
function processToolResult(item: any, toolResults: Map<string, ToolResultEvent>): void {
  const resultContent = item.content || item.output || '';
  const outputSize =
    typeof resultContent === 'string' ? resultContent.length : JSON.stringify(resultContent).length;
  const toolId = item.tool_use_id || '';
  toolResults.set(toolId, {
    toolId,
    outputSizeChars: outputSize,
    isError: !!item.is_error,
  });
}

/** Parse a single JSONL session file (supports both Claude Code and Claw Code formats) */
export function parseSessionFile(filePath: string, projectPath: string): ParsedSession | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());

    const sessionId = path.basename(filePath, '.jsonl');
    const toolCalls: ToolCallEvent[] = [];
    const toolResults = new Map<string, ToolResultEvent>();
    let model = '';
    let startedAt = '';
    let endedAt = '';
    const usage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    };
    let toolCallCount = 0;

    for (const line of lines) {
      let record: any;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }

      const timestamp = record.timestamp || '';
      if (!startedAt && timestamp) startedAt = timestamp;
      if (timestamp) endedAt = timestamp;

      // --- Claude Code format: type = "assistant" | "user" ---
      if (record.type === 'assistant') {
        const msg = record.message;
        if (!msg) continue;
        const result = processAssistantMessage(msg, timestamp, sessionId, model, usage, toolCalls);
        model = result.model;
        toolCallCount += result.toolCallCount;
      }

      if (record.type === 'user') {
        const msg = record.message;
        if (!msg) continue;
        const msgContent = msg.content;
        if (Array.isArray(msgContent)) {
          for (const item of msgContent) {
            if (typeof item !== 'object' || item === null) continue;
            if (item.type === 'tool_result') processToolResult(item, toolResults);
          }
        }
      }

      // --- Claw Code format: type = "message", message.role differentiates ---
      if (record.type === 'message') {
        const msg = record.message;
        if (!msg) continue;

        if (msg.role === 'assistant') {
          const result = processAssistantMessage(
            msg,
            timestamp,
            sessionId,
            model,
            usage,
            toolCalls,
          );
          model = result.model;
          toolCallCount += result.toolCallCount;
        }

        if (msg.role === 'tool') {
          // Claw Code: tool results are messages with role "tool" and ToolResult content blocks
          const msgContent = msg.content;
          if (Array.isArray(msgContent)) {
            for (const item of msgContent) {
              if (typeof item !== 'object' || item === null) continue;
              if (item.type === 'tool_result') processToolResult(item, toolResults);
            }
          }
        }
      }

      // --- Claw Code session_meta record (contains session_id) ---
      if (record.type === 'session_meta') {
        if (record.session_id && !startedAt) {
          // Use created_at_ms if available
          if (record.created_at_ms) {
            startedAt = new Date(record.created_at_ms).toISOString();
          }
        }
      }
    }

    if (toolCallCount === 0 && usage.inputTokens === 0) return null;

    return {
      summary: {
        sessionId,
        projectPath,
        startedAt,
        endedAt,
        model,
        usage,
        toolCallCount,
      },
      toolCalls,
      toolResults,
    };
  } catch (e) {
    logger.warn({ error: e, file: filePath }, 'Failed to parse session file');
    return null;
  }
}

// --- Discovery ---

/** List all project directories in ~/.claude/projects/ */
/**
 * Decode a Claude Code project directory name back to a filesystem path.
 * Claude encodes `/` as `-`, so `-Users-username-Projects-trace-mcp` could be
 * `/Users/username/Projects/trace-mcp` or `/Users/username/Projects/trace/mcp`.
 * We resolve ambiguity by checking which path exists on disk.
 */
function decodeDirName(dirName: string): string {
  // Claude Code encodes "/" as "-" in directory names.
  // `/Users/username/Projects/trace-mcp` → `-Users-username-Projects-trace-mcp`
  // We decode by checking which intermediate paths are real directories.
  const raw = dirName.replace(/^-/, '/');
  const parts = raw.split('-');

  // `base` = last confirmed directory (joined with "/")
  // `tail` = accumulated segments that form the final name (joined with "-")
  let base = parts[0]; // "" after leading /
  let tail = '';

  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i];
    // Try: base + "/" + (tail ? tail + "-" + seg : seg) — is this a directory?
    const candidate = base + '/' + (tail ? tail + '-' + seg : seg);
    try {
      if (fs.statSync(candidate).isDirectory()) {
        // It's a real directory → commit as new base
        base = candidate;
        tail = '';
        continue;
      }
    } catch {
      /* not a dir */
    }

    // Also try: base + "/" + seg (ignoring tail) — maybe tail should have been a dir?
    if (tail) {
      const slashCandidate = base + '/' + tail;
      try {
        if (fs.statSync(slashCandidate).isDirectory()) {
          // tail was actually a directory name, commit it
          base = slashCandidate;
          tail = seg;
          continue;
        }
      } catch {
        /* not a dir */
      }
    }

    // Accumulate into tail (literal dash in name)
    tail = tail ? tail + '-' + seg : seg;
  }

  return tail ? base + '/' + tail : base;
}

function listProjectDirs(): { dirName: string; projectPath: string }[] {
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return [];
  const entries = fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => ({
      dirName: e.name,
      projectPath: decodeDirName(e.name),
    }));
}

/** List all JSONL session files in a project directory */
function listSessionFiles(projectDirName: string): { filePath: string; mtime: number }[] {
  const dir = path.join(CLAUDE_PROJECTS_DIR, projectDirName);
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => {
      const filePath = path.join(dir, e.name);
      const stat = fs.statSync(filePath);
      return { filePath, mtime: stat.mtimeMs };
    });
}

/** List all session files across all projects (Claude Code) */
export function listAllSessions(): {
  filePath: string;
  projectPath: string;
  client: ClientType;
  mtime: number;
}[] {
  const results: { filePath: string; projectPath: string; client: ClientType; mtime: number }[] =
    [];

  // Claude Code: ~/.claude/projects/<encoded-path>/<session-id>.jsonl
  for (const { dirName, projectPath } of listProjectDirs()) {
    for (const { filePath, mtime } of listSessionFiles(dirName)) {
      results.push({ filePath, projectPath, client: 'claude-code', mtime });
    }
  }

  // Claw Code: <project>/.claw/sessions/<session-id>.jsonl
  // Discover by scanning known project paths from Claude Code sessions + registry
  const clawProjectPaths = discoverClawProjects();
  for (const projectPath of clawProjectPaths) {
    const sessionsDir = path.join(projectPath, CLAW_SESSIONS_DIR_NAME);
    if (!fs.existsSync(sessionsDir)) continue;
    try {
      const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
        const filePath = path.join(sessionsDir, e.name);
        try {
          const stat = fs.statSync(filePath);
          results.push({ filePath, projectPath, client: 'claw-code', mtime: stat.mtimeMs });
        } catch {
          /* skip */
        }
      }
    } catch {
      /* skip */
    }
  }

  return results;
}

/** Discover project paths that might have Claw Code sessions */
function discoverClawProjects(): string[] {
  const paths = new Set<string>();

  // 1. Check project paths from Claude Code sessions (they might also use Claw Code)
  for (const { projectPath } of listProjectDirs()) {
    if (fs.existsSync(path.join(projectPath, CLAW_SESSIONS_DIR_NAME))) {
      paths.add(projectPath);
    }
  }

  // 2. Check current working directory
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, CLAW_SESSIONS_DIR_NAME))) {
    paths.add(cwd);
  }

  // 3. Scan home directory for .claw/sessions in common project locations
  const home = os.homedir();
  const commonRoots = [
    'Projects',
    'projects',
    'dev',
    'workspace',
    'code',
    'PhpstormProjects',
    'WebstormProjects',
    'src',
  ];
  for (const root of commonRoots) {
    const rootDir = path.join(home, root);
    if (!fs.existsSync(rootDir)) continue;
    try {
      const entries = fs.readdirSync(rootDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const projectDir = path.join(rootDir, e.name);
        if (fs.existsSync(path.join(projectDir, CLAW_SESSIONS_DIR_NAME))) {
          paths.add(projectDir);
        }
      }
    } catch {
      /* skip */
    }
  }

  return [...paths];
}
