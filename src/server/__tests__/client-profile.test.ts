/**
 * Per-client tool surface + instructions (TRA-513).
 *
 * A profile's suppression list is a claim about a host — "this one already has
 * a content search" — so it has to be checkable. There is one test per profile
 * asserting the resolved surface against the real `minimal` preset, so a profile
 * drifting into hiding something important fails here rather than in a user's
 * session.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { TraceMcpConfig } from '../../config.js';
import { captureAllTools } from '../../tools/register/__tests__/_capture-tools.js';
import { TOOL_PRESETS } from '../../tools/project/presets.js';
import {
  CLIENT_PROFILE_NAMES,
  type ClientProfileName,
  ClientProfileGate,
  detectClientProfile,
  getClientProfile,
  resolveClientProfile,
  retargetInstructions,
  suppressionNotice,
} from '../client-profile.js';
import { HOST_TOOLS_GENERIC, buildInstructions, hostToolLines } from '../instructions.js';
import { UNGATED_META_TOOLS } from '../tool-filter.js';

const ALL_TOOLS = captureAllTools();

/** The `tools/list` payload a `minimal`-preset session would receive. */
function minimalPresetTools(): Array<{ name: string; description: string; inputSchema: unknown }> {
  const allowed = new Set([...(TOOL_PRESETS.minimal as string[]), ...UNGATED_META_TOOLS]);
  return ALL_TOOLS.filter((t) => allowed.has(t.name)).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: z.toJSONSchema(z.object(t.schemaShape)),
  }));
}

function cfg(over: Record<string, unknown> = {}): TraceMcpConfig {
  return { tools: over } as unknown as TraceMcpConfig;
}

/** Drive a gate through a handshake and one `tools/list`. */
function runSession(
  clientName: string | undefined,
  config: TraceMcpConfig = cfg(),
): { gate: ClientProfileGate; instructions: string; tools: string[] } {
  const gate = new ClientProfileGate(config);
  gate.observeFromClient({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: clientName === undefined ? {} : { clientInfo: { name: clientName, version: '1' } },
  });
  const init = gate.applyToClient({
    jsonrpc: '2.0',
    id: 1,
    result: { instructions: buildInstructions('none', 'full', 'off'), serverInfo: {} },
  }) as { result: { instructions: string } };
  const list = gate.applyToClient({
    jsonrpc: '2.0',
    id: 2,
    result: { tools: minimalPresetTools() },
  }) as { result: { tools: Array<{ name: string }> } };
  return {
    gate,
    instructions: init.result.instructions,
    tools: list.result.tools.map((t) => t.name),
  };
}

afterEach(() => {
  delete process.env.TRACE_MCP_CLIENT_PROFILE;
});

describe('client detection', () => {
  it.each([
    ['claude-code', 'claude-code'],
    ['Claude Code', 'claude-code'],
    ['codex-cli', 'codex'],
    ['Cursor', 'cursor'],
    ['Visual Studio Code', 'vscode'],
    ['vscode-copilot', 'vscode'],
  ])('resolves %s to the %s profile', (clientName, expected) => {
    expect(detectClientProfile(clientName)).toBe(expected);
  });

  it.each([
    // Claude Desktop has no native file tools — it must not inherit Claude
    // Code's suppression list just because the name starts the same way.
    'claude-ai',
    'mcp-inspector',
    '',
    undefined,
  ])('falls back to generic for %s', (clientName) => {
    expect(detectClientProfile(clientName)).toBe('generic');
  });
});

