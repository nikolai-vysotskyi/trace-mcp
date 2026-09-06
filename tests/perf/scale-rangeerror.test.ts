/**
 * Above V8's argument limit — the size band where a whole defect class lives.
 *
 * GitHub #957: `search` returned the bare string "Maximum call stack size
 * exceeded" for every query against a 152 734-symbol index, deterministically,
 * while `search_text` on the same index worked and the same query on a
 * ~100-file repo worked. Cause: `Math.min(...xs)` passes every element as a
 * separate argument, and V8 throws `RangeError` past ~65k-125k of them.
 *
 * The unit test in `src/util/__tests__/minmax.test.ts` covers the helper. This
 * file covers the class: real tool entry points, against an index big enough
 * for the ceiling to be reachable. Nothing smaller can catch the next one,
 * because the next one will also be a different array in a different function.
 *
 * Sized at 150 000 symbols to sit above the *upper* end of the V8 range rather
 * than the lower one — a fixture at 70k passes on a machine with a deeper
 * stack and gives a green CI for a crash the user still gets.
 */
import { describe, expect, it } from 'vitest';
import { getFeatureContext } from '../../src/tools/navigation/context.js';
import { search } from '../../src/tools/navigation/navigation.js';
import { runFlatSearch } from '../../src/tools/navigation/search-dispatcher.js';
import { seedLargeIndex } from './large-index.js';

const FILES = 15_000;
const SYMBOLS_PER_FILE = 10; // 150 000 symbols, 165 000 graph nodes

describe('tools above V8 argument limit (#957)', () => {
  const { store } = seedLargeIndex(FILES, SYMBOLS_PER_FILE, { symbolEdges: true });

  it('builds an index past the threshold the defect class needs', () => {
    const symbols = store.db.prepare('SELECT COUNT(*) c FROM symbols').get() as { c: number };
    expect(symbols.c).toBe(FILES * SYMBOLS_PER_FILE);
    // The guard on the guard: if a future refactor shrinks this fixture back
    // under the ceiling, every assertion below passes for the wrong reason.
    expect(symbols.c).toBeGreaterThan(125_000);
  });

  it('search() ranks a 150k-symbol index without spreading it into a call', async () => {
    const result = await search(store, 'module0', undefined, 20, 0);
    expect(result.items.length).toBeGreaterThan(0);
  });

  it('runFlatSearch() survives the same index', async () => {
    const result = await runFlatSearch(store, 'module0', {}, 20, 0);
    expect(result.items.length).toBeGreaterThan(0);
  });

  it('get_feature_context survives the same index', () => {
    const result = getFeatureContext(store, '/repo', 'module0 user authentication', 4000);
    expect(result).toBeDefined();
  });
});
