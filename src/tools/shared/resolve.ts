import type { Store } from '../../db/store.js';
import type { FileRow, SymbolRow } from '../../db/types.js';
import { isAbsolutePathLike, normalizeToProjectRelative } from '../../utils/security.js';

export interface ResolvedSymbol {
  symbol: SymbolRow;
  file: FileRow;
  /** How the symbol was resolved — useful for diagnostics */
  resolved_via: 'symbol_id' | 'fqn' | 'name_unique';
}

export type FlexibleResolvedVia =
  | ResolvedSymbol['resolved_via']
  | 'symbol_id_path_normalized'
  | 'symbol_id_kind_inferred';

/**
 * Rich symbol resolution (TRA-1660): exact id, then the two natural input
 * shapes agents actually send that used to NOT_FOUND:
 *
 *   - an absolute file part (`/root/src/foo.ts::Bar#class`), folded to the
 *     indexed relative spelling when it sits inside `projectRoot`;
 *   - a missing `#kind` suffix (`src/foo.ts::Bar`), resolved when it names
 *     exactly one symbol, surfaced as `ambiguous` with candidates otherwise;
 *   - a bare name (`Bar`), resolved only when globally unique.
 *
 * A cwd-relative file part (`sub/foo.ts` for indexed `root/sub/foo.ts`) is
 * resolved through the same unique-suffix rule as get_outline.
 */
export type FlexibleResolution =
  | { status: 'found'; symbol: SymbolRow; file: FileRow; resolvedVia: FlexibleResolvedVia }
  | { status: 'ambiguous'; candidates: string[] }
  | { status: 'miss' };

/** How many candidates an ambiguous miss carries — enough to pick, not a dump. */
const MAX_CANDIDATES = 5;

/**
 * Unified symbol resolution with cascading fallback (see resolveSymbolFlexible
 * for the full order: exact id → fqn → absolute-path fold → suffix-resolved
 * file part → kind-less `file::Name` → unique bare name).
 *
 * Legacy contract: returns the single match or null. Ambiguous guesses count
 * as no match here — callers that can surface candidates should use
 * resolveSymbolFlexible directly.
 */
export function resolveSymbolInput(
  store: Store,
  opts: { symbolId?: string; fqn?: string },
  extra?: { projectRoot?: string },
): ResolvedSymbol | null {
  const input = opts.symbolId ?? opts.fqn;
  if (!input) return null;
  const r = resolveSymbolFlexible(store, extra?.projectRoot, input);
  if (r.status !== 'found') return null;
  // The legacy vocabulary has no entries for the new fallbacks — they all
  // started life as a symbol_id guess, so report them as such.
  const resolved_via: ResolvedSymbol['resolved_via'] =
    r.resolvedVia === 'symbol_id_path_normalized' || r.resolvedVia === 'symbol_id_kind_inferred'
      ? 'symbol_id'
      : r.resolvedVia;
  return { symbol: r.symbol, file: r.file, resolved_via };
}

function withFile(
  store: Store,
  sym: SymbolRow | undefined,
): { sym: SymbolRow; file: FileRow } | null {
  if (!sym) return null;
  const file = store.getFileById(sym.file_id);
  if (!file) return null;
  return { sym, file };
}

