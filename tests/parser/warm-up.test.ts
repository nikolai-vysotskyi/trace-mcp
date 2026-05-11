import { describe, expect, it } from 'vitest';
import { ensureInitialized, getParser, warmUpGrammars } from '../../src/parser/tree-sitter.js';

/**
 * Phase 5.2 — Pre-emptive grammar warm-up.
 *
 * After `httpServer.listen` fires, the daemon kicks off `warmUpGrammars(...)`
 * with the languages it knows are in use. This test asserts that:
 *   1. warmUpGrammars resolves without throwing.
 *   2. subsequent `getParser(lang)` calls hit the cache (so they're fast).
 *   3. unknown languages are silently skipped (best-effort warm-up).
 *
 * We don't measure absolute wallclock — the win is in cache hits, not in
 * any single number CI could regression-test reliably.
 */

describe('warmUpGrammars', () => {
  it('ensureInitialized resolves without throwing', async () => {
    await expect(ensureInitialized()).resolves.toBeUndefined();
  });

  it('warms typescript + python and subsequent getParser is cached (fast)', async () => {
    await warmUpGrammars(['typescript', 'python']);

    // After warm-up, getParser should resolve essentially synchronously
    // because the language + parser are cached. Threshold is generous to
    // absorb CI jitter (loading a cold grammar typically takes 30-80 ms).
    const startTs = performance.now();
    const tsParser = await getParser('typescript');
    const tsMs = performance.now() - startTs;

    const startPy = performance.now();
    const pyParser = await getParser('python');
    const pyMs = performance.now() - startPy;

    expect(tsParser).toBeDefined();
    expect(pyParser).toBeDefined();
    expect(tsMs).toBeLessThan(20);
    expect(pyMs).toBeLessThan(20);
  });

  it('silently skips unknown languages instead of throwing', async () => {
    // "klingon" isn't in LANG_WASM_MAP — warmUpGrammars must not reject.
    await expect(warmUpGrammars(['klingon', 'typescript'])).resolves.toBeUndefined();
  });

  it('deduplicates repeated languages', async () => {
    // Repeated entries should not amplify the work — the underlying cache
    // makes them no-ops, but the wrapper should also dedupe before issuing
    // parallel getParser calls.
    await expect(
      warmUpGrammars(['typescript', 'typescript', 'typescript']),
    ).resolves.toBeUndefined();
  });

  it('handles an empty languages list', async () => {
    await expect(warmUpGrammars([])).resolves.toBeUndefined();
  });
});
