/**
 * Global paths and helpers for ~/.trace-mcp/ directory structure.
 *
 * All trace-mcp state lives here:
 *   ~/.trace-mcp/.config.json          — global config
 *   ~/.trace-mcp/registry.json         — project registry
 *   ~/.trace-mcp/index/<name>-<hash>.db — per-project databases
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Root of all trace-mcp global state.
 *
 * Default: `~/.trace-mcp/`. Override with `TRACE_MCP_DATA_DIR=<path>` for
 * Docker volumes, ephemeral CI workspaces, multi-repo orchestrators, or
 * shared cache locations. CRG v2.3.0 (#155) introduced the same knob — the
 * env var replaces the default verbatim, with `~` expansion. Resolved at
 * import time so a user-facing change requires a process restart.
 */
export const TRACE_MCP_HOME = (() => {
  const override = process.env.TRACE_MCP_DATA_DIR;
  if (override && override.length > 0) {
    const expanded = override.startsWith('~')
      ? path.join(os.homedir(), override.slice(1))
      : override;
    return path.resolve(expanded);
  }
  return path.join(os.homedir(), '.trace-mcp');
})();

/** Global config file (replaces per-project .trace-mcp.json). */
export const GLOBAL_CONFIG_PATH = path.join(TRACE_MCP_HOME, '.config.json');

/** Directory for per-project SQLite databases. */
const INDEX_DIR = path.join(TRACE_MCP_HOME, 'index');

/** Global project registry. */
export const REGISTRY_PATH = path.join(TRACE_MCP_HOME, 'registry.json');

/** Topology database (cross-service graph). */
export const TOPOLOGY_DB_PATH = path.join(TRACE_MCP_HOME, 'topology.db');

/** Decision memory database (cross-session knowledge graph). */
export const DECISIONS_DB_PATH = path.join(TRACE_MCP_HOME, 'decisions.db');

/** Default port the daemon listens on. */
export const DEFAULT_DAEMON_PORT = 3741;

/** Daemon log file path. */
export const DAEMON_LOG_PATH = path.join(TRACE_MCP_HOME, 'daemon.log');

/** launchd plist path for auto-start on macOS. */
export const LAUNCHD_PLIST_PATH = path.join(
  os.homedir(),
  'Library',
  'LaunchAgents',
  'com.trace-mcp.server.plist',
);

/**
 * Default global config template with all supported parameters.
 * Written to ~/.trace-mcp/.config.json on first run so users can edit values
 * instead of looking up parameter names in docs.
 */
/**
 * Strip single-line // comments from JSONC text and fix trailing commas.
 * Handles // inside quoted strings correctly.
 */
export function stripJsonComments(text: string): string {
  let result = '';
  let i = 0;
  while (i < text.length) {
    // String literal — copy verbatim
    if (text[i] === '"') {
      const start = i;
      i++; // opening quote
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') i++; // skip escaped char
        i++;
      }
      i++; // closing quote
      result += text.slice(start, i);
      continue;
    }
    // Line comment — skip to end of line
    if (text[i] === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    result += text[i];
    i++;
  }
  // Remove trailing commas before } or ]
  return result.replace(/,(\s*[}\]])/g, '$1');
}

