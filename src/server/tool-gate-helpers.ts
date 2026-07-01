/**
 * Helper functions extracted from `installToolGate` (tool-gate.ts).
 *
 * These are cohesive, single-responsibility pieces of the tool-registration
 * gate: schema transformation, annotation injection, and the wrapped-callback
 * pipeline (budget clamping, dedup, journal, response enrichment, wire-format).
 * Splitting them out of the monster closure keeps `installToolGate` a thin
 * composition layer and drops its cyclomatic complexity dramatically.
 *
 * Behavior is intentionally identical to the original inline code — this is a
 * pure refactor. The functions take explicit context objects instead of
 * closing over `installToolGate`'s locals.
 */
import type { TraceMcpConfig } from '../config.js';
import type { SessionJournal } from '../session/journal.js';
import type { SessionTracker } from '../session/tracker.js';
import type { JournalEntryCallbackData } from './journal-broadcast.js';
import { getGlobalTelemetrySink } from '../telemetry/index.js';
import { ALWAYS_LOAD_TOOLS } from '../tools/project/presets.js';
import { applyBudgetDefaults, buildClampWarnings, computeBudgetLevel } from './budget-defaults.js';
import { COMPACT_CORE_PARAMS } from './compact-params.js';
import { markToolConsultation } from './consultation-markers.js';
import { getToolAnnotations } from './tool-annotations.js';
import { encodeWire, type WireFormat } from './wire-format.js';

/** Shape of a tool response coming back from a wrapped callback. */
type WrappedToolResponse = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

/**
 * Position of the input-schema argument in a `server.tool(...)` call:
 * `(name, description?, schema?, annotations?, callback)`. When the second
 * argument is the (optional) description string the schema is at index 2,
 * otherwise it is at index 1.
 */
export function schemaIndexOf(args: unknown[]): number {
  return typeof args[1] === 'string' ? 2 : 1;
}

