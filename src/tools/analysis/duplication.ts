/**
 * Duplication detection: find symbols in a file that look like duplicates of
 * symbols elsewhere in the codebase.  Uses multi-signal scoring (name similarity,
 * kind match, signature similarity, FQN token overlap) to surface high-confidence
 * candidates only.
 */

import type Database from 'better-sqlite3';
import { fuzzySearch } from '../../db/fuzzy.js';
import type { Store } from '../../db/store.js';
import type { SymbolRow } from '../../db/types.js';

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

const _CHECKABLE_KINDS = new Set([
  'function',
  'class',
  'method',
  'interface',
  'type_alias',
  'enum',
]);

const _TRIVIAL_NAMES = new Set([
  'constructor',
  'toString',
  'toJSON',
  'valueOf',
  'render',
  'setup',
  'main',
  'index',
  'default',
  'init',
  'create',
  'get',
  'set',
  'delete',
  'update',
  'handle',
  'process',
  'run',
  'start',
  'stop',
  'reset',
  'configure',
  'register',
  'execute',
  'validate',
  'transform',
  'apply',
  'call',
  'bind',
  'map',
  'filter',
  'reduce',
  'forEach',
  'connect',
  'disconnect',
  'open',
  'close',
  'build',
  'destroy',
  'mount',
  'unmount',
  'dispose',
  'serialize',
  'deserialize',
]);

const _TEST_PATH_RE = /(?:^|[/\\])(?:tests?|__tests__|spec)[/\\]|\.(?:test|spec)\.[jt]sx?$/i;

const _MIN_NAME_LENGTH = 4;
const _MAX_SYMBOLS_PER_FILE = 30;

// Signal weights
const _W_NAME = 0.45;
const _W_KIND = 0.15;
const _W_SIGNATURE = 0.25;
const _W_TOKEN = 0.15;

// ─── Helpers ────────────────────────────────────────────────

/** Split camelCase / PascalCase / snake_case name into lowercase tokens */
function _tokenizeName(name: string): Set<string> {
  const parts = name
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[_\-./:]+/)
    .filter((p) => p.length > 1);
  return new Set(parts);
}

/** Jaccard similarity between two token sets */
function _jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Compute signature similarity from param counts. Returns 0–1. */
function _signatureSimilarity(srcParamCount: number | null, candParamCount: number | null): number {
  if (srcParamCount == null && candParamCount == null) return 0.5; // neutral
  if (srcParamCount == null || candParamCount == null) return 0.3; // partial info
  const max = Math.max(srcParamCount, candParamCount, 1);
  return 1 - Math.abs(srcParamCount - candParamCount) / max;
}

