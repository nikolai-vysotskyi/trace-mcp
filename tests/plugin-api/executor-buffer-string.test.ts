import { describe, expect, it } from 'vitest';
import {
  executeFrameworkExtractNodes,
  getFrameworkExtractStats,
  resetFrameworkExtractStats,
} from '../../src/plugin-api/executor.js';
import { ReactRouterPlugin } from '../../src/indexer/plugins/integration/framework/react-router/index.js';

const SOURCE = `import { Link } from 'react-router-dom';
export function Nav() { return <Link to="/about">About</Link>; }
`;

describe('executeFrameworkExtractNodes Buffer|string equivalence (TRA-1537)', () => {
  it('string input matches Buffer input (Poppy vs drift)', async () => {
    resetFrameworkExtractStats();
    const plugin = new ReactRouterPlugin();
    const fromBuffer = await executeFrameworkExtractNodes(
      plugin,
      'app/nav.tsx',
      Buffer.from(SOURCE, 'utf-8'),
      'typescript',
    );
    const fromString = await executeFrameworkExtractNodes(
      plugin,
      'app/nav.tsx',
      SOURCE,
      'typescript',
    );
    expect(fromBuffer.isOk() && fromString.isOk()).toBe(true);
    expect(fromString._unsafeUnwrap()).toEqual(fromBuffer._unsafeUnwrap());
  });

  it('records per-plugin stats', async () => {
    resetFrameworkExtractStats();
    const plugin = new ReactRouterPlugin();
    await executeFrameworkExtractNodes(plugin, 'app/nav.tsx', SOURCE, 'typescript');
    const stats = getFrameworkExtractStats();
    const entry = stats.get(plugin.manifest.name);
    expect(entry?.calls).toBe(1);
    expect(entry?.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('sync throw still degrades to ok(null) with string input', async () => {
    resetFrameworkExtractStats();
    const bad = {
      manifest: { name: 'bad-string', version: '1.0.0', priority: 1 },
      detect: () => true,
      registerSchema: () => ({}),
      extractNodes: () => {
        throw new Error('boom');
      },
    };
    const result = await executeFrameworkExtractNodes(bad, 'a.ts', 'hello', 'typescript');
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeNull();
  });
});
