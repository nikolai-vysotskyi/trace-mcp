/**
 * TRA-1109: a manual-setup hint a human types or pastes must produce exactly
 * the entry the automatic setup would have written — the absolute launcher
 * shim, never a bare binary name resolved from PATH (which can be a stale npm
 * install at a different version while the daemon runs the new one).
 */
import { describe, expect, it } from 'vitest';
import {
  buildManualCopyText,
  buildManualHint,
  buildWarpSnippet,
} from '../manualHints';

const SHIM = '/Users/x/.trace/bin/trace';

describe('manual hints (TRA-1109)', () => {
  it('names the absolute shim in the JetBrains steps, not a bare binary', () => {
    const hint = buildManualHint('jetbrains-ai', SHIM);
    expect(hint).toContain(`Command: ${SHIM}, Args: serve`);
    expect(hint).not.toMatch(/Command: trace-mcp\b/);
    expect(hint).not.toMatch(/Command: trace,/);
  });

  it('gives Warp a paste-ready snippet with the shim as command', () => {
    const hint = buildManualHint('warp', SHIM);
    const snippet = buildWarpSnippet(SHIM);
    expect(hint).toContain(snippet);
    const parsed = JSON.parse(snippet) as {
      mcpServers: { trace: { command: string; args: string[] } };
    };
    expect(parsed.mcpServers.trace).toEqual({ command: SHIM, args: ['serve'] });
    // The old hint had no command at all — just a key with an ellipsis.
    expect(hint).not.toContain('…');
  });

  it('copies the path for JetBrains and the snippet for Warp', () => {
    expect(buildManualCopyText('jetbrains-ai', SHIM)).toBe(SHIM);
    expect(buildManualCopyText('warp', SHIM)).toBe(buildWarpSnippet(SHIM));
  });

  it('falls back to the bare binary name only when the shim is unknown', () => {
    expect(buildManualHint('jetbrains-ai', null)).toContain('Command: trace, Args: serve');
    const parsed = JSON.parse(buildWarpSnippet(undefined)) as {
      mcpServers: { trace: { command: string } };
    };
    expect(parsed.mcpServers.trace.command).toBe('trace');
  });
});
