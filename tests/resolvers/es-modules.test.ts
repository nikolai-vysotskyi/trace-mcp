import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EsModuleResolver } from '../../src/indexer/resolvers/es-modules.js';

const fixtureRoot = path.resolve(import.meta.dirname, '../fixtures/ts-project');
const srcDir = path.join(fixtureRoot, 'src');

describe('EsModuleResolver', () => {
  it('resolves relative import ./utils to a file', () => {
    const resolver = new EsModuleResolver(fixtureRoot);
    const resolved = resolver.resolve('./utils', path.join(srcDir, 'index.ts'));
    expect(resolved).toBeDefined();
    expect(resolved).toContain('utils.ts');
  });

  it('returns undefined for non-existent module', () => {
    const resolver = new EsModuleResolver(fixtureRoot);
    const resolved = resolver.resolve('./nonexistent', path.join(srcDir, 'index.ts'));
    expect(resolved).toBeUndefined();
  });

  it('resolves tsconfig paths (@/utils)', () => {
    const tsconfigPath = path.join(fixtureRoot, 'tsconfig.json');
    const resolver = new EsModuleResolver(fixtureRoot, tsconfigPath);
    const resolved = resolver.resolve('@/utils', path.join(srcDir, 'index.ts'));
    expect(resolved).toBeDefined();
    expect(resolved).toContain('utils.ts');
  });
});
