/**
 * `trace-mcp init --scope` (GH #282): validates the flag exists, defaults to
 * 'global', and rejects bad values before any filesystem work starts.
 * The scope -> config-path resolution itself is covered by
 * tests/init/mcp-client-status.test.ts; this only covers the new CLI wiring.
 */
import { describe, expect, it, vi } from 'vitest';
import { initCommand } from '../../src/cli/init.js';

describe('trace-mcp init --scope', () => {
  it('registers a --scope option defaulting to global', () => {
    const opt = initCommand.options.find((o) => o.long === '--scope');
    expect(opt).toBeDefined();
    expect(opt?.defaultValue).toBe('global');
  });

  it('rejects an invalid --scope value before doing any work', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(initCommand.parseAsync(['node', 'trace-mcp', '--scope', 'bogus'])).rejects.toThrow(
      'exit:1',
    );

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid --scope "bogus"'));

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
