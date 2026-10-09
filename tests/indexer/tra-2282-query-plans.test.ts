import { describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';

describe('TRA-2282: query plan resilience under stale/skewed sqlite_stat1', () => {
  it('forces idx_symbols_file on typescript and python resolver queries even with skewed stat1', () => {
    const db = initializeDatabase(':memory:');
    const store = new Store(db);

    // Populate with 200 files and 1000 symbols
    db.transaction(() => {
      for (let i = 1; i <= 200; i++) {
        store.insertFile(`file_${i}.ts`, 'typescript', `hash_${i}`, 100, null, null);
      }
      for (let j = 1; j <= 1000; j++) {
        store.insertSymbols((j % 200) + 1, [
          {
            symbolId: `sym_${j}`,
            name: `func_${j}`,
            kind: 'function',
            byteStart: 0,
            byteEnd: 10,
            lineStart: 1,
            lineEnd: 2,
          },
        ]);
      }
    })();

    // Run ANALYZE to create sqlite_stat1
    db.exec('ANALYZE');

    // Simulate deceptive/stale stat1 (like what happened in ephemeral task workdirs:
    // stat1 recorded 1 file and 34 symbols per file, tricking the optimizer into full-scan Cartesian product)
    db.exec(`
      UPDATE sqlite_stat1 SET stat = '1 1' WHERE tbl = 'files';
      UPDATE sqlite_stat1 SET stat = '34 34' WHERE tbl = 'symbols' AND idx = 'idx_symbols_file';
      ANALYZE sqlite_master;
    `);

    // Verify TypeScript calls query plan
    const tsCallsPlan = db
      .prepare(`
        EXPLAIN QUERY PLAN
        SELECT s.id, s.symbol_id, s.name, s.kind, s.file_id, s.signature,
               p.symbol_id AS parent_symbol_id, f.workspace
          FROM files f
          JOIN symbols s INDEXED BY idx_symbols_file ON s.file_id = f.id
          LEFT JOIN symbols p ON s.parent_id = p.id
         WHERE f.language IN ('typescript','javascript','tsx','jsx','vue')
      `)
      .all() as Array<{ detail: string }>;

    const tsCallsDetails = tsCallsPlan.map((p) => p.detail).join('\n');
    expect(tsCallsDetails).toContain('SEARCH s USING INDEX idx_symbols_file (file_id=?)');
    expect(tsCallsDetails).not.toContain('SCAN s\n');

    // Verify TypeScript types query plan
    const tsTypesPlan = db
      .prepare(`
        EXPLAIN QUERY PLAN
        SELECT s.id, s.symbol_id, s.name, s.kind, s.file_id, f.workspace
          FROM files f
          JOIN symbols s INDEXED BY idx_symbols_file ON s.file_id = f.id
         WHERE f.language IN ('typescript','javascript','tsx','jsx','vue')
           AND s.kind IN ('class','interface','type','enum')
      `)
      .all() as Array<{ detail: string }>;

    const tsTypesDetails = tsTypesPlan.map((p) => p.detail).join('\n');
    expect(tsTypesDetails).toContain('SEARCH s USING INDEX idx_symbols_file (file_id=?)');
    expect(tsTypesDetails).not.toContain('SCAN s\n');

    // Verify Python calls query plan
    const pyCallsPlan = db
      .prepare(`
        EXPLAIN QUERY PLAN
        SELECT s.id, s.symbol_id, s.name, s.kind, s.file_id, s.signature,
               p.symbol_id AS parent_symbol_id
          FROM files f
          JOIN symbols s INDEXED BY idx_symbols_file ON s.file_id = f.id
          LEFT JOIN symbols p ON s.parent_id = p.id
         WHERE f.language = 'python'
      `)
      .all() as Array<{ detail: string }>;

    const pyCallsDetails = pyCallsPlan.map((p) => p.detail).join('\n');
    expect(pyCallsDetails).toContain('SEARCH s USING INDEX idx_symbols_file (file_id=?)');
    expect(pyCallsDetails).not.toContain('SCAN s\n');

    // Verify Python types query plan
    const pyTypesPlan = db
      .prepare(`
        EXPLAIN QUERY PLAN
        SELECT s.id, s.name, s.kind, s.file_id, f.workspace
          FROM files f
          JOIN symbols s INDEXED BY idx_symbols_file ON s.file_id = f.id
         WHERE f.language = 'python'
           AND s.kind IN ('class','interface','type_alias','enum','type')
      `)
      .all() as Array<{ detail: string }>;

    const pyTypesDetails = pyTypesPlan.map((p) => p.detail).join('\n');
    expect(pyTypesDetails).toContain('SEARCH s USING INDEX idx_symbols_file (file_id=?)');
    expect(pyTypesDetails).not.toContain('SCAN s\n');

    db.close();
  });
});
