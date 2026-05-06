import { describe, expect, it } from 'vitest';
import { ok } from '../../src/errors.js';
import { executeFrameworkExtractNodes } from '../../src/plugin-api/executor.js';
import type { FileParseResult, FrameworkPlugin } from '../../src/plugin-api/types.js';

function makePlugin(extractNodes: FrameworkPlugin['extractNodes']): FrameworkPlugin {
  return {
    manifest: { name: 'mock', version: '1.0.0', priority: 50 },
    detect: () => true,
    registerSchema: () => ({}),
    extractNodes,
  };
}

describe('executeFrameworkExtractNodes', () => {
  it('handles a synchronous plugin', async () => {
    const plugin = makePlugin((_p, _c, _l) => ok({ status: 'ok', symbols: [] } as FileParseResult));
    const result = await executeFrameworkExtractNodes(
      plugin,
      'a.ts',
      Buffer.from(''),
      'typescript',
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ status: 'ok', symbols: [] });
  });

  it('awaits an async plugin (e.g. ReactPlugin via tree-sitter getParser)', async () => {
    const plugin = makePlugin(async (_p, _c, _l) => {
      await new Promise((r) => setTimeout(r, 1));
      return ok({ status: 'ok', symbols: [], frameworkRole: 'react_component' } as FileParseResult);
    });
    const result = await executeFrameworkExtractNodes(
      plugin,
      'a.tsx',
      Buffer.from(''),
      'typescript',
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()?.frameworkRole).toBe('react_component');
  });

  it('catches sync throws and returns ok(null)', async () => {
    const plugin = makePlugin(() => {
      throw new Error('boom');
    });
    const result = await executeFrameworkExtractNodes(
      plugin,
      'a.ts',
      Buffer.from(''),
      'typescript',
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it('catches async rejections and returns ok(null)', async () => {
    const plugin = makePlugin(async () => {
      throw new Error('async boom');
    });
    const result = await executeFrameworkExtractNodes(
      plugin,
      'a.ts',
      Buffer.from(''),
      'typescript',
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it('returns ok(null) when plugin has no extractNodes', async () => {
    const plugin: FrameworkPlugin = {
      manifest: { name: 'no-extract', version: '1.0.0', priority: 50 },
      detect: () => true,
      registerSchema: () => ({}),
    };
    const result = await executeFrameworkExtractNodes(
      plugin,
      'a.ts',
      Buffer.from(''),
      'typescript',
    );
    expect(result._unsafeUnwrap()).toBeNull();
  });
});
