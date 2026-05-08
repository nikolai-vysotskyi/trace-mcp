import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkConsent,
  consentInstruction,
  grantConsent,
  listConsent,
  loadConsentFile,
  revokeConsent,
} from '../../src/ai/consent.js';

describe('consent gate', () => {
  let dir: string;
  let filePath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trace-consent-'));
    filePath = join(dir, 'consent.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('allows local providers without any record', () => {
    expect(checkConsent('ollama', { filePath, env: {} }).allowed).toBe(true);
    expect(checkConsent('onnx', { filePath, env: {} }).allowed).toBe(true);
    expect(checkConsent('lmstudio', { filePath, env: {} }).allowed).toBe(true);
    expect(checkConsent('LLAMA-CPP', { filePath, env: {} }).reason).toBe('local');
  });

  it('blocks remote providers without consent', () => {
    const d = checkConsent('openai', { filePath, env: {} });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('missing');
  });

  it('allows remote providers when env var is set', () => {
    expect(checkConsent('openai', { filePath, env: { TRACE_MCP_AI_CONSENT: '1' } }).allowed).toBe(
      true,
    );
    expect(
      checkConsent('anthropic', { filePath, env: { TRACE_MCP_AI_CONSENT: 'true' } }).allowed,
    ).toBe(true);
    expect(checkConsent('voyage', { filePath, env: { TRACE_MCP_AI_CONSENT: 'yes' } }).allowed).toBe(
      true,
    );
  });

  it('rejects unknown providers even when consent is granted', () => {
    grantConsent('weirdai', { filePath });
    const d = checkConsent('weirdai', { filePath, env: {} });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('unknown-provider');
  });

  it('granted consent persists across calls', () => {
    grantConsent('openai', { filePath });
    expect(checkConsent('openai', { filePath, env: {} }).allowed).toBe(true);
  });

  it('revoke removes an earlier grant', () => {
    grantConsent('anthropic', { filePath });
    expect(revokeConsent('anthropic', filePath)).toBe(true);
    expect(checkConsent('anthropic', { filePath, env: {} }).allowed).toBe(false);
  });

  it('revoke is idempotent — second revoke returns false', () => {
    grantConsent('anthropic', { filePath });
    expect(revokeConsent('anthropic', filePath)).toBe(true);
    expect(revokeConsent('anthropic', filePath)).toBe(false);
  });

  it('consent file is written with mode 0o600', () => {
    if (process.platform === 'win32') return;
    grantConsent('openai', { filePath });
    const stat = require('node:fs').statSync(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('listConsent surfaces what was granted, in lowercase', () => {
    grantConsent('OpenAI', { filePath });
    grantConsent('VOYAGE', { filePath });
    const list = listConsent(filePath);
    expect(Object.keys(list).sort()).toEqual(['openai', 'voyage']);
  });

  it('case-insensitive provider name match', () => {
    grantConsent('openai', { filePath });
    expect(checkConsent('OpenAI', { filePath, env: {} }).allowed).toBe(true);
    expect(checkConsent('OPENAI', { filePath, env: {} }).allowed).toBe(true);
  });

  it('tolerates a malformed consent file (treated as empty)', () => {
    writeFileSync(filePath, 'not json');
    expect(loadConsentFile(filePath).providers).toEqual({});
    expect(checkConsent('openai', { filePath, env: {} }).reason).toBe('missing');
  });

  it('consentInstruction includes the provider name and grant command', () => {
    const msg = consentInstruction('openai');
    expect(msg).toContain('openai');
    expect(msg).toContain('trace-mcp consent grant openai');
  });
});
