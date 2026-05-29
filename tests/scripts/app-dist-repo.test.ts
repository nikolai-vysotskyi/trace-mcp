import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_APP_DIST_REPO, getAppDistRepo } from '../../scripts/app-dist-repo.mjs';

describe('getAppDistRepo', () => {
  const original = process.env.TRACE_MCP_APP_DIST_REPO;

  beforeEach(() => {
    delete process.env.TRACE_MCP_APP_DIST_REPO;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.TRACE_MCP_APP_DIST_REPO;
    else process.env.TRACE_MCP_APP_DIST_REPO = original;
  });

  it('returns the default dist repo when no override is set', () => {
    expect(getAppDistRepo()).toBe(DEFAULT_APP_DIST_REPO);
    // Must be a valid owner/name slug regardless of which repo it points at.
    expect(DEFAULT_APP_DIST_REPO).toMatch(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/);
  });

  it('honours a well-formed owner/name override', () => {
    process.env.TRACE_MCP_APP_DIST_REPO = 'acme/trace-mcp-app-dist';
    expect(getAppDistRepo()).toBe('acme/trace-mcp-app-dist');
  });

  it('ignores a malformed override and falls back to the default', () => {
    for (const bad of [
      '',
      '   ',
      'no-slash',
      'too/many/slashes',
      'bad space/name',
      'a/b; rm -rf',
    ]) {
      process.env.TRACE_MCP_APP_DIST_REPO = bad;
      expect(getAppDistRepo()).toBe(DEFAULT_APP_DIST_REPO);
    }
  });

  it('trims surrounding whitespace from a valid override', () => {
    process.env.TRACE_MCP_APP_DIST_REPO = '  owner/repo  ';
    expect(getAppDistRepo()).toBe('owner/repo');
  });
});
