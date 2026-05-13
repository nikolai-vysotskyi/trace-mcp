/**
 * Tool registration gate: wraps McpServer.tool() with preset filtering,
 * description overrides, verbosity control, savings tracking, dedup, and journal.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TraceMcpConfig } from '../config.js';
import type { SessionJournal } from '../session/journal.js';
import type { SessionTracker } from '../session/tracker.js';
import type { JournalEntryCallbackData } from './journal-broadcast.js';
import { getGlobalTelemetrySink } from '../telemetry/index.js';
import { ALWAYS_LOAD_TOOLS } from '../tools/project/presets.js';
import { applyBudgetDefaults, computeBudgetLevel } from './budget-defaults.js';
import { COMPACT_CORE_PARAMS } from './compact-params.js';
import { markToolConsultation } from './consultation-markers.js';
import { getToolAnnotations } from './tool-annotations.js';
import type { ToolResponse } from './types.js';
import { encodeWire, type WireFormat } from './wire-format.js';

interface ToolGateResult {
  _originalTool: McpServer['tool'];
  registeredToolNames: string[];
  toolHandlers: Map<string, (params: Record<string, unknown>) => Promise<ToolResponse>>;
}

/** Apply per-parameter description overrides to a Zod-like schema object. */
function applyParamOverrides(
  schema: Record<string, unknown>,
  toolOverrides: Record<string, string>,
  sharedOverrides: Record<string, string>,
): void {
  for (const paramName of Object.keys(schema)) {
    const desc = toolOverrides[paramName] ?? sharedOverrides[paramName];
    if (desc) {
      const zodType = schema[paramName];
      if (
        zodType &&
        typeof zodType === 'object' &&
        'describe' in zodType &&
        typeof (zodType as { describe: unknown }).describe === 'function'
      ) {
        schema[paramName] = (zodType as { describe: (d: string) => unknown }).describe(desc);
      }
    }
  }
}

