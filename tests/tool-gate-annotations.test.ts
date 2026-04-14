/**
 * Verify that installToolGate injects ToolAnnotations into server.tool() calls.
 */
import { describe, it, expect, vi } from 'vitest';
import { installToolGate } from '../src/server/tool-gate.js';

/** Captures all calls that reach the real underlying tool registration. */
function makeMockServer() {
  const capturedCalls: { name: string; args: unknown[] }[] = [];
  const server = {
    tool: (...args: unknown[]) => {
      capturedCalls.push({ name: args[0] as string, args: [...args] });
    },
  };
  return { server, capturedCalls };
}

function makeMockConfig() {
  return { tools: {} } as any;
}

function makeMockSavings() {
  return {
    recordCall: vi.fn(),
    getSessionStats: () => ({ total_calls: 0, total_raw_tokens: 0 }),
    getFullStats: () => ({}),
  } as any;
}

function makeMockJournal() {
  return {
    checkDuplicate: () => null,
    record: vi.fn(),
    getOptimizationHint: () => null,
    getDedupSavedTokens: () => 0,
    recordDedupSaving: vi.fn(),
    getSummary: () => ({}),
    getSnapshot: () => ({}),
  } as any;
}

describe('tool-gate annotations injection', () => {
  it('injects read-only annotations for analysis tools via server.tool', () => {
    const { server, capturedCalls } = makeMockServer();

    installToolGate(
      server as any,
      makeMockConfig(),
      'all',
      makeMockSavings(),
      makeMockJournal(),
      JSON.stringify,
      () => 0,
      () => undefined,
      () => {},
    );

    // Register a read-only tool through the patched server.tool
    server.tool('search' as any, 'Search for stuff', {}, async () => ({ content: [] }));

    // The captured call should have annotations spliced in before callback
    // Original: (name, desc, schema, cb) → 4 args
    // After gate: (name, desc, schema, annotations, cb) → 5 args
    const call = capturedCalls.find(c => c.name === 'search');
    expect(call, 'search should have been registered').toBeTruthy();
    expect(call!.args.length).toBe(5); // name, desc, schema, annotations, wrappedCb

    const annotations = call!.args[3] as Record<string, boolean>;
    expect(annotations.readOnlyHint).toBe(true);
    expect(annotations.destructiveHint).toBe(false);
    expect(annotations.idempotentHint).toBe(true);
    expect(annotations.openWorldHint).toBe(false);
  });

  it('injects destructive annotations for apply_codemod via server.tool', () => {
    const { server, capturedCalls } = makeMockServer();

    installToolGate(
      server as any,
      makeMockConfig(),
      'all',
      makeMockSavings(),
      makeMockJournal(),
      JSON.stringify,
      () => 0,
      () => undefined,
      () => {},
    );

    server.tool('apply_codemod' as any, 'Bulk regex', {}, async () => ({ content: [] }));

    const call = capturedCalls.find(c => c.name === 'apply_codemod');
    expect(call).toBeTruthy();

    const annotations = call!.args[3] as Record<string, boolean>;
    expect(annotations.readOnlyHint).toBe(false);
    expect(annotations.destructiveHint).toBe(true);
    expect(annotations.idempotentHint).toBe(false);
    expect(annotations.openWorldHint).toBe(false);
  });

  it('injects index-mutating annotations for reindex via server.tool', () => {
    const { server, capturedCalls } = makeMockServer();

    installToolGate(
      server as any,
      makeMockConfig(),
      'all',
      makeMockSavings(),
      makeMockJournal(),
      JSON.stringify,
      () => 0,
      () => undefined,
      () => {},
    );

    server.tool('reindex' as any, 'Reindex project', {}, async () => ({ content: [] }));

    const call = capturedCalls.find(c => c.name === 'reindex');
    expect(call).toBeTruthy();

    const annotations = call!.args[3] as Record<string, boolean>;
    expect(annotations.readOnlyHint).toBe(false);
    expect(annotations.destructiveHint).toBe(false);
    expect(annotations.idempotentHint).toBe(true);
  });

  it('injects annotations via _originalTool for meta tools', () => {
    const { server, capturedCalls } = makeMockServer();

    const { _originalTool } = installToolGate(
      server as any,
      makeMockConfig(),
      'all',
      makeMockSavings(),
      makeMockJournal(),
      JSON.stringify,
      () => 0,
      () => undefined,
      () => {},
    );

    // Simulate session.ts calling _originalTool directly (bypasses gate)
    (_originalTool as any)('batch', 'Execute multiple tools', {}, async () => ({ content: [] }));

    const call = capturedCalls.find(c => c.name === 'batch');
    expect(call, 'batch should have been registered via _originalTool').toBeTruthy();
    expect(call!.args.length).toBe(5); // annotations injected

    const annotations = call!.args[3] as Record<string, boolean>;
    expect(annotations.readOnlyHint).toBe(true); // batch is read-only by default
  });

  it('all annotations have all four fields defined', () => {
    const { server, capturedCalls } = makeMockServer();

    installToolGate(
      server as any,
      makeMockConfig(),
      'all',
      makeMockSavings(),
      makeMockJournal(),
      JSON.stringify,
      () => 0,
      () => undefined,
      () => {},
    );

    // Register a sample of tools
    const toolNames = ['search', 'apply_codemod', 'reindex', 'get_outline', 'add_decision'];
    for (const name of toolNames) {
      server.tool(name as any, 'desc', {}, async () => ({ content: [] }));
    }

    for (const call of capturedCalls) {
      const ann = call.args[3] as Record<string, boolean>;
      expect(ann, `${call.name} should have annotations`).toBeTruthy();
      expect(typeof ann.readOnlyHint, `${call.name}.readOnlyHint`).toBe('boolean');
      expect(typeof ann.destructiveHint, `${call.name}.destructiveHint`).toBe('boolean');
      expect(typeof ann.idempotentHint, `${call.name}.idempotentHint`).toBe('boolean');
      expect(typeof ann.openWorldHint, `${call.name}.openWorldHint`).toBe('boolean');
    }
  });
});
