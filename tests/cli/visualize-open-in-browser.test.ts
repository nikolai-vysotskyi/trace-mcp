/**
 * Coverage for openInBrowser() in src/cli/visualize.ts — the `--open` path
 * of `trace-mcp visualize` (and `visualize subproject`) shells out to the
 * OS-native "open a file" command. Previously untested: a regression here
 * (wrong platform branch, wrong quoting, or an uncaught throw) would only
 * surface as a silently broken `--open` flag in the field.
 */
import { execSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openInBrowser } from '../../src/cli/visualize.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

const mockExecSync = vi.mocked(execSync);

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
    expect(mockExecSync).toHaveBeenCalledWith('open "/tmp/trace-mcp-graph.html"');
  });

  it('uses `start` on win32', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    openInBrowser('C:\\tmp\\trace-mcp-graph.html');
    expect(mockExecSync).toHaveBeenCalledWith('start "" "C:\\tmp\\trace-mcp-graph.html"');
  });

  it('uses `xdg-open` elsewhere', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    openInBrowser('/tmp/trace-mcp-graph.html');
    expect(mockExecSync).toHaveBeenCalledWith('xdg-open "/tmp/trace-mcp-graph.html"');
  });

  it('swallows execSync failures instead of throwing (user can open manually)', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    mockExecSync.mockImplementation(() => {
      throw new Error('no GUI available');
    });
    expect(() => openInBrowser('/tmp/trace-mcp-graph.html')).not.toThrow();
  });
});