/**
 * Monkey-patches `server.tool` to add:
 * - Preset-based filtering (only register allowed tools)
 * - Description overrides (flat string or per-param)
 * - Verbosity control (full/minimal/none)
 * - Callback wrapping for savings tracking + journal + dedup + optimization hints
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
  const descriptionVerbosity = config.tools?.description_verbosity ?? 'full';
  const compactSchemas = config.tools?.compact_schemas ?? false;

  function applyVerbosity(description: string): string {
    if (descriptionVerbosity === 'full') return description;
    if (descriptionVerbosity === 'none') return '';
    const match = description.match(/^[^.]*\./);
    return match ? match[0] : description.split('\n')[0];
  }

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
  const descriptionOverrides = config.tools?.descriptions ?? {};
  const sharedParamOverrides =
    typeof descriptionOverrides._shared === 'object' && descriptionOverrides._shared !== null
      ? (descriptionOverrides._shared as Record<string, string>)
      : {};

  server.tool = ((...args: unknown[]) => {
    const name = args[0] as string;
    if (!toolAllowed(name)) return undefined as never;
    registeredToolNames.push(name);

    // Apply description overrides
    const override = descriptionOverrides[name];
    if (override) {
      if (typeof override === 'string') {
        if (typeof args[1] === 'string') args[1] = override;
      } else if (typeof override === 'object') {
        const obj = override as Record<string, string>;
        if (obj._description && typeof args[1] === 'string') {
          args[1] = obj._description;
        }
        const schemaIdx = typeof args[1] === 'string' ? 2 : 1;
        const schema = args[schemaIdx];
        if (schema && typeof schema === 'object') {
          applyParamOverrides(schema as Record<string, unknown>, obj, sharedParamOverrides);
        }
      }
    } else if (Object.keys(sharedParamOverrides).length > 0) {
      const schemaIdx = typeof args[1] === 'string' ? 2 : 1;
      const schema = args[schemaIdx];
      if (schema && typeof schema === 'object') {
        applyParamOverrides(schema as Record<string, unknown>, {}, sharedParamOverrides);
      }
    }

    // Apply verbosity
    if (descriptionVerbosity !== 'full' && typeof args[1] === 'string') {
      args[1] = applyVerbosity(args[1] as string);
    }

    // Strip param descriptions when minimal/none
    if (descriptionVerbosity === 'minimal' || descriptionVerbosity === 'none') {
      const schemaIdx = typeof args[1] === 'string' ? 2 : 1;
      const schema = args[schemaIdx];
      if (schema && typeof schema === 'object') {
        for (const val of Object.values(schema as Record<string, unknown>)) {
          if (val && typeof val === 'object' && '_def' in val) {
            const def = (val as { _def: Record<string, unknown> })._def;
            // biome-ignore lint/performance/noDelete: Zod attaches `description` as a getter-only property; assigning undefined throws.
            delete def.description;
            // biome-ignore lint/performance/noDelete: same as above — Zod description is getter-only.
            delete (val as Record<string, unknown>).description;
          }
        }
      }
    }

    // Strip advanced params when compact_schemas is enabled
    if (compactSchemas) {
      const coreParams = COMPACT_CORE_PARAMS[name];
      if (coreParams) {
        const schemaIdx = typeof args[1] === 'string' ? 2 : 1;
        const schema = args[schemaIdx];
        if (schema && typeof schema === 'object') {
          const coreSet = new Set(coreParams);
          for (const key of Object.keys(schema as Record<string, unknown>)) {
            if (!coreSet.has(key)) {
              delete (schema as Record<string, unknown>)[key];
            }
          }
        }
      }
    }

    // Wrap callback for savings/journal/dedup/hints
    const cbIdx = args.length - 1;
    const originalCb = args[cbIdx] as (...args: unknown[]) => unknown;
    if (typeof originalCb === 'function') {
      toolHandlers.set(name, async (params: Record<string, unknown>) => {
        return (await originalCb(params)) as ToolResponse;
      });

      args[cbIdx] = async (...cbArgs: unknown[]) => {
        savings.recordCall(name);
        const params =
          cbArgs[0] && typeof cbArgs[0] === 'object' ? (cbArgs[0] as Record<string, unknown>) : {};

        // Extract per-call wire format override (`_format`) and strip it from
        // params so handlers don't see it. Falls back to server-wide default.
        const callFormat =
          typeof params._format === 'string' &&
          (params._format === 'json' || params._format === 'compact' || params._format === 'auto')
            ? (params._format as WireFormat)
            : undefined;
        if (callFormat !== undefined) delete params._format;
        const effectiveFormat: WireFormat =
          callFormat ?? (config.tools?.default_format as WireFormat | undefined) ?? 'json';

        // Budget-driven auto-defaults: at warning/critical level, silently cap
        // expensive parameters (graph depth, full project map, etc.) before the
        // tool runs. The applied list is attached to the response below.
        const stats = savings.getSessionStats();
        const budgetLevel = computeBudgetLevel(stats.total_calls, stats.total_raw_tokens);
        const appliedDefaults = applyBudgetDefaults(name, params, budgetLevel);

        // Mark files as consulted via trace-mcp (read by guard hook)
        if (projectRoot) markToolConsultation(projectRoot, name, params);

        // Dedup check
        const dupInfo = journal.checkDuplicate(name, params);
        if (dupInfo) {
          if (dupInfo.action === 'dedup' && dupInfo.compact_result) {
            journal.recordDedupSaving(dupInfo.saved_tokens);
            const dedupResponse = {
              ...dupInfo.compact_result,
              _dedup: {
                message: dupInfo.message,
                saved_tokens: dupInfo.saved_tokens,
                hint: 'Full result was already returned earlier this session. This is a compact reference with metadata only (no source bodies).',
              },
            };
            stripMetaFields(dedupResponse);
            journal.record(name, params, (dupInfo.compact_result._result_count as number) ?? 1);
            return { content: [{ type: 'text', text: j(dedupResponse) }] };
          }

          // Warn-only path
          const warnStart = Date.now();
          const result = (await originalCb(...cbArgs)) as {
            content: Array<{ type: string; text: string }>;
            isError?: boolean;
          };
          const warnLatency = Date.now() - warnStart;
          savings.recordLatency(name, warnLatency, !!result?.isError);
          recordToolCall?.(!result?.isError);
          if (result?.content?.[0]?.text && !result.isError) {
            try {
              const parsed = JSON.parse(result.content[0].text);
              const obj =
                parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
                  ? parsed
                  : { data: parsed };
              obj._duplicate_warning = dupInfo.message;
              stripMetaFields(obj);
              result.content[0].text = JSON.stringify(obj);
            } catch {
              /* keep original response */
            }
          }
          const count = extractResultCount(result);
          journal.record(name, params, count);
          if (onJournalEntry && sessionId) {
            onJournalEntry({
              project: projectRoot ?? '',
              ts: Date.now(),
              tool: name,
              params_summary: journal.getEntries().at(-1)?.params_summary ?? '',
              result_count: count,
              result_tokens: undefined,
              latency_ms: warnLatency,
              is_error: !!result?.isError,
              session_id: sessionId,
            });
          }
          return result;
        }

        // Normal path
        const normalStart = Date.now();
        const telemetrySpan = getGlobalTelemetrySink().startSpan(`tool.${name}`, {
          'tool.name': name,
        });
        let result: unknown;
        try {
          result = await originalCb(...cbArgs);
        } catch (err) {
          telemetrySpan.setAttribute('duration_ms', Date.now() - normalStart);
          telemetrySpan.recordError(err);
          telemetrySpan.end();
          throw err;
        }
        const resultObj = result as {
          content: Array<{ type: string; text: string }>;
          isError?: boolean;
        };
        const normalLatency = Date.now() - normalStart;
        telemetrySpan.setAttributes({
          duration_ms: normalLatency,
          'tool.is_error': !!resultObj?.isError,
        });
        if (resultObj?.isError) telemetrySpan.setStatus('error');
        telemetrySpan.end();
        savings.recordLatency(name, normalLatency, !!resultObj?.isError);
        recordToolCall?.(!resultObj?.isError);
        const count = extractResultCount(resultObj);
        const compactResult = extractCompactResult(name, resultObj);
        const resultTokens = resultObj?.content?.[0]?.text?.length
          ? Math.ceil(resultObj.content[0].text.length / 4)
          : undefined;
        journal.record(name, params, count, { compactResult, resultTokens });
        if (onJournalEntry && sessionId) {
          onJournalEntry({
            project: projectRoot ?? '',
            ts: Date.now(),
            tool: name,
            params_summary: journal.getEntries().at(-1)?.params_summary ?? '',
            result_count: count,
            result_tokens: resultTokens,
            latency_ms: normalLatency,
            is_error: !!resultObj?.isError,
            session_id: sessionId,
          });
        }

        // Optimization hint + budget auto-defaults metadata
        const optHint = journal.getOptimizationHint(name, params);
        if (
          (optHint || appliedDefaults.length > 0) &&
          resultObj?.content?.[0]?.text &&
          !resultObj.isError
        ) {
          try {
            const parsed = JSON.parse(resultObj.content[0].text);
            const obj =
              parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
                ? parsed
                : { data: parsed };
            if (optHint) obj._optimization_hint = optHint;
            if (appliedDefaults.length > 0) {
              obj._meta = {
                ...(obj._meta && typeof obj._meta === 'object'
                  ? (obj._meta as Record<string, unknown>)
                  : {}),
                budget_defaults: appliedDefaults,
              };
            }
            stripMetaFields(obj);
            resultObj.content[0].text = JSON.stringify(obj);
          } catch {
            /* keep original response */
          }
        }

        // Wire-format re-encoding (Phase 3a). Skipped for JSON (no-op) and for
        // error responses (errors should stay LLM-readable in plain JSON).
        if (effectiveFormat !== 'json' && resultObj?.content?.[0]?.text && !resultObj.isError) {
          try {
            const parsed = JSON.parse(resultObj.content[0].text);
            const reencoded = encodeWire(parsed, effectiveFormat);
            resultObj.content[0].text = reencoded.text;
          } catch {
            /* keep original — corrupt JSON is worse than losing the format upgrade */
          }
        }

        return result;
      };
    }
    // Inject ToolAnnotations before the callback so the MCP SDK
    // registers behavioural hints (readOnlyHint, destructiveHint, etc.)
    const annotations = getToolAnnotations(name);
    const lastIdx = args.length - 1;
    if (typeof args[lastIdx] === 'function') {
      args.splice(lastIdx, 0, annotations);
    }

    const registered = (_originalTool as (...args: unknown[]) => unknown)(...args);

    // Stamp `_meta: { 'anthropic/alwaysLoad': true }` on the small set of
    // first-five-minutes tools so Claude Code keeps them in the eager
    // schema even when the user's mcpServers entry doesn't set the
    // server-wide alwaysLoad flag (e.g. they registered trace-mcp by
    // hand or via an older `trace-mcp init`).
    if (ALWAYS_LOAD_TOOLS.has(name) && registered && typeof registered === 'object') {
      const r = registered as { _meta?: Record<string, unknown> };
      r._meta = { ...(r._meta ?? {}), 'anthropic/alwaysLoad': true };
    }

    return registered as ReturnType<typeof server.tool>;
  }) as typeof server.tool;

  // Wrap _originalTool so tools registered outside the gate (session meta-tools)
  // also get annotations injected automatically — and the always-load _meta
  // stamp, so meta-tools like `batch` (registered through this path) inherit
  // the same eager-load behaviour as gated tools.
  const annotatedOriginalTool = ((...oArgs: unknown[]) => {
    const oName = oArgs[0] as string;
    const ann = getToolAnnotations(oName);
    const oLastIdx = oArgs.length - 1;
    if (typeof oArgs[oLastIdx] === 'function') {
      oArgs.splice(oLastIdx, 0, ann);
    }
    const registered = (_originalTool as (...args: unknown[]) => unknown)(...oArgs);
    if (ALWAYS_LOAD_TOOLS.has(oName) && registered && typeof registered === 'object') {
      const r = registered as { _meta?: Record<string, unknown> };
      r._meta = { ...(r._meta ?? {}), 'anthropic/alwaysLoad': true };
    }
    return registered;
  }) as typeof _originalTool;

  return { _originalTool: annotatedOriginalTool, registeredToolNames, toolHandlers };
}
