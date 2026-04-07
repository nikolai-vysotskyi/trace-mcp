/**
 * Duplication detection: find symbols in a file that look like duplicates of
 * symbols elsewhere in the codebase.  Uses multi-signal scoring (name similarity,
 * kind match, signature similarity, FQN token overlap) to surface high-confidence
 * candidates only.
 */

import type Database from 'better-sqlite3';
import type { Store } from '../../db/store.js';
import type { SymbolRow } from '../../db/types.js';
import { fuzzySearch, type FuzzyMatch } from '../../db/fuzzy.js';

// ─── Types ──────────────────────────────────────────────────

export interface DuplicationWarning {
  source_symbol_id: string;
  source_name: string;
  source_file: string;
  duplicate_symbol_id: string;
  duplicate_name: string;
  duplicate_file: string;
  duplicate_line: number | null;
  score: number;
  signals: {
    name_similarity: number;
    kind_match: number;
    signature_similarity: number;
    token_overlap: number;
  };
}

export interface DuplicationResult {
  warnings: DuplicationWarning[];
  symbols_checked: number;
  threshold: number;
}

// ─── Constants ──────────────────────────────────────────────

const CHECKABLE_KINDS = new Set([
  'function', 'class', 'method', 'interface', 'type_alias', 'enum',
]);

const TRIVIAL_NAMES = new Set([
  'constructor', 'toString', 'toJSON', 'valueOf', 'render', 'setup',
  'main', 'index', 'default', 'init', 'create', 'get', 'set', 'delete',
  'update', 'handle', 'process', 'run', 'start', 'stop', 'reset',
  'configure', 'register', 'execute', 'validate', 'transform',
  'apply', 'call', 'bind', 'map', 'filter', 'reduce', 'forEach',
  'connect', 'disconnect', 'open', 'close', 'build', 'destroy',
  'mount', 'unmount', 'dispose', 'serialize', 'deserialize',
]);

const TEST_PATH_RE = /(?:^|[/\\])(?:tests?|__tests__|spec)[/\\]|\.(?:test|spec)\.[jt]sx?$/i;

const MIN_NAME_LENGTH = 4;
const MAX_SYMBOLS_PER_FILE = 30;

// Signal weights
const W_NAME = 0.45;
const W_KIND = 0.15;
const W_SIGNATURE = 0.25;
const W_TOKEN = 0.15;

// ─── Helpers ────────────────────────────────────────────────

/** Split camelCase / PascalCase / snake_case name into lowercase tokens */
function tokenizeName(name: string): Set<string> {
  const parts = name
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[_\-./:]+/)
    .filter((p) => p.length > 1);
  return new Set(parts);
}

/** Jaccard similarity between two token sets */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Compute signature similarity from param counts. Returns 0–1. */
function signatureSimilarity(srcParamCount: number | null, candParamCount: number | null): number {
  if (srcParamCount == null && candParamCount == null) return 0.5; // neutral
  if (srcParamCount == null || candParamCount == null) return 0.3; // partial info
  const max = Math.max(srcParamCount, candParamCount, 1);
  return 1 - Math.abs(srcParamCount - candParamCount) / max;
}

/** Extract heritage names (extends/implements) from metadata JSON */
function getHeritageNames(metadata: string | null): Set<string> {
  if (!metadata) return new Set();
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    const names = new Set<string>();
    if (typeof parsed.extends === 'string') names.add(parsed.extends);
    if (Array.isArray(parsed.extends)) {
      for (const e of parsed.extends) if (typeof e === 'string') names.add(e);
    }
    if (typeof parsed.implements === 'string') names.add(parsed.implements);
    if (Array.isArray(parsed.implements)) {
      for (const i of parsed.implements) if (typeof i === 'string') names.add(i);
    }
    return names;
  } catch {
    return new Set();
  }
}

// ─── Extended symbol row (includes columns not in the TS type) ───

interface SymbolRowExtended extends SymbolRow {
  cyclomatic?: number | null;
  max_nesting?: number | null;
  param_count?: number | null;
}

// ─── Core ───────────────────────────────────────────────────

// ─── Convenience wrappers ───────────────────────────────────

/**
 * Check all symbols in a file against the rest of the codebase.
 * Called from register_edit after reindex.
 */
export function checkFileForDuplicates(
  store: Store,
  db: Database.Database,
  filePath: string,
  options?: { threshold?: number; maxResults?: number },
): DuplicationResult {
  const file = store.getFile(filePath);
  if (!file) {
    return { warnings: [], symbols_checked: 0, threshold: options?.threshold ?? 0.70 };
  }

  const symbols = store.getSymbolsByFile(file.id) as SymbolRowExtended[];
  return findDuplicateSymbols(store, db, symbols, file.id, filePath, options);
}

/**
 * Check a single symbol by ID or by name+kind against the codebase.
 * Called from the check_duplication tool.
 */
export function checkSymbolForDuplicates(
  store: Store,
  db: Database.Database,
  query: { symbol_id?: string; name?: string; kind?: string },
  options?: { threshold?: number; maxResults?: number },
): DuplicationResult {
  const threshold = options?.threshold ?? 0.60;

  if (query.symbol_id) {
    // Look up actual symbol
    const row = db.prepare<[string], SymbolRowExtended>(
      'SELECT * FROM symbols WHERE symbol_id = ?',
    ).get(query.symbol_id);

    if (!row) {
      return { warnings: [], symbols_checked: 0, threshold };
    }

    const file = store.getFileById(row.file_id);
    return findDuplicateSymbols(store, db, [row], row.file_id, file?.path ?? '', { threshold, maxResults: options?.maxResults ?? 15 });
  }

  if (query.name) {
    // Create a virtual symbol for name-based search
    const virtual: SymbolRowExtended = {
      id: -1,
      file_id: -1,
      symbol_id: '__virtual__',
      name: query.name,
      kind: query.kind ?? 'function',
      fqn: null,
      parent_id: null,
      signature: null,
      summary: null,
      byte_start: 0,
      byte_end: 0,
      line_start: null,
      line_end: null,
      metadata: null,
      param_count: null,
    };

    return findDuplicateSymbols(store, db, [virtual], -1, '', { threshold, maxResults: options?.maxResults ?? 15 });
  }

  return { warnings: [], symbols_checked: 0, threshold };
}

// ─── Internals ──────────────────────────────────────────────

function getCandidateSymbol(db: Database.Database, symbolId: number): SymbolRowExtended | undefined {
  return db.prepare<[number], SymbolRowExtended>(
    'SELECT * FROM symbols WHERE id = ?',
  ).get(symbolId);
}