/** Extract heritage names (extends/implements) from metadata JSON */
function _getHeritageNames(metadata: string | null): Set<string> {
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

/**
 * Check a list of symbols against the rest of the codebase for potential duplicates.
 *
 * Bug class closed: prior to this restoration, `checkSymbolForDuplicates` and
 * `checkFileForDuplicates` referenced this helper but it had been deleted as
 * dead code — every real scan threw ReferenceError at runtime. The three call
 * sites are pinned by behavioural tests so they cannot drift again.
 */
function findDuplicateSymbols(
  store: Store,
  db: Database.Database,
  sourceSymbols: SymbolRowExtended[],
  sourceFileId: number,
  sourceFilePath: string,
  options?: {
    threshold?: number;
    maxResults?: number;
  },
): DuplicationResult {
  const threshold = options?.threshold ?? 0.7;
  const maxResults = options?.maxResults ?? 10;

  const sourceIsTest = _TEST_PATH_RE.test(sourceFilePath);

  // Collect heritage names from all source symbols' parents for exclusion
  const heritageNames = new Set<string>();
  for (const sym of sourceSymbols) {
    const h = _getHeritageNames(sym.metadata);
    for (const n of h) heritageNames.add(n);
  }

  // Filter source symbols to checkable ones
  const checkable = sourceSymbols
    .filter(
      (s) =>
        _CHECKABLE_KINDS.has(s.kind) &&
        s.name.length >= _MIN_NAME_LENGTH &&
        !_TRIVIAL_NAMES.has(s.name),
    )
    .slice(0, _MAX_SYMBOLS_PER_FILE);

  const allWarnings: DuplicationWarning[] = [];

  // Prepare param_count lookup: raw query since SymbolRow type doesn't include it
  const paramCountStmt = db.prepare<[number], { param_count: number | null }>(
    'SELECT param_count FROM symbols WHERE id = ?',
  );

  for (const src of checkable) {
    const srcParamCount = src.param_count ?? paramCountStmt.get(src.id)?.param_count ?? null;
    const srcTokens = _tokenizeName(src.fqn ?? src.name);

    // Find similar symbols via fuzzy search
    const candidates = fuzzySearch(db, src.name, {
      threshold: 0.25,
      limit: 30,
      kind: src.kind,
    });

    for (const cand of candidates) {
      // Skip same file
      if (cand.fileId === sourceFileId) continue;

      // Skip if candidate has exact same symbol ID (shouldn't happen, but guard)
      if (cand.symbolIdStr === src.symbol_id) continue;

      // Get candidate file path for test-double filtering
      const candFile = store.getFileById(cand.fileId);
      if (!candFile) continue;
      const candIsTest = _TEST_PATH_RE.test(candFile.path);

      // Skip test-double pairs (test ↔ source with same name)
      if (sourceIsTest !== candIsTest) continue;

      // Skip if candidate name matches a heritage class name (legitimate override)
      if (heritageNames.has(cand.name)) continue;

      // Check if candidate is an override of a shared base class
      const candSymbol = _getCandidateSymbol(db, cand.symbolId);
      if (candSymbol) {
        const candHeritage = _getHeritageNames(candSymbol.metadata);
        // If they share any heritage (both implement/extend same thing), skip
        for (const h of candHeritage) {
          if (heritageNames.has(h)) continue;
        }
      }

      // ── Scoring ──
      const nameSim = cand.similarity;
      const kindMatch = cand.kind === src.kind ? 1.0 : 0.0;

      const candParamCount =
        candSymbol?.param_count ?? paramCountStmt.get(cand.symbolId)?.param_count ?? null;
      const sigSim = _signatureSimilarity(srcParamCount, candParamCount);

      const candTokens = _tokenizeName(cand.fqn ?? cand.name);
      const tokenOvl = _jaccard(srcTokens, candTokens);

      const score =
        _W_NAME * nameSim + _W_KIND * kindMatch + _W_SIGNATURE * sigSim + _W_TOKEN * tokenOvl;

      if (score >= threshold) {
        allWarnings.push({
          source_symbol_id: src.symbol_id,
          source_name: src.name,
          source_file: sourceFilePath,
          duplicate_symbol_id: cand.symbolIdStr,
          duplicate_name: cand.name,
          duplicate_file: candFile.path,
          duplicate_line: candSymbol?.line_start ?? null,
          score: Math.round(score * 1000) / 1000,
          signals: {
            name_similarity: Math.round(nameSim * 1000) / 1000,
            kind_match: kindMatch,
            signature_similarity: Math.round(sigSim * 1000) / 1000,
            token_overlap: Math.round(tokenOvl * 1000) / 1000,
          },
        });
      }
    }
  }

  // Sort by score desc, deduplicate by (source, duplicate) pair, limit
  allWarnings.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const deduped: DuplicationWarning[] = [];
  for (const w of allWarnings) {
    const key = `${w.source_symbol_id}::${w.duplicate_symbol_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(w);
    if (deduped.length >= maxResults) break;
  }

  return {
    warnings: deduped,
    symbols_checked: checkable.length,
    threshold,
  };
}

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
    return { warnings: [], symbols_checked: 0, threshold: options?.threshold ?? 0.7 };
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
  const threshold = options?.threshold ?? 0.6;

  if (query.symbol_id) {
    // Look up actual symbol
    const row = db
      .prepare<[string], SymbolRowExtended>('SELECT * FROM symbols WHERE symbol_id = ?')
      .get(query.symbol_id);

    if (!row) {
      return { warnings: [], symbols_checked: 0, threshold };
    }

    const file = store.getFileById(row.file_id);
    return findDuplicateSymbols(store, db, [row], row.file_id, file?.path ?? '', {
      threshold,
      maxResults: options?.maxResults ?? 15,
    });
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

    return findDuplicateSymbols(store, db, [virtual], -1, '', {
      threshold,
      maxResults: options?.maxResults ?? 15,
    });
  }

  return { warnings: [], symbols_checked: 0, threshold };
}

// ─── Internals ──────────────────────────────────────────────

function _getCandidateSymbol(
  db: Database.Database,
  symbolId: number,
): SymbolRowExtended | undefined {
  return db
    .prepare<[number], SymbolRowExtended>('SELECT * FROM symbols WHERE id = ?')
    .get(symbolId);
}
