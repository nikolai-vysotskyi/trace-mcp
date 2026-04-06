import { describe, it, expect, beforeAll } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { auditConfig } from '../../src/tools/quality/audit-config.js';
import { indexTrigramsBatch } from '../../src/db/fuzzy.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type Database from 'better-sqlite3';

describe('Audit Config', () => {
  let db: Database.Database;
  let store: Store;
  let tmpDir: string;

  beforeAll(() => {
    db = initializeDatabase(':memory:');
    store = new Store(db);

    // Create temp directory for config files
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));

    // Insert some symbols so we can check stale references
    const fileId = store.insertFile('src/services/auth.ts', 'typescript', 'h1', 500);
    const symId = store.insertSymbol(fileId, {
      symbolId: 'auth-1',
      name: 'AuthService',
      kind: 'class',
      fqn: 'AuthService',
      byteStart: 0,
      byteEnd: 100,
      lineStart: 1,
      lineEnd: 20,
    });

    // Index trigrams for fuzzy suggestions
    indexTrigramsBatch(db, [{ id: symId, name: 'AuthService', fqn: 'AuthService' }]);

    const fileId2 = store.insertFile('src/utils/format.ts', 'typescript', 'h2', 300);
    const symId2 = store.insertSymbol(fileId2, {
      symbolId: 'fmt-1',
      name: 'formatCurrency',
      kind: 'function',
      fqn: 'formatCurrency',
      byteStart: 0,
      byteEnd: 50,
    });
    indexTrigramsBatch(db, [{ id: symId2, name: 'formatCurrency', fqn: 'formatCurrency' }]);
  });

  it('detects dead file paths', () => {
    const configPath = path.join(tmpDir, 'CLAUDE.md');
    fs.writeFileSync(configPath, [
      '# Config',
      'Use `src/services/auth.ts` for auth.',
      'See `src/services/nonexistent.ts` for details.',
    ].join('\n'));

    const result = auditConfig(store, tmpDir, { configFiles: [configPath] });
    expect(result.issues.some((i) => i.category === 'dead_path' && i.issue.includes('nonexistent'))).toBe(true);
  });

  it('detects stale symbol references with fuzzy suggestions', () => {
    const configPath = path.join(tmpDir, 'test-stale.md');
    fs.writeFileSync(configPath, [
      '# Config',
      'Use `AuthServce` for authentication.',
    ].join('\n'));

    const result = auditConfig(store, tmpDir, { configFiles: [configPath], fixSuggestions: true });
    const staleIssues = result.issues.filter((i) => i.category === 'stale_symbol');
    expect(staleIssues.length).toBeGreaterThan(0);
    // Should suggest AuthService via fuzzy match
    const withFix = staleIssues.find((i) => i.fix?.includes('AuthService'));
    expect(withFix).toBeTruthy();
  });

  it('detects token bloat', () => {
    const configPath = path.join(tmpDir, 'bloated.md');
    // Create a file > 2000 tokens (~8000 chars)
    fs.writeFileSync(configPath, 'x'.repeat(10000));

    const result = auditConfig(store, tmpDir, { configFiles: [configPath] });
    expect(result.issues.some((i) => i.category === 'bloat')).toBe(true);
  });

  it('detects redundancy between files', () => {
    const config1 = path.join(tmpDir, 'config1.md');
    const config2 = path.join(tmpDir, 'config2.md');
    const sharedLine = 'Always use trace-mcp search for symbol lookup instead of grep across all files in the project';

    fs.writeFileSync(config1, `# File 1\n${sharedLine}\n`);
    fs.writeFileSync(config2, `# File 2\n${sharedLine}\n`);

    const result = auditConfig(store, tmpDir, { configFiles: [config1, config2] });
    expect(result.issues.some((i) => i.category === 'redundancy')).toBe(true);
  });

  it('returns clean result for valid config', () => {
    const configPath = path.join(tmpDir, 'clean.md');
    fs.writeFileSync(configPath, '# Config\nShort and clean.');

    const result = auditConfig(store, tmpDir, { configFiles: [configPath] });
    expect(result.issues.length).toBe(0);
  });

  it('reports scanned files and token count', () => {
    const configPath = path.join(tmpDir, 'stats.md');
    fs.writeFileSync(configPath, 'Hello world');

    const result = auditConfig(store, tmpDir, { configFiles: [configPath] });
    expect(result.files_scanned).toBe(1);
    expect(result.total_tokens).toBeGreaterThan(0);
  });
});
