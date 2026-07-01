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
  type SchemaTransformConfig,
  stampAlwaysLoad,
} from './tool-gate-helpers.js';
import type { ToolResponse } from './types.js';

interface ToolGateResult {
  _originalTool: McpServer['tool'];
  registeredToolNames: string[];
  toolHandlers: Map<string, (params: Record<string, unknown>) => Promise<ToolResponse>>;
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
  const includeSet = config.tools?.include ? new Set(config.tools.include) : null;
  const excludeSet = config.tools?.exclude ? new Set(config.tools.exclude) : null;
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

  function toolAllowed(name: string): boolean {
    if (excludeSet?.has(name)) return false;
    if (includeSet?.has(name)) return true;
    if (activePreset === 'all') return true;
    return activePreset.has(name);
  }

  const _originalTool = server.tool.bind(server);
  const registeredToolNames: string[] = [];
  const toolHandlers = new Map<
    string,
    (params: Record<string, unknown>) => Promise<ToolResponse>
  >();

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
    if (!toolAllowed(name)) return undefined as never;
    registeredToolNames.push(name);

    // Transform description + input schema (overrides, verbosity, compaction).
    applySchemaTransforms(args, schemaTransformConfig);

    // Wrap callback for savings/journal/dedup/hints.
    const cbIdx = args.length - 1;
    const originalCb = args[cbIdx] as (...args: unknown[]) => unknown;
    if (typeof originalCb === 'function') {
      toolHandlers.set(name, async (params: Record<string, unknown>) => {
        return (await originalCb(params)) as ToolResponse;
      });
      args[cbIdx] = createGatedCallback(gatedCallbackContext(name), originalCb);
    }

    // Inject ToolAnnotations before the callback so the MCP SDK registers
    // behavioural hints (readOnlyHint, destructiveHint, etc.).
    injectAnnotations(args);

    const registered = (_originalTool as (...args: unknown[]) => unknown)(...args);
    stampAlwaysLoad(name, registered);
    return registered as ReturnType<typeof server.tool>;
  }) as typeof server.tool;

  // Wrap _originalTool so tools registered outside the gate (session meta-tools)
  // also get annotations injected automatically — and the always-load _meta
  // stamp, so meta-tools like `batch` (registered through this path) inherit
  // the same eager-load behaviour as gated tools.
  const annotatedOriginalTool = ((...oArgs: unknown[]) => {
    const oName = oArgs[0] as string;
    injectAnnotations(oArgs);
    const registered = (_originalTool as (...args: unknown[]) => unknown)(...oArgs);
    stampAlwaysLoad(oName, registered);
    return registered;
  }) as typeof _originalTool;

  return { _originalTool: annotatedOriginalTool, registeredToolNames, toolHandlers };
}
