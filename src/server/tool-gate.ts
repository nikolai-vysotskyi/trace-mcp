/**
 * Tool registration gate: wraps McpServer.tool() with preset filtering,
 * description overrides, verbosity control, savings tracking, dedup, and journal.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TraceMcpConfig } from '../config.js';
import type { SessionJournal } from '../session/journal.js';
import type { SessionTracker } from '../session/tracker.js';
import type { JournalEntryCallbackData } from './journal-broadcast.js';
import {
  applySchemaTransforms,
  createGatedCallback,
  type GatedCallbackContext,
  injectAnnotations,
  schemaIndexOf,
  type SchemaTransformConfig,
  stampAlwaysLoad,
} from './tool-gate-helpers.js';
import { createToolFilter } from './tool-filter.js';
import type { ToolResponse } from './types.js';

/**
 * A tool registered but held back from this session's surface (TRA-402).
 * `enabled: false` keeps it out of `tools/list` and uncallable via
 * `tools/call`; `load_tools` flips it on and installs `handler` into the live
 * `toolHandlers` map so `batch` can reach it too.
 */
export interface DeferredTool {
  registered: { enabled: boolean; description?: string; inputSchema?: unknown };
  handler: (params: Record<string, unknown>) => Promise<ToolResponse>;
}

interface ToolGateResult {
  _originalTool: McpServer['tool'];
  registeredToolNames: string[];
  /**
   * Meta-tools registered through `_originalTool`, outside the preset gate.
   * They are advertised like any other tool, so the surface a client sees in
   * `tools/list` is these plus `registeredToolNames` — which is the basis
   * preset-surface-budget.test.ts measures, and the number the usage ping
   * reports as `tools_advertised` (TRA-643).
   */
  ungatedToolNames: string[];
  toolHandlers: Map<string, (params: Record<string, unknown>) => Promise<ToolResponse>>;
  /** Tools outside the active preset, registered-but-disabled and loadable. */
  deferredTools: Map<string, DeferredTool>;
}

/**
 * Monkey-patches `server.tool` to add:
 * - Preset-based filtering (only register allowed tools)
 * - Description overrides (flat string or per-param)
 * - Verbosity control (full/minimal/none)
 * - Callback wrapping for savings tracking + journal + dedup + optimization hints
 *
 * The heavy lifting lives in ./tool-gate-helpers.ts; this function is a thin
 * composition layer that wires per-call-invariant config into those helpers.
 */
export function installToolGate(
  server: McpServer,
  config: TraceMcpConfig,
  activePreset: Set<string> | 'all',
  savings: SessionTracker,
  journal: SessionJournal,
  j: (value: unknown) => string,
  extractResultCount: (response: {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }) => number,
  extractCompactResult: (
    toolName: string,
    response: { content: Array<{ type: string; text: string }>; isError?: boolean },
  ) => Record<string, unknown> | undefined,
  stripMetaFields: (obj: Record<string, unknown>) => void,
  projectRoot?: string,
  recordToolCall?: (success: boolean) => void,
  onJournalEntry?: (data: JournalEntryCallbackData) => void,
  sessionId?: string,
): ToolGateResult {
  const descriptionOverrides = config.tools?.descriptions ?? {};
  const schemaTransformConfig: SchemaTransformConfig = {
    descriptionVerbosity: config.tools?.description_verbosity ?? 'full',
    compactSchemas: config.tools?.compact_schemas ?? false,
    descriptionOverrides,
    sharedParamOverrides:
      typeof descriptionOverrides._shared === 'object' && descriptionOverrides._shared !== null
        ? (descriptionOverrides._shared as Record<string, string>)
        : {},
  };

  // Shared with the daemon proxy's per-session filter (TRA-250) so the local
  // and daemon-backed surfaces cannot drift apart.
  const toolAllowed = createToolFilter(config, activePreset);

  const _originalTool = server.tool.bind(server);
  const registeredToolNames: string[] = [];
  const ungatedToolNames: string[] = [];
  const toolHandlers = new Map<
    string,
    (params: Record<string, unknown>) => Promise<ToolResponse>
  >();
  const deferredTools = new Map<string, DeferredTool>();

  /** Build the per-call context threaded into the wrapped callback. */
  const gatedCallbackContext = (name: string): GatedCallbackContext => ({
    name,
    config,
    savings,
    journal,
    j,
    extractResultCount,
    extractCompactResult,
    stripMetaFields,
    projectRoot,
    recordToolCall,
    onJournalEntry,
    sessionId,
  });

  server.tool = ((...args: unknown[]) => {
    const name = args[0] as string;
    // TRA-402: a tool outside the preset is still registered — just disabled,
    // so it stays out of `tools/list` (no schema tokens) while `load_tools`
    // can turn it on mid-session. `tools.exclude` is checked separately by
    // `load_tools` so a hard exclusion can never be escalated back in.
    const allowed = toolAllowed(name);
    if (allowed) registeredToolNames.push(name);

    // Transform description + input schema (overrides, verbosity, compaction).
    applySchemaTransforms(args, schemaTransformConfig);

    // Wrap callback for savings/journal/dedup/hints.
    const cbIdx = args.length - 1;
    const originalCb = args[cbIdx] as (...args: unknown[]) => unknown;
    let deferredHandler: DeferredTool['handler'] | undefined;
    if (typeof originalCb === 'function') {
      const handler = async (params: Record<string, unknown>) =>
        (await originalCb(params)) as ToolResponse;
      if (allowed) toolHandlers.set(name, handler);
      else deferredHandler = handler;
      const schema = args[schemaIndexOf(args)];
      const supportsDetailLevel = !!(
        schema &&
        typeof schema === 'object' &&
        'detail_level' in schema
      );
      args[cbIdx] = createGatedCallback(
        { ...gatedCallbackContext(name), supportsDetailLevel },
        originalCb,
      );
    }

    // Inject ToolAnnotations before the callback so the MCP SDK registers
    // behavioural hints (readOnlyHint, destructiveHint, etc.).
    injectAnnotations(args);

    const registered = (_originalTool as (...args: unknown[]) => unknown)(...args);
    stampAlwaysLoad(name, registered);
    if (!allowed && registered && typeof registered === 'object') {
      // Assign the flag rather than calling `.disable()`: the SDK's disable()
      // routes through update(), which fires a tools/list_changed per call —
      // ~140 notifications on a `minimal` session. One notification is emitted
      // by load_tools instead, when the surface actually changes.
      const entry = registered as { enabled: boolean; description?: string; inputSchema?: unknown };
      entry.enabled = false;
      if (deferredHandler) deferredTools.set(name, { registered: entry, handler: deferredHandler });
    }
    return registered as ReturnType<typeof server.tool>;
  }) as typeof server.tool;

  // Wrap _originalTool so tools registered outside the gate (session meta-tools)
  // also get annotations injected automatically — and the always-load _meta
  // stamp, so meta-tools like `batch` (registered through this path) inherit
  // the same eager-load behaviour as gated tools.
  const annotatedOriginalTool = ((...oArgs: unknown[]) => {
    const oName = oArgs[0] as string;
    ungatedToolNames.push(oName);
    injectAnnotations(oArgs);
    const registered = (_originalTool as (...args: unknown[]) => unknown)(...oArgs);
    stampAlwaysLoad(oName, registered);
    return registered;
  }) as typeof _originalTool;

  return {
    _originalTool: annotatedOriginalTool,
    registeredToolNames,
    ungatedToolNames,
    toolHandlers,
    deferredTools,
  };
}