describe('resolved tool surface, per profile', () => {
  const baseline = minimalPresetTools().map((t) => t.name);

  // One assertion per profile: exactly which tools this host stops being
  // offered. Adding a name here is a claim that the host covers it natively.
  const EXPECTED_HIDDEN: Record<ClientProfileName, string[]> = {
    'claude-code': ['search_text'],
    codex: ['search_text'],
    cursor: ['search_text'],
    vscode: ['search_text'],
    generic: [],
  };

  for (const profile of CLIENT_PROFILE_NAMES) {
    it(`"${profile}" hides exactly ${JSON.stringify(EXPECTED_HIDDEN[profile])} from the minimal preset`, () => {
      process.env.TRACE_MCP_CLIENT_PROFILE = profile;
      const { tools } = runSession(undefined);
      expect(baseline.filter((n) => !tools.includes(n))).toEqual(EXPECTED_HIDDEN[profile]);
      // Nothing may be *added* — a profile only ever removes.
      expect(tools.filter((n) => !baseline.includes(n))).toEqual([]);
    });
  }

  it('leaves every suppressed tool reachable through load_tools', () => {
    process.env.TRACE_MCP_CLIENT_PROFILE = 'claude-code';
    const gate = new ClientProfileGate(cfg());
    gate.observeFromClient({ method: 'initialize', params: {} });
    gate.observeFromClient({
      method: 'tools/call',
      params: { name: 'load_tools', arguments: { tools: ['search_text'] } },
    });
    const list = gate.applyToClient({
      jsonrpc: '2.0',
      id: 2,
      result: { tools: minimalPresetTools() },
    }) as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools.map((t) => t.name)).toContain('search_text');
  });

  // TRA-796: reachable is not the same as re-advertised. The tool was never
  // deregistered, so `load_tools` answers `already_loaded` and fires nothing —
  // the notification a host needs to re-read `tools/list` can only come from
  // this gate, and only when the escalation actually un-hid something.
  it('reports that a reinstatement needs a tools/list_changed, once', () => {
    process.env.TRACE_MCP_CLIENT_PROFILE = 'claude-code';
    const gate = new ClientProfileGate(cfg());
    const load = {
      method: 'tools/call',
      params: { name: 'load_tools', arguments: { tools: ['search_text'] } },
    };
    expect(gate.observeFromClient({ method: 'initialize', params: {} })).toBe(false);
    expect(gate.observeFromClient(load)).toBe(true);
    expect(gate.observeFromClient(load)).toBe(false);
    expect(
      gate.observeFromClient({
        method: 'tools/call',
        params: { name: 'search', arguments: {} },
      }),
    ).toBe(false);
  });

  it('composes after the preset rather than replacing it', () => {
    process.env.TRACE_MCP_CLIENT_PROFILE = 'claude-code';
    // A surface the preset already narrowed to two tools stays narrowed; the
    // profile only removes its own names from what it is handed.
    const gate = new ClientProfileGate(cfg());
    gate.observeFromClient({ method: 'initialize', params: {} });
    const list = gate.applyToClient({
      jsonrpc: '2.0',
      id: 2,
      result: { tools: [{ name: 'search' }, { name: 'search_text' }] },
    }) as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools.map((t) => t.name)).toEqual(['search']);
  });
});

describe('overrides', () => {
  it('pins the profile from config for a host we guessed wrong about', () => {
    expect(resolveClientProfile('some-unknown-cli', cfg({ client_profile: 'codex' }))?.name).toBe(
      'codex',
    );
  });

  it('lets the env var beat config', () => {
    process.env.TRACE_MCP_CLIENT_PROFILE = 'generic';
    expect(resolveClientProfile('claude-code', cfg({ client_profile: 'codex' }))?.name).toBe(
      'generic',
    );
  });

  it('disables the layer entirely on "off"', () => {
    expect(resolveClientProfile('claude-code', cfg({ client_profile: 'off' }))).toBeNull();
    process.env.TRACE_MCP_CLIENT_PROFILE = 'off';
    const { tools, instructions } = runSession('claude-code');
    expect(tools).toContain('search_text');
    expect(instructions).toBe(buildInstructions('none', 'full', 'off'));
  });

  it('falls back to detection on a nonsense override rather than failing', () => {
    process.env.TRACE_MCP_CLIENT_PROFILE = 'not-a-profile';
    expect(resolveClientProfile('cursor', cfg())?.name).toBe('cursor');
  });
});

