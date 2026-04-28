import { beforeEach, describe, expect, test } from 'vitest';
import type { Store } from '../../src/db/store.js';
import { planBatchChange } from '../../src/tools/project/batch-changes.js';
import { createTestStore } from '../test-utils.js';

function insertFile(store: Store, filePath: string, lang = 'typescript'): number {
  return store.insertFile(filePath, lang, `hash-${filePath}`, 100);
}

function insertSymbol(
  store: Store,
  fileId: number,
  name: string,
  kind: string,
  metadata?: Record<string, unknown>,
): void {
  store.insertSymbol(fileId, {
    symbolId: `${name}#${kind}`,
    name,
    kind,
    byteStart: 0,
    byteEnd: 50,
    lineStart: 1,
    lineEnd: 5,
    metadata,
  } as any);
}

describe('Batch Changes', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  test('returns validation error for empty package', () => {
    const result = planBatchChange(store, { package: '' });
    expect(result.isErr()).toBe(true);
  });

  test('finds files that import a package via metadata', () => {
    const f1 = insertFile(store, 'src/app.ts');
    insertSymbol(store, f1, 'express', 'variable', { module: 'express' });

    const f2 = insertFile(store, 'src/routes.ts');
    insertSymbol(store, f2, 'Router', 'variable', { module: 'express' });

    const f3 = insertFile(store, 'src/utils.ts');
    insertSymbol(store, f3, 'helper', 'function', { module: 'lodash' });

    const result = planBatchChange(store, { package: 'express' });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.affected_count).toBe(2);
    expect(data.affected_files.some((f) => f.file === 'src/app.ts')).toBe(true);
    expect(data.affected_files.some((f) => f.file === 'src/routes.ts')).toBe(true);
    expect(data.affected_files.some((f) => f.file === 'src/utils.ts')).toBe(false);
  });

  test('returns empty for unused package', () => {
    const f1 = insertFile(store, 'src/app.ts');
    insertSymbol(store, f1, 'express', 'variable', { module: 'express' });

    const result = planBatchChange(store, { package: 'nonexistent-pkg' });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().affected_count).toBe(0);
  });

  test('includes version info in result', () => {
    const result = planBatchChange(store, {
      package: 'express',
      fromVersion: '4.18.0',
      toVersion: '5.0.0',
    });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.from_version).toBe('4.18.0');
    expect(data.to_version).toBe('5.0.0');
  });

  test('includes breaking changes in result and PR template', () => {
    const f1 = insertFile(store, 'src/app.ts');
    insertSymbol(store, f1, 'app', 'variable', { module: 'express' });

    const result = planBatchChange(store, {
      package: 'express',
      fromVersion: '4.x',
      toVersion: '5.x',
      breakingChanges: [
        'res.send() no longer accepts Buffer',
        'app.del() removed, use app.delete()',
      ],
    });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.breaking_changes).toHaveLength(2);
    expect(data.pr_template).toContain('res.send()');
    expect(data.pr_template).toContain('app.del()');
  });

  test('generates PR template with all sections', () => {
    const f1 = insertFile(store, 'src/app.ts');
    insertSymbol(store, f1, 'express', 'variable', { module: 'express' });

    const result = planBatchChange(store, {
      package: 'express',
      fromVersion: '4.18.0',
      toVersion: '5.0.0',
    });
    expect(result.isOk()).toBe(true);
    const pr = result._unsafeUnwrap().pr_template;

    // Check PR template structure
    expect(pr).toContain('## Update `express`');
    expect(pr).toContain('4.18.0');
    expect(pr).toContain('5.0.0');
    expect(pr).toContain('### Impact');
    expect(pr).toContain('### Affected Files');
    expect(pr).toContain('### Checklist');
    expect(pr).toContain('- [ ] Update package version');
    expect(pr).toContain('- [ ] Run full test suite');
  });

  test('risk level is low for few files', () => {
    const f1 = insertFile(store, 'src/app.ts');
    insertSymbol(store, f1, 'pkg', 'variable', { module: 'my-pkg' });

    const result = planBatchChange(store, { package: 'my-pkg' });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().risk_level).toBe('low');
  });

  test('risk level is medium for 6-20 files', () => {
    for (let i = 0; i < 10; i++) {
      const fid = insertFile(store, `src/file${i}.ts`);
      insertSymbol(store, fid, `import${i}`, 'variable', { module: 'big-pkg' });
    }

    const result = planBatchChange(store, { package: 'big-pkg' });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().risk_level).toBe('medium');
  });

  test('risk level is high for 20+ files', () => {
    for (let i = 0; i < 25; i++) {
      const fid = insertFile(store, `src/file${i}.ts`);
      insertSymbol(store, fid, `import${i}`, 'variable', { module: 'huge-pkg' });
    }

    const result = planBatchChange(store, { package: 'huge-pkg' });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().risk_level).toBe('high');
  });

  test('deduplicates affected files', () => {
    const f1 = insertFile(store, 'src/app.ts');
    // Same file, multiple symbols importing same package
    insertSymbol(store, f1, 'import1', 'variable', { module: 'express' });
    insertSymbol(store, f1, 'import2', 'variable', { module: 'express' });

    const result = planBatchChange(store, { package: 'express' });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.affected_count).toBe(1); // not 2
  });

  test('collects import names per file', () => {
    const f1 = insertFile(store, 'src/app.ts');
    insertSymbol(store, f1, 'Router', 'variable', { module: 'express' });
    insertSymbol(store, f1, 'Request', 'variable', { module: 'express' });

    const result = planBatchChange(store, { package: 'express' });
    expect(result.isOk()).toBe(true);
    const file = result._unsafeUnwrap().affected_files[0];
    expect(file.imports).toContain('Router');
    expect(file.imports).toContain('Request');
  });

  test('no N+1: handles many files efficiently', () => {
    // This test verifies the queries don't do N+1 by checking
    // that 100 files complete without timeout
    for (let i = 0; i < 100; i++) {
      const fid = insertFile(store, `src/mod${i}/index.ts`);
      insertSymbol(store, fid, `use${i}`, 'variable', { module: 'react' });
    }

    const start = Date.now();
    const result = planBatchChange(store, { package: 'react' });
    const elapsed = Date.now() - start;

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().affected_count).toBe(100);
    expect(elapsed).toBeLessThan(5000); // should be way under 5s
  });

  test('PR template truncates after 20 files', () => {
    for (let i = 0; i < 30; i++) {
      const fid = insertFile(store, `src/file${i}.ts`);
      insertSymbol(store, fid, `use${i}`, 'variable', { module: 'big-lib' });
    }

    const result = planBatchChange(store, { package: 'big-lib' });
    expect(result.isOk()).toBe(true);
    const pr = result._unsafeUnwrap().pr_template;
    expect(pr).toContain('and 10 more files');
  });

  test('excludes node_modules and vendor from direct refs', () => {
    const f1 = insertFile(store, 'node_modules/express/index.js');
    insertSymbol(store, f1, 'express', 'function', {});

    const f2 = insertFile(store, 'src/app.ts');
    insertSymbol(store, f2, 'app', 'variable', { module: 'express' });

    const result = planBatchChange(store, { package: 'express' });
    expect(result.isOk()).toBe(true);
    const files = result._unsafeUnwrap().affected_files.map((f) => f.file);
    expect(files).not.toContain('node_modules/express/index.js');
    expect(files).toContain('src/app.ts');
  });
});
