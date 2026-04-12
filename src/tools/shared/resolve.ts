import type { Store } from '../../db/store.js';
import type { SymbolRow, FileRow } from '../../db/types.js';

export interface ResolvedSymbol {
  symbol: SymbolRow;
  file: FileRow;
  /** How the symbol was resolved — useful for diagnostics */
  resolved_via: 'symbol_id' | 'fqn' | 'name_unique';
}

/**
 * Unified symbol resolution with cascading fallback:
 *   1. symbol_id → exact match
 *   2. fqn → exact match
 *   3. bare name → unique match via store.getSymbolByName (only if exactly 1 result)
 *
 * Returns null when no match is found at any level.
 */
export function resolveSymbolInput(
  store: Store,
  opts: { symbolId?: string; fqn?: string },
): ResolvedSymbol | null {
  let sym: SymbolRow | undefined;
  let resolvedVia: ResolvedSymbol['resolved_via'] = 'symbol_id';

  // 1. Try symbol_id (exact)
  if (opts.symbolId) {
    sym = store.getSymbolBySymbolId(opts.symbolId);
    resolvedVia = 'symbol_id';

    // 2. If symbol_id didn't match, try as fqn
    if (!sym) {
      sym = store.getSymbolByFqn(opts.symbolId);
      if (sym) resolvedVia = 'fqn';
    }

    // 3. If still no match, try as bare name (unique only)
    if (!sym) {
      sym = store.getSymbolByName(opts.symbolId);
      if (sym) resolvedVia = 'name_unique';
    }
  } else if (opts.fqn) {
    // 1. Try fqn (exact)
    sym = store.getSymbolByFqn(opts.fqn);
    resolvedVia = 'fqn';

    // 2. If fqn didn't match, try as bare name (unique only)
    if (!sym) {
      sym = store.getSymbolByName(opts.fqn);
      if (sym) resolvedVia = 'name_unique';
    }
  }

  if (!sym) return null;

  const file = store.getFileById(sym.file_id);
  if (!file) return null;

  return { symbol: sym, file, resolved_via: resolvedVia };
}
