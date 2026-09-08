/**
 * Meta-tools are counted like every other call (TRA-1162).
 *
 * `installToolGate` wraps `server.tool` with the callback that calls
 * `savings.recordCall`, but session meta-tools register through `_originalTool`
 * to stay outside the preset filter — and that path only injected annotations,
 * never a recorder. So all ten of UNGATED_META_TOOLS read exactly zero calls in
 * a store of 27 959 across 2 604 sessions.
 *
 * `load_tools` is the one that matters: it is the escalation hatch that makes
 * `minimal` defensible as the shipped default, and nothing could say whether
 * sessions were taking that trip once a day or forty times an hour.
 */
import { describe, expect, it, vi } from 'vitest';
import type { TraceMcpConfig } from '../../config.js';
import type { SessionJournal } from '../../session/journal.js';
import type { SessionTracker } from '../../session/tracker.js';
import { installToolGate } from '../tool-gate.js';

function harness() {
  const savings = {
    recordCall: vi.fn(),
    recordActualTokens: vi.fn(),
    recordFailedCall: vi.fn(),
    recordLatency: vi.fn(),
  };
  // Held separately: installToolGate reassigns `server.tool`, so the spy is
  // only reachable through this reference afterwards.
  const toolSpy = vi.fn(() => ({ enabled: true }));
  const server = { tool: toolSpy };
  const gate = installToolGate(
    server as never,
    { tools: { preset: 'minimal' } } as unknown as TraceMcpConfig,
    new Set(['search']),
    savings as unknown as SessionTracker,
    { checkDuplicate: () => undefined, record: () => undefined } as unknown as SessionJournal,
    JSON.stringify,
    () => 0,
    () => undefined,
    () => undefined,
  );
  /**
   * Register a meta-tool through the ungated path and invoke what the SDK
   * actually received. Reading the callback back off the `server.tool` spy is
   * the point: `_originalTool(...args)` spreads into a fresh array, so the
   * recorder is installed into the arguments the SDK gets, not into the caller's
   * array. An earlier version of this test invoked its own local handler, saw
   * nothing recorded, and would have passed against a no-op fix.
   */
  async function callMetaTool(name: string, handler: () => unknown): Promise<void> {
    (gate._originalTool as (...a: unknown[]) => unknown)(name, 'desc', {}, handler);
    const received = toolSpy.mock.calls.at(-1) as unknown[];
    await (received.at(-1) as () => Promise<unknown>)();
  }

  return { savings, callMetaTool };
}

describe('meta-tool call accounting (TRA-1162)', () => {
  it('records a call and its response tokens for load_tools', async () => {
    const { savings, callMetaTool } = harness();
    await callMetaTool('load_tools', () => ({
      content: [{ type: 'text', text: 'x'.repeat(400) }],
    }));

    expect(savings.recordCall).toHaveBeenCalledWith('load_tools');
    expect(savings.recordActualTokens).toHaveBeenCalledWith('load_tools', 100);
    expect(savings.recordFailedCall).not.toHaveBeenCalled();
  });

  it('credits an errored meta-tool zero, not a full response', async () => {
    const { savings, callMetaTool } = harness();
    await callMetaTool('get_preset_info', () => ({
      content: [{ type: 'text', text: 'nope' }],
      isError: true,
    }));

    expect(savings.recordCall).toHaveBeenCalledWith('get_preset_info');
    expect(savings.recordFailedCall).toHaveBeenCalledWith('get_preset_info', 1);
    expect(savings.recordActualTokens).not.toHaveBeenCalled();
  });

  it('credits a throwing meta-tool zero and lets the throw through', async () => {
    const { savings, callMetaTool } = harness();
    const boom = new Error('boom');
    await expect(
      callMetaTool('plan_turn', () => {
        throw boom;
      }),
    ).rejects.toThrow(boom);

    expect(savings.recordFailedCall).toHaveBeenCalledWith('plan_turn');
    expect(savings.recordActualTokens).not.toHaveBeenCalled();
  });

  it('leaves batch alone, so its dispatched sub-calls are not double-counted', async () => {
    const { savings, callMetaTool } = harness();
    await callMetaTool('batch', () => ({
      content: [{ type: 'text', text: 'x'.repeat(4000) }],
    }));

    // registerSessionTools already records each sub-call with its own tokens;
    // scoring the envelope too would book the same response twice.
    expect(savings.recordCall).not.toHaveBeenCalled();
    expect(savings.recordActualTokens).not.toHaveBeenCalled();
  });
});
