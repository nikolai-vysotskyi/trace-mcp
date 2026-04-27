/**
 * Tool registration gate: wraps McpServer.tool() with preset filtering,
 * description overrides, verbosity control, savings tracking, dedup, and journal.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TraceMcpConfig } from '../config.js';
import type { SessionJournal } from '../session/journal.js';
import type { SessionTracker } from '../session/tracker.js';
import { applyBudgetDefaults, computeBudgetLevel } from './budget-defaults.js';
import { COMPACT_CORE_PARAMS } from './compact-params.js';
import { markToolConsultation } from './consultation-markers.js';
import { getToolAnnotations } from './tool-annotations.js';
import type { ToolResponse } from './types.js';

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
            delete def.description;
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
    const originalCb = args[cbIdx] as Function;
    if (typeof originalCb === 'function') {
      toolHandlers.set(name, async (params: Record<string, unknown>) => {
        return (await originalCb(params)) as ToolResponse;
      });

      args[cbIdx] = async (...cbArgs: unknown[]) => {
        savings.recordCall(name);
        const params =
          cbArgs[0] && typeof cbArgs[0] === 'object' ? (cbArgs[0] as Record<string, unknown>) : {};

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
          const result = (await originalCb(...cbArgs)) as {
            content: Array<{ type: string; text: string }>;
            isError?: boolean;
          };
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
          return result;
        }

        // Normal path
        const result = await originalCb(...cbArgs);
        const resultObj = result as {
          content: Array<{ type: string; text: string }>;
          isError?: boolean;
        };
        const count = extractResultCount(resultObj);
        const compactResult = extractCompactResult(name, resultObj);
        const resultTokens = resultObj?.content?.[0]?.text?.length
          ? Math.ceil(resultObj.content[0].text.length / 4)
          : undefined;
        journal.record(name, params, count, { compactResult, resultTokens });

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

    return (_originalTool as Function)(...args);
  }) as typeof server.tool;

  // Wrap _originalTool so tools registered outside the gate (session meta-tools)
  // also get annotations injected automatically.
  const annotatedOriginalTool = ((...oArgs: unknown[]) => {
    const oName = oArgs[0] as string;
    const ann = getToolAnnotations(oName);
    const oLastIdx = oArgs.length - 1;
    if (typeof oArgs[oLastIdx] === 'function') {
      oArgs.splice(oLastIdx, 0, ann);
    }
    return (_originalTool as Function)(...oArgs);
  }) as typeof _originalTool;

  return { _originalTool: annotatedOriginalTool, registeredToolNames, toolHandlers };
}
