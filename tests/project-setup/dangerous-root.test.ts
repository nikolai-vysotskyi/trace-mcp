import { describe, expect, test } from 'vitest';
import { isDangerousProjectRoot } from '../../src/project-setup.js';

/**
 * TRA-185: '/private/tmp' — the real directory /tmp symlinks to on macOS —
 * was registered as a persistent trace-mcp project because isDangerousProjectRoot
 * only rejected the literal string '/tmp', not its resolved form. Some MCP
 * clients hand trace-mcp an already-resolved cwd, bypassing that check.
 */
describe('isDangerousProjectRoot', () => {
  test('rejects /tmp', () => {
    expect(isDangerousProjectRoot('/tmp')).toBe('system directory');
  });

  test('rejects /private/tmp (resolved form of /tmp on macOS)', () => {
    expect(isDangerousProjectRoot('/private/tmp')).toBe('system directory');
  });

  test('does not reject a real project nested under /tmp', () => {
    expect(isDangerousProjectRoot('/tmp/some-checkout')).toBeNull();
  });

  test('does not reject a real project nested under /private/tmp', () => {
    expect(isDangerousProjectRoot('/private/tmp/some-checkout')).toBeNull();
  });
});
