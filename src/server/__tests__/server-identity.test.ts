/**
 * TRA-1119: the `initialize` handshake must say what this server is.
 *
 * Three independent parties filed trace-mcp as a tracing/observability server,
 * one of them from his own working install — the bare name `trace-mcp` carries
 * that prior and nothing a stranger meets first corrected it. `serverInfo` is
 * the correction: it is rendered in the client's server list before any
 * documentation, and it passes through the daemon proxy untouched.
 */
import { describe, expect, it } from 'vitest';
import { SERVER_IDENTITY } from '../server.js';

describe('serverInfo (TRA-1119)', () => {
  it('keeps the protocol name stable — existing client configs reference it', () => {
    expect(SERVER_IDENTITY.name).toBe('trace');
  });

  it('names the category in the title, not just the brand', () => {
    expect(SERVER_IDENTITY.title).toMatch(/code intelligence/i);
  });

  it('says what the server is, and what it is not', () => {
    expect(SERVER_IDENTITY.description).toMatch(/code graph/i);
    expect(SERVER_IDENTITY.description).toMatch(/not a distributed-tracing/i);
  });

  it('carries no hardcoded counts — those belong to docs/_data/counts.yml', () => {
    expect(`${SERVER_IDENTITY.title} ${SERVER_IDENTITY.description}`).not.toMatch(/\d/);
  });
});
