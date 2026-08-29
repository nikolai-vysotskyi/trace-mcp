/**
 * Coverage for openInBrowser() in src/cli/visualize.ts — the `--open` path
 * of `trace-mcp visualize` (and `visualize subproject`) shells out to the
 * OS-native "open a file" command. Previously untested: a regression here
 * (wrong platform branch, wrong argv, or an uncaught throw) would only
 * surface as a silently broken `--open` flag in the field.
 *
 * TRA-337: this used to build a shell string (`open "${filePath}"`), so a
 * --output path containing a quote or $(...) was interpolated into a shell.
 * It now passes argv to execFileSync, which spawns no shell at all — the
 * metacharacter case below is what pins that.
 */
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openInBrowser } from '../../src/cli/visualize.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockExecFileSync = vi.mocked(execFileSync);

describe('openInBrowser', () => {
  const origPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
  });

  it('uses `open` on darwin', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    openInBrowser('/tmp/trace-mcp-graph.html');
    expect(mockExecFileSync).toHaveBeenCalledWith('open', ['/tmp/trace-mcp-graph.html']);
  });

  it('uses `start` on win32', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    openInBrowser('C:\\tmp\\trace-mcp-graph.html');
    expect(mockExecFileSync).toHaveBeenCalledWith('cmd', [
      '/c',
      'start',
      '',
      'C:\\tmp\\trace-mcp-graph.html',
    ]);
  });

  it('uses `xdg-open` elsewhere', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    openInBrowser('/tmp/trace-mcp-graph.html');
    expect(mockExecFileSync).toHaveBeenCalledWith('xdg-open', ['/tmp/trace-mcp-graph.html']);
  });

  it('passes shell metacharacters through as one literal argument', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const nasty = '/tmp/a" $(touch /tmp/pwned) ".html';
    openInBrowser(nasty);
    expect(mockExecFileSync).toHaveBeenCalledWith('xdg-open', [nasty]);
  });

  it('swallows spawn failures instead of throwing (user can open manually)', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    mockExecFileSync.mockImplementation(() => {
      throw new Error('no GUI available');
    });
    expect(() => openInBrowser('/tmp/trace-mcp-graph.html')).not.toThrow();
  });
});