/** Default config template as JSONC (with comments). */
export const DEFAULT_CONFIG_JSONC = `{
  // ── AI / Embeddings ──────────────────────────────────────────────
  "ai": {
    "enabled": false,
    "provider": "onnx",                          // "onnx" (local, zero-config) | "ollama" | "openai"
    // "base_url": "http://localhost:11434",     // custom endpoint (ollama/openai)
    // "api_key": "",                            // required for openai; or set OPENAI_API_KEY env
    // "inference_model": "gemma4:e4b",          // ollama: "gemma4:e4b", openai: "gpt-4o-mini"
    // "fast_model": "gemma4:e4b",               // ollama: "gemma4:e4b", openai: "gpt-4o-mini"
    // "embedding_model": "",                    // onnx: "Xenova/all-MiniLM-L6-v2", ollama: "qwen3-embedding:0.6b", openai: "text-embedding-3-small"
    // "embedding_dimensions": 384,              // onnx: 384, openai: 1536
    "summarize_on_index": false,
    "summarize_batch_size": 20,
    "summarize_kinds": ["class", "function", "method", "interface", "trait", "enum", "type"],
    "concurrency": 1                            // match OLLAMA_NUM_PARALLEL for ollama
    // "reranker_model": ""                      // optional: e.g. "bge-reranker-v2-m3"
  },

  // ── Security ─────────────────────────────────────────────────────
  "security": {
    // "secret_patterns": [],                    // extra regex patterns to detect secrets
    // "max_file_size_bytes": 1048576,           // skip files larger than this (1 MB)
    // "max_files": 10000                        // max files per project
  },

  // ── Predictive analysis ──────────────────────────────────────────
  "predictive": {
    "enabled": true,
    "weights": {
      "bug":         { "churn": 0.20, "fix_ratio": 0.20, "complexity": 0.20, "coupling": 0.15, "pagerank": 0.10, "authors": 0.15 },
      "tech_debt":   { "complexity": 0.30, "coupling": 0.25, "test_gap": 0.25, "churn": 0.20 },
      "change_risk": { "blast_radius": 0.25, "complexity": 0.20, "churn": 0.20, "test_gap": 0.20, "coupling": 0.15 }
    },
    "cache_ttl_minutes": 60,
    "git_since_days": 180,
    "module_depth": 2
  },

  // ── Intent / domain classification ───────────────────────────────
  "intent": {
    "enabled": false,
    // "domain_hints": {},                       // { "domain_name": ["path/pattern/**"] }
    // "custom_domains": [],                     // [{ "name": "...", "path_patterns": ["..."] }]
    "auto_classify_on_index": true,
    "classify_batch_size": 100
  },

  // ── Runtime tracing (OpenTelemetry) ──────────────────────────────
  "runtime": {
    "enabled": false,
    "otlp": {
      "port": 4318,
      "host": "127.0.0.1",
      "max_body_bytes": 4194304
    },
    "retention": {
      "max_span_age_days": 7,
      "max_aggregate_age_days": 90,
      "prune_interval": 100
    },
    "mapping": {
      "fqn_attributes": ["code.function", "code.namespace", "code.filepath"],
      "route_patterns": ["^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\\\\s+(.+)$"]
    }
  },

  // ── Cross-repo topology ──────────────────────────────────────────
  "topology": {
    "enabled": true,
    // "repos": [],                              // extra repo paths for subprojects
    "auto_detect": true,
    "auto_discover": true
    // "contract_globs": []                      // globs for API contract files
  },

  // ── Quality gates ────────────────────────────────────────────────
  "quality_gates": {
    "enabled": true,
    "fail_on": "error",                          // "error" | "warning" | "none"
    "rules": {
      // "max_cyclomatic_complexity":       { "threshold": 20, "severity": "error" },
      // "max_coupling_instability":        { "threshold": 0.8, "severity": "warning" },
      // "max_circular_import_chains":      { "threshold": 0, "severity": "error" },
      // "max_dead_exports_percent":        { "threshold": 10, "severity": "warning" },
      // "max_tech_debt_grade":             { "threshold": "C", "severity": "warning" },
      // "max_security_critical_findings":  { "threshold": 0, "severity": "error" },
      // "max_antipattern_count":           { "threshold": 5, "severity": "warning" },
      // "max_code_smell_count":            { "threshold": 10, "severity": "warning" }
    }
  },

  // ── Tool exposure ────────────────────────────────────────────────
  "tools": {
    "preset": "full",                            // "full" | "minimal" | custom preset name
    // "include": [],                            // whitelist specific tools
    // "exclude": [],                            // blacklist specific tools
    // "descriptions": {},                       // override tool descriptions
    "description_verbosity": "full",             // "full" | "minimal" | "none"
    "instructions_verbosity": "full",            // "full" | "minimal" | "none"
    "agent_behavior": "off",                     // "strict" | "minimal" | "off" — behavior rules (anti-sycophancy, goal-driven, etc.). Max-tier init sets to "strict".
    "meta_fields": true                          // true | false | ["_hints", "_budget_warning", ...]
  },

  // ── Indexing ignore rules ────────────────────────────────────────
  "ignore": {
    "directories": [],                           // extra directory names to skip
    "patterns": []                               // extra gitignore-style patterns
  },

  // ── Framework-specific ───────────────────────────────────────────
  "frameworks": {
    "laravel": {
      "artisan": { "enabled": true, "timeout": 10000 },
      "graceful_degradation": true
    }
  },

  // ── Logging ───────────────────────────────────────────────────────
  "logging": {
    "file": false,                                 // enable file logging
    "path": "~/.trace-mcp/run.log",                // log file location
    "level": "info",                               // "trace" | "debug" | "info" | "warn" | "error" | "fatal"
    "max_size_mb": 10                              // rotate when log exceeds this size
  },

  // ── File watcher ─────────────────────────────────────────────────
  "watch": {
    "enabled": true,
    "debounceMs": 2000
  },

  // ── Per-project overrides ────────────────────────────────────────
  // Keys are absolute paths; values override any top-level setting for that project.
  // Example:
  // "projects": {
  //   "/path/to/project": {
  //     "ai": { "enabled": true, "concurrency": 4 },
  //     "include": ["src/**/*.ts"],
  //     "exclude": ["dist/**"]
  //   }
  // }
  "projects": {}
}
`;

/** Ensure ~/.trace-mcp/ and ~/.trace-mcp/index/ exist. */
export function ensureGlobalDirs(): void {
  fs.mkdirSync(INDEX_DIR, { recursive: true });

  // Seed default config on first run so users see all available parameters
  if (!fs.existsSync(GLOBAL_CONFIG_PATH)) {
    fs.writeFileSync(GLOBAL_CONFIG_PATH, DEFAULT_CONFIG_JSONC);
  }
}

/** Stable 12-char hex hash of an absolute path. */
export function projectHash(absolutePath: string): string {
  return crypto.createHash('sha256').update(absolutePath).digest('hex').slice(0, 12);
}

/** Sanitized project name from path basename. */
export function projectName(absolutePath: string): string {
  return path.basename(absolutePath).replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** Path to the live session snapshot file (read by PreCompact hook). */
export function getSnapshotPath(projectRoot: string): string {
  const absRoot = path.resolve(projectRoot);
  return path.join(TRACE_MCP_HOME, 'sessions', `${projectHash(absRoot)}-snapshot.json`);
}

/** Compute global DB path for a project root. */
export function getDbPath(projectRoot: string): string {
  const absRoot = path.resolve(projectRoot);
  return path.join(INDEX_DIR, `${projectName(absRoot)}-${projectHash(absRoot)}.db`);
}