/** Apply per-parameter description overrides to a Zod-like schema object. */
export function applyParamOverrides(
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

/** Precomputed, per-call-invariant configuration for schema transforms. */
export interface SchemaTransformConfig {
  descriptionVerbosity: 'full' | 'minimal' | 'none' | string;
  compactSchemas: boolean;
  descriptionOverrides: Record<string, unknown>;
  sharedParamOverrides: Record<string, string>;
}

/** Collapse a tool description according to the configured verbosity level. */
function applyVerbosity(description: string, verbosity: string): string {
  if (verbosity === 'full') return description;
  if (verbosity === 'none') return '';
  const match = description.match(/^[^.]*\./);
  return match ? match[0] : description.split('\n')[0];
}

/** Rewrite the description argument (index 1) with any configured override. */
function applyDescriptionOverrides(args: unknown[], cfg: SchemaTransformConfig): void {
  const name = args[0] as string;
  const override = cfg.descriptionOverrides[name];
  if (override) {
    if (typeof override === 'string') {
      if (typeof args[1] === 'string') args[1] = override;
    } else if (typeof override === 'object') {
      const obj = override as Record<string, string>;
      if (obj._description && typeof args[1] === 'string') {
        args[1] = obj._description;
      }
      const schema = args[schemaIndexOf(args)];
      if (schema && typeof schema === 'object') {
        applyParamOverrides(schema as Record<string, unknown>, obj, cfg.sharedParamOverrides);
      }
    }
  } else if (Object.keys(cfg.sharedParamOverrides).length > 0) {
    const schema = args[schemaIndexOf(args)];
    if (schema && typeof schema === 'object') {
      applyParamOverrides(schema as Record<string, unknown>, {}, cfg.sharedParamOverrides);
    }
  }
}

/** Drop per-parameter `description` metadata for minimal/none verbosity. */
function stripParamDescriptions(args: unknown[]): void {
  const schema = args[schemaIndexOf(args)];
  if (!schema || typeof schema !== 'object') return;
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

/** Remove non-core params from the schema when `compact_schemas` is enabled. */
function stripAdvancedParams(args: unknown[]): void {
  const name = args[0] as string;
  const coreParams = COMPACT_CORE_PARAMS[name];
  if (!coreParams) return;
  const schema = args[schemaIndexOf(args)];
  if (!schema || typeof schema !== 'object') return;
  const coreSet = new Set(coreParams);
  for (const key of Object.keys(schema as Record<string, unknown>)) {
    if (!coreSet.has(key)) {
      delete (schema as Record<string, unknown>)[key];
    }
  }
}

/**
 * Apply the full schema/description transform pipeline to a `server.tool(...)`
 * argument list, in place: description overrides, verbosity collapse, param
 * description stripping, and compact-schema pruning.
 */
export function applySchemaTransforms(args: unknown[], cfg: SchemaTransformConfig): void {
  applyDescriptionOverrides(args, cfg);

  if (cfg.descriptionVerbosity !== 'full' && typeof args[1] === 'string') {
    args[1] = applyVerbosity(args[1] as string, cfg.descriptionVerbosity);
  }

  if (cfg.descriptionVerbosity === 'minimal' || cfg.descriptionVerbosity === 'none') {
    stripParamDescriptions(args);
  }

  if (cfg.compactSchemas) {
    stripAdvancedParams(args);
  }
}

/**
 * Insert ToolAnnotations immediately before the trailing callback so the MCP
 * SDK registers behavioural hints (readOnlyHint, destructiveHint, etc.).
 */
export function injectAnnotations(args: unknown[]): void {
  const name = args[0] as string;
  const annotations = getToolAnnotations(name);
  const lastIdx = args.length - 1;
  if (typeof args[lastIdx] === 'function') {
    args.splice(lastIdx, 0, annotations);
  }
}

/**
 * Stamp `_meta: { 'anthropic/alwaysLoad': true }` on the small set of
 * first-five-minutes tools so Claude Code keeps them in the eager schema even
 * when the user's mcpServers entry doesn't set the server-wide alwaysLoad flag.
 */
export function stampAlwaysLoad(name: string, registered: unknown): void {
  if (ALWAYS_LOAD_TOOLS.has(name) && registered && typeof registered === 'object') {
    const r = registered as { _meta?: Record<string, unknown> };
    r._meta = { ...(r._meta ?? {}), 'anthropic/alwaysLoad': true };
  }
}

/** Context threaded into the wrapped tool callback. */
export interface GatedCallbackContext {
  name: string;
  config: TraceMcpConfig;
  savings: SessionTracker;
  journal: SessionJournal;
  j: (value: unknown) => string;
  extractResultCount: (response: WrappedToolResponse) => number;
  extractCompactResult: (
    toolName: string,
    response: WrappedToolResponse,
  ) => Record<string, unknown> | undefined;
  stripMetaFields: (obj: Record<string, unknown>) => void;
  projectRoot?: string;
  recordToolCall?: (success: boolean) => void;
  onJournalEntry?: (data: JournalEntryCallbackData) => void;
  sessionId?: string;
}

/** Emit a journal-broadcast entry for the most recent journal record. */
function emitJournalEntry(
  ctx: GatedCallbackContext,
  fields: { count: number; resultTokens: number | undefined; latencyMs: number; isError: boolean },
): void {
  if (!ctx.onJournalEntry || !ctx.sessionId) return;
  ctx.onJournalEntry({
    project: ctx.projectRoot ?? '',
    ts: Date.now(),
    tool: ctx.name,
    params_summary: ctx.journal.getEntries().at(-1)?.params_summary ?? '',
    result_count: fields.count,
    result_tokens: fields.resultTokens,
    latency_ms: fields.latencyMs,
    is_error: fields.isError,
    session_id: ctx.sessionId,
  });
}

/**
 * Parse a tool response's JSON text into an object, apply `mutate`, then
 * re-serialize it back into `resultObj.content[0].text`. Non-object JSON is
 * wrapped as `{ data: <value> }`. Corrupt JSON is left untouched.
 */
function rewriteResponseJson(
  ctx: GatedCallbackContext,
  resultObj: WrappedToolResponse,
  mutate: (obj: Record<string, unknown>) => void,
): void {
  try {
    const parsed = JSON.parse(resultObj.content[0].text);
    const obj: Record<string, unknown> =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed
        : { data: parsed };
    mutate(obj);
    ctx.stripMetaFields(obj);
    resultObj.content[0].text = JSON.stringify(obj);
  } catch {
    /* keep original response */
  }
}

/** Resolve the effective wire format for a call, stripping `_format` from params. */
function resolveWireFormat(ctx: GatedCallbackContext, params: Record<string, unknown>): WireFormat {
  const callFormat =
    typeof params._format === 'string' &&
    (params._format === 'json' || params._format === 'compact' || params._format === 'auto')
      ? (params._format as WireFormat)
      : undefined;
  if (callFormat !== undefined) delete params._format;
  return callFormat ?? (ctx.config.tools?.default_format as WireFormat | undefined) ?? 'json';
}

/** Dedup fast-path: returns a response when a duplicate is served, else null. */
async function handleDuplicate(
  ctx: GatedCallbackContext,
  dupInfo: NonNullable<ReturnType<SessionJournal['checkDuplicate']>>,
  params: Record<string, unknown>,
  cbArgs: unknown[],
  originalCb: (...args: unknown[]) => unknown,
): Promise<WrappedToolResponse> {
  if (dupInfo.action === 'dedup' && dupInfo.compact_result) {
    ctx.journal.recordDedupSaving(dupInfo.saved_tokens);
    const dedupResponse = {
      ...dupInfo.compact_result,
      _dedup: {
        message: dupInfo.message,
        saved_tokens: dupInfo.saved_tokens,
        hint: 'Full result was already returned earlier this session. This is a compact reference with metadata only (no source bodies).',
      },
    };
    ctx.stripMetaFields(dedupResponse);
    ctx.journal.record(ctx.name, params, (dupInfo.compact_result._result_count as number) ?? 1);
    return { content: [{ type: 'text', text: ctx.j(dedupResponse) }] };
  }

  // Warn-only path: run the tool, annotate the response with the dup warning.
  const warnStart = Date.now();
  const result = (await originalCb(...cbArgs)) as WrappedToolResponse;
  const warnLatency = Date.now() - warnStart;
  ctx.savings.recordLatency(ctx.name, warnLatency, !!result?.isError);
  ctx.recordToolCall?.(!result?.isError);
  if (result?.content?.[0]?.text && !result.isError) {
    rewriteResponseJson(ctx, result, (obj) => {
      obj._duplicate_warning = dupInfo.message;
    });
  }
  const count = ctx.extractResultCount(result);
  ctx.journal.record(ctx.name, params, count);
  emitJournalEntry(ctx, {
    count,
    resultTokens: undefined,
    latencyMs: warnLatency,
    isError: !!result?.isError,
  });
  return result;
}

/** Enrich a successful response with optimization hint, budget defaults, warnings. */
function enrichResponse(
  ctx: GatedCallbackContext,
  resultObj: WrappedToolResponse,
  params: Record<string, unknown>,
  originalParamSnapshot: Record<string, unknown>,
  appliedDefaults: ReturnType<typeof applyBudgetDefaults>,
): void {
  const optHint = ctx.journal.getOptimizationHint(ctx.name, params);
  // We synthesize a top-level `_warnings` array whenever budget defaults
  // clamped a requested parameter or the tool flagged truncation. `_warnings`
  // is a first-class, top-level field that callers can't overlook.
  const needsResponseRewrite =
    optHint || appliedDefaults.length > 0 || resultObj?.content?.[0]?.text;
  if (!needsResponseRewrite || !resultObj?.content?.[0]?.text || resultObj.isError) return;

  rewriteResponseJson(ctx, resultObj, (obj) => {
    if (optHint) obj._optimization_hint = optHint;
    if (appliedDefaults.length > 0) {
      obj._meta = {
        ...(obj._meta && typeof obj._meta === 'object'
          ? (obj._meta as Record<string, unknown>)
          : {}),
        budget_defaults: appliedDefaults,
      };
    }
    const existing: string[] = Array.isArray(obj._warnings)
      ? obj._warnings.filter((w: unknown): w is string => typeof w === 'string')
      : [];
    const synthesized = buildClampWarnings(ctx.name, originalParamSnapshot, appliedDefaults, obj);
    const warnings = [...existing, ...synthesized];
    if (warnings.length > 0) obj._warnings = warnings;
  });
}

/** Re-encode a successful response into the effective non-JSON wire format. */
function applyWireFormat(resultObj: WrappedToolResponse, effectiveFormat: WireFormat): void {
  if (effectiveFormat === 'json' || !resultObj?.content?.[0]?.text || resultObj.isError) return;
  try {
    const parsed = JSON.parse(resultObj.content[0].text);
    const reencoded = encodeWire(parsed, effectiveFormat);
    resultObj.content[0].text = reencoded.text;
  } catch {
    /* keep original — corrupt JSON is worse than losing the format upgrade */
  }
}

/**
 * Build the wrapped tool callback that adds savings tracking, budget clamping,
 * consultation markers, dedup, journal, telemetry, response enrichment, and
 * wire-format re-encoding around the original tool callback.
 */
export function createGatedCallback(
  ctx: GatedCallbackContext,
  originalCb: (...args: unknown[]) => unknown,
): (...cbArgs: unknown[]) => Promise<unknown> {
  return async (...cbArgs: unknown[]) => {
    ctx.savings.recordCall(ctx.name);
    const params =
      cbArgs[0] && typeof cbArgs[0] === 'object' ? (cbArgs[0] as Record<string, unknown>) : {};

    const effectiveFormat = resolveWireFormat(ctx, params);

    // Budget-driven auto-defaults: at warning/critical level, silently cap
    // expensive parameters before the tool runs. Snapshot the original values
    // first, since `applyBudgetDefaults` mutates `params` in place.
    const stats = ctx.savings.getSessionStats();
    const budgetLevel = computeBudgetLevel(stats.total_calls, stats.total_raw_tokens);
    const originalParamSnapshot: Record<string, unknown> = {};
    for (const key of Object.keys(params)) originalParamSnapshot[key] = params[key];
    const appliedDefaults = applyBudgetDefaults(ctx.name, params, budgetLevel);

    // Mark files as consulted via trace-mcp (read by guard hook)
    if (ctx.projectRoot) markToolConsultation(ctx.projectRoot, ctx.name, params);

    // Dedup check
    const dupInfo = ctx.journal.checkDuplicate(ctx.name, params);
    if (dupInfo) {
      return handleDuplicate(ctx, dupInfo, params, cbArgs, originalCb);
    }

    // Normal path
    const normalStart = Date.now();
    const telemetrySpan = getGlobalTelemetrySink().startSpan(`tool.${ctx.name}`, {
      'tool.name': ctx.name,
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
    const resultObj = result as WrappedToolResponse;
    const normalLatency = Date.now() - normalStart;
    telemetrySpan.setAttributes({
      duration_ms: normalLatency,
      'tool.is_error': !!resultObj?.isError,
    });
    if (resultObj?.isError) telemetrySpan.setStatus('error');
    telemetrySpan.end();
    ctx.savings.recordLatency(ctx.name, normalLatency, !!resultObj?.isError);
    ctx.recordToolCall?.(!resultObj?.isError);
    const count = ctx.extractResultCount(resultObj);
    const compactResult = ctx.extractCompactResult(ctx.name, resultObj);
    const resultTokens = resultObj?.content?.[0]?.text?.length
      ? Math.ceil(resultObj.content[0].text.length / 4)
      : undefined;
    ctx.journal.record(ctx.name, params, count, { compactResult, resultTokens });
    emitJournalEntry(ctx, {
      count,
      resultTokens,
      latencyMs: normalLatency,
      isError: !!resultObj?.isError,
    });

    enrichResponse(ctx, resultObj, params, originalParamSnapshot, appliedDefaults);
    applyWireFormat(resultObj, effectiveFormat);

    return result;
  };
}
