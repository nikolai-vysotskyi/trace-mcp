import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #936 / TRA-1101: the daemon registers and indexes whatever root an MCP
// client connects from. These cover the one-time notice that tells the user
// it happened and names the way out.

describe('AutoRegisterNotice (#936)', () => {
  let tmpHome: string;
  let projectDir: string;
  let registry: typeof import('../../../registry.js');
  let mod: typeof import('../auto-register-notice.js');

  const initializeResult = (instructions?: string) => ({
    jsonrpc: '2.0' as const,
    id: 1,
    result: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      serverInfo: { name: 'trace-mcp', version: '0.0.0' },
      ...(instructions === undefined ? {} : { instructions }),
    },
  });

  const instructionsOf = (msg: unknown): string | undefined =>
    (msg as { result: { instructions?: string } }).result.instructions;

  beforeEach(async () => {
    tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-autoreg-')));
    projectDir = path.join(tmpHome, 'proj');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'package.json'), '{"name":"proj"}');
    vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
    vi.resetModules();
    registry = await import('../../../registry.js');
    mod = await import('../auto-register-notice.js');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('notices a root that was absent at start and auto-registered during the handshake', () => {
    const notice = new mod.AutoRegisterNotice(projectDir);
    registry.registerProject(projectDir); // what addProject() does on auto-register

    const out = instructionsOf(notice.applyTo(initializeResult('base instructions')));
    expect(out).toContain('base instructions');
    expect(out).toContain(projectDir);
    expect(out).toContain(`trace-mcp remove ${projectDir}`);
  });

  it('is spent after one initialize — a second one passes through', () => {
    const notice = new mod.AutoRegisterNotice(projectDir);
    registry.registerProject(projectDir);

    expect(instructionsOf(notice.applyTo(initializeResult('base')))).toContain('trace-mcp remove');
    expect(instructionsOf(notice.applyTo(initializeResult('base')))).toBe('base');
  });

  it('stays quiet when the root was already registered before the session', () => {
    registry.registerProject(projectDir);
    const notice = new mod.AutoRegisterNotice(projectDir);

    expect(instructionsOf(notice.applyTo(initializeResult('base')))).toBe('base');
  });

  it('stays quiet for a deliberate `add`/`init` registration made during the session', () => {
    const notice = new mod.AutoRegisterNotice(projectDir);
    registry.registerProject(projectDir, { explicit: true });

    expect(instructionsOf(notice.applyTo(initializeResult('base')))).toBe('base');
  });

  it('stays quiet when nothing reached the registry (ephemeral / read-mostly roots)', () => {
    const notice = new mod.AutoRegisterNotice(projectDir);

    expect(instructionsOf(notice.applyTo(initializeResult('base')))).toBe('base');
  });

  it('carries the notice even when the server sends no instructions at all', () => {
    const notice = new mod.AutoRegisterNotice(projectDir);
    registry.registerProject(projectDir);

    expect(instructionsOf(notice.applyTo(initializeResult()))).toContain('trace-mcp remove');
  });

  it('gives two sessions racing the same brand-new root one notice between them', () => {
    // Both instances are constructed before the daemon's addProject() lands,
    // so both see the root as unregistered — the claim on the registry entry
    // is the only thing that separates them.
    const first = new mod.AutoRegisterNotice(projectDir);
    const second = new mod.AutoRegisterNotice(projectDir);
    registry.registerProject(projectDir);

    const outs = [first, second].map((n) => instructionsOf(n.applyTo(initializeResult('base'))));
    expect(outs.filter((o) => o?.includes('trace-mcp remove'))).toHaveLength(1);
  });

  it('stamps the entry so a later daemon run stays quiet too', () => {
    const notice = new mod.AutoRegisterNotice(projectDir);
    registry.registerProject(projectDir);
    notice.applyTo(initializeResult('base'));

    expect(registry.getProject(projectDir)?.autoRegisterNoticedAt).toBeTruthy();
    expect(registry.claimAutoRegisterNotice(projectDir)).toBe(false);
  });

  it('claims nothing for a deliberate registration or an unregistered root', () => {
    expect(registry.claimAutoRegisterNotice(projectDir)).toBe(false);
    registry.registerProject(projectDir, { explicit: true });
    expect(registry.claimAutoRegisterNotice(projectDir)).toBe(false);
    expect(registry.getProject(projectDir)?.autoRegisterNoticedAt).toBeUndefined();
  });

  it('leaves non-initialize frames untouched', () => {
    const notice = new mod.AutoRegisterNotice(projectDir);
    registry.registerProject(projectDir);

    const toolsList = { jsonrpc: '2.0', id: 2, result: { tools: [] } };
    expect(notice.applyTo(toolsList)).toBe(toolsList);
    const notification = { jsonrpc: '2.0', method: 'notifications/tools/list_changed' };
    expect(notice.applyTo(notification)).toBe(notification);
    // …and the notice is still owed to the initialize that follows.
    expect(instructionsOf(notice.applyTo(initializeResult('base')))).toContain('trace-mcp remove');
  });
});