export function resolveSymbolFlexible(
  store: Store,
  projectRoot: string | undefined,
  input: string,
): FlexibleResolution {
  // 1. Exact symbol_id, then exact fqn.
  const exact = withFile(store, store.getSymbolBySymbolId(input));
  if (exact)
    return { status: 'found', symbol: exact.sym, file: exact.file, resolvedVia: 'symbol_id' };
  const byFqn = withFile(store, store.getSymbolByFqn(input));
  if (byFqn) return { status: 'found', symbol: byFqn.sym, file: byFqn.file, resolvedVia: 'fqn' };

  const sep = input.indexOf('::');

  // 2. Bare name (no file part): resolve only when globally unique, so an
  // ambiguous short name surfaces candidates instead of an arbitrary row.
  if (sep < 0) {
    const matches = store.findSymbolsByName(input, MAX_CANDIDATES + 1);
    if (matches.length === 1) {
      const hit = withFile(store, matches[0]);
      if (hit)
        return { status: 'found', symbol: hit.sym, file: hit.file, resolvedVia: 'name_unique' };
      return { status: 'miss' };
    }
    if (matches.length > 1) {
      return {
        status: 'ambiguous',
        candidates: matches.slice(0, MAX_CANDIDATES).map((m) => m.symbol_id),
      };
    }
    if (input.includes('.')) {
      const lastDot = input.lastIndexOf('.');
      const methodName = input.slice(lastDot + 1);
      const subMatches = store.findSymbolsByName(methodName, MAX_CANDIDATES + 1);
      const filtered = subMatches.filter(
        (m) =>
          m.fqn === input ||
          (m.fqn && input.endsWith(`.${m.fqn}`)) ||
          m.symbol_id.includes(`::${input.replaceAll('.', '::')}`),
      );
      if (filtered.length === 1) {
        const hit = withFile(store, filtered[0]);
        if (hit) return { status: 'found', symbol: hit.sym, file: hit.file, resolvedVia: 'fqn' };
      } else if (filtered.length > 1) {
        return {
          status: 'ambiguous',
          candidates: filtered.slice(0, MAX_CANDIDATES).map((m) => m.symbol_id),
        };
      }
    }
    return { status: 'miss' };
  }

  // 3. `file::Name` shapes. The file part may be absolute (fold to relative
  // when it sits inside the project) or cwd-relative (unique-suffix rule).
  const rawFilePart = input.slice(0, sep);
  const rest = input.slice(sep + 2);
  let filePart = rawFilePart;
  if (projectRoot) {
    const folded = normalizeToProjectRelative(rawFilePart, projectRoot);
    if (folded !== rawFilePart) filePart = folded;
  }

  // 3a. Full id with `#kind`: retry the exact id against the folded / suffix-resolved file.
  if (rest.includes('#')) {
    const [namePart, kindPart] = rest.split('#');
    const nameVariants = [namePart];
    if (namePart.includes('.')) {
      nameVariants.push(namePart.replaceAll('.', '::'));
    }

    const testFiles = [filePart];
    if (filePart !== rawFilePart) {
      testFiles.push(rawFilePart);
    }
    const fileRow =
      store.resolveFile(filePart) ??
      (filePart !== rawFilePart ? store.resolveFile(rawFilePart) : undefined);
    if (fileRow && !testFiles.includes(fileRow.path)) {
      testFiles.push(fileRow.path);
    }

    for (const f of testFiles) {
      for (const n of nameVariants) {
        const hit = withFile(store, store.getSymbolBySymbolId(`${f}::${n}#${kindPart}`));
        if (hit) {
          return {
            status: 'found',
            symbol: hit.sym,
            file: hit.file,
            resolvedVia: 'symbol_id_path_normalized',
          };
        }
      }
    }
    return { status: 'miss' };
  }

  // 3b. Kind-less `file::Name`: candidates share the `file::Name#` prefix.
  // Prefer the canonical stored path so a cwd-relative or absolute file part
  // still matches the indexed spelling.
  const fileRow =
    store.resolveFile(filePart) ??
    (filePart !== rawFilePart ? store.resolveFile(rawFilePart) : undefined);
  const effectiveFile = fileRow?.path ?? filePart;
  const restVariants = [rest];
  if (rest.includes('.')) {
    restVariants.push(rest.replaceAll('.', '::'));
  }

  for (const r of restVariants) {
    const candidates = store.findSymbolsBySymbolIdPrefix(
      `${effectiveFile}::${r}`,
      MAX_CANDIDATES + 1,
    );
    if (candidates.length === 1) {
      const hit = withFile(store, candidates[0]);
      if (hit) {
        return {
          status: 'found',
          symbol: hit.sym,
          file: hit.file,
          resolvedVia: 'symbol_id_kind_inferred',
        };
      }
    } else if (candidates.length > 1) {
      return {
        status: 'ambiguous',
        candidates: candidates.slice(0, MAX_CANDIDATES).map((c) => c.symbol_id),
      };
    }
  }
  return { status: 'miss' };
}