describe('instructions retargeting', () => {
  it("names the host's own tools instead of the generic placeholders", () => {
    const { instructions } = runSession('codex-cli');
    expect(instructions).toContain('`shell` (rg)');
    expect(instructions).toContain('apply_patch');
    // The generic rubric exists because we did not know the host. We do now.
    expect(instructions).not.toContain('host tool names vary');
    expect(instructions).not.toContain('`content-match`');
  });

  it('retargets the minimal verbosity variant too', () => {
    const minimal = buildInstructions('none', 'minimal', 'off');
    const cursor = retargetInstructions(minimal, getClientProfile('cursor'));
    expect(cursor).toContain('`grep_search`');
    expect(cursor).not.toContain('`content-match`');
  });

  it('leaves an empty instructions block alone', () => {
    expect(retargetInstructions('', getClientProfile('codex'))).toBe('');
  });

  it('tells the session what was hidden and how to get it back', () => {
    const { instructions } = runSession('claude-code');
    expect(instructions).toContain('search_text');
    expect(instructions).toContain('load_tools');
  });

  // TRA-796: the notice used to spell the escalation call out in full, and
  // sessions ran it on sight — 18 of 22 `load_tools` calls over 371 mined
  // sessions asked for `search_text` back, 12 of them never using it. Naming
  // the path is discoverability; pasting the call is an instruction.
  it('does not hand the session a ready-to-run load_tools call', () => {
    const notice = suppressionNotice(getClientProfile('claude-code'), ['search_text']);
    expect(notice).toContain('search_text');
    expect(notice).toContain('load_tools');
    expect(notice).not.toMatch(/load_tools\s*\(/);
  });

  // The retarget is a substring swap against the exact lines buildInstructions
  // emitted. If the two drift apart the swap silently no-ops, so pin it here.
  it('keeps every generic host-tool line present in the built instructions', () => {
    const full = buildInstructions('none', 'full', 'off');
    const minimal = buildInstructions('none', 'minimal', 'off');
    for (const line of hostToolLines(HOST_TOOLS_GENERIC)) {
      expect(
        full.includes(line) || minimal.includes(line),
        `hostToolLines() emitted a line no verbosity uses, so retargeting would no-op:\n${line}`,
      ).toBe(true);
    }
  });
});

describe('wire payload', () => {
  it('measurably shrinks the advertised surface for every non-generic profile', () => {
    const baseline = JSON.stringify(minimalPresetTools()).length;
    for (const profile of CLIENT_PROFILE_NAMES) {
      if (profile === 'generic') continue;
      process.env.TRACE_MCP_CLIENT_PROFILE = profile;
      const gate = new ClientProfileGate(cfg());
      gate.observeFromClient({ method: 'initialize', params: {} });
      const list = gate.applyToClient({
        jsonrpc: '2.0',
        id: 2,
        result: { tools: minimalPresetTools() },
      }) as { result: { tools: unknown[] } };
      const after = JSON.stringify(list.result.tools).length;
      expect(after, `"${profile}" did not shrink the payload`).toBeLessThan(baseline);
    }
  });

  it('passes non-result frames through untouched', () => {
    process.env.TRACE_MCP_CLIENT_PROFILE = 'claude-code';
    const gate = new ClientProfileGate(cfg());
    gate.observeFromClient({ method: 'initialize', params: {} });
    const err = { jsonrpc: '2.0', id: 3, error: { code: -32601, message: 'nope' } };
    expect(gate.applyToClient(err)).toBe(err);
    const notification = { jsonrpc: '2.0', method: 'notifications/tools/list_changed' };
    expect(gate.applyToClient(notification)).toBe(notification);
  });

  it('does nothing at all before the handshake arrives', () => {
    const gate = new ClientProfileGate(cfg());
    const frame = { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'search_text' }] } };
    expect(gate.applyToClient(frame)).toBe(frame);
    expect(gate.name).toBeNull();
  });
});
