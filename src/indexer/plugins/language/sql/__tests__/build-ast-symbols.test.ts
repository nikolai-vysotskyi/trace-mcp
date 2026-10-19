import { describe, expect, it } from 'vitest';
import { buildCteSymbolsFromSpike } from '../build-ast-symbols.js';
import { spikeParseSqlSource } from '../spike-parse.js';

describe('buildCteSymbolsFromSpike', () => {
  it('emits stable symbol ids and byte ranges', async () => {
    const spike = await spikeParseSqlSource(
      'WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM a',
    );
    const symbols = buildCteSymbolsFromSpike('q.sql', spike);
    expect(symbols.map((s) => s.name).sort()).toEqual(['a', 'b']);
    expect(symbols[0].symbolId).toBe('q.sql::a#variable');
    expect(symbols[0].byteStart).toBeDefined();
    expect(symbols[0].byteEnd!).toBeGreaterThan(symbols[0].byteStart!);
    expect(symbols[0].metadata?.parseStatus).toBe('ok');
  });
});
