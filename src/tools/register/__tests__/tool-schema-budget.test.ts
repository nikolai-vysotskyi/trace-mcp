import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { COMPACT_CORE_PARAMS } from '../../../server/compact-params.js';
import { applySchemaTransforms } from '../../../server/tool-gate-helpers.js';
import { captureAllTools } from './_capture-tools.js';

// Re-measured 2026-08-28 (TRA-240): 55.0k description chars across the
// always-on tools, after actually removing the seven deprecated consolidation
// aliases rather than only trimming their prose. TRA-239 got this to 56.3k by
// cutting the alias descriptions to one-line pointers; deleting the
// registrations outright took the rest.
// Raised to 60,000 on 2026-08-29 (TRA-402): 58,441 chars. The jump is not new
// prose — the capture harness's `_originalTool` stub used to swallow the nine
// ungated meta-tools (get_preset_info, batch, plan_turn, the analytics four,
// ...), so their descriptions were never counted by any budget here. They are
// now, along with `load_tools` (~600 chars of description).
const TOTAL_DESCRIPTION_CHAR_BUDGET = 60_000;
// No single tool description should need more prose than this to be usable
// — if a tool grows past it, the fix is almost always "move detail into the
// per-param describe() or the response docs", not a longer top-level string.
const PER_TOOL_DESCRIPTION_CHAR_CEILING = 800;
// Baseline measured 2026-08-27 (TRA-186 phase 2): ~30.2k chars of top-level
// param describe() text after the second trim pass (down from ~32.3k). This
// is the controllable slice of inputSchema — the rest (~60k+) is structural
// JSON Schema (type/required/enum/min/max) tied to legitimate parameter
// counts, not prose we write; cutting it further means removing parameters,
// a breaking MCP contract change out of scope for a description trim.
const TOTAL_PARAM_DESCRIPTION_CHAR_BUDGET = 32_000;

// Sums each field's top-level `.description` (zod v4 attaches it directly).
// Deliberately shallow — nested object/array param schemas in this codebase
// don't carry their own per-field describe() calls, so a shallow walk
// already captures the controllable text.
function sumParamDescriptions(schemaShape: Record<string, z.ZodTypeAny>): number {
  let total = 0;
  for (const field of Object.values(schemaShape)) {
    const desc = (field as { description?: unknown }).description;
    if (typeof desc === 'string') total += desc.length;
  }
  return total;
}

describe('MCP tool-schema token budget guardrail (TRA-186)', () => {
  const tools = captureAllTools();

  it('captures a non-trivial number of tools from all register files', () => {
    expect(tools.length).toBeGreaterThan(50);
  });

  it('keeps total tool description size under budget', () => {
    const total = tools.reduce((sum, t) => sum + t.description.length, 0);
    expect(
      total,
      `Total tool description chars (${total}) exceeds the budget (${TOTAL_DESCRIPTION_CHAR_BUDGET}). ` +
        'This text is paid in full by every MCP client without deferred tool loading, on every session ' +
        '(see TRA-186). Trim descriptions before raising this budget.',
    ).toBeLessThanOrEqual(TOTAL_DESCRIPTION_CHAR_BUDGET);
  });

  it('flags any single tool description that has ballooned past the per-tool ceiling', () => {
    const offenders = tools
      .filter((t) => t.description.length > PER_TOOL_DESCRIPTION_CHAR_CEILING)
      .map((t) => `  - ${t.name}: ${t.description.length} chars`);
    expect(
      offenders.length,
      `Tool description(s) exceed ${PER_TOOL_DESCRIPTION_CHAR_CEILING} chars:\n${offenders.join('\n')}\n` +
        'Move detail into per-param describe() text or the docs site instead of the top-level description.',
    ).toBe(0);
  });

  // Measured 2026-08-28 (TRA-240): 86,217 serialized schema chars across the
  // always-on tools, down from TRA-239's 90,579. The description and param-prose
  // budgets above only watch text we write; they are blind to structural schema
  // growth. TRA-193's consolidations added params to the surviving tool while
  // keeping the old tool registered as a deprecated alias, so the always-on tax
  // grew where nothing was measuring it; TRA-240 retired those seven aliases and
  // cut `search` back down. The gated groups already get a full-serialized check
  // (TRA-211) — this gives the always-on set, by far the largest group, the same
  // treatment.
  // Raised to 95,000 on 2026-09-01 (TRA-598) to accommodate the SKILL.state tools family.
  const TOTAL_SCHEMA_CHAR_BUDGET = 95_000;
  // No single tool's serialized schema should need more than this. `search` is
  // still the worst case at 3,119 (down from 4,034 — it lost the nested
  // fusion_weights object and its duplicated mode prose), with query_decisions
  // right behind at 3,005. Anything approaching this wants params moved into a
  // sibling tool, not a bigger ceiling.
  const PER_TOOL_SCHEMA_CHAR_CEILING = 3_300;

  it('keeps total serialized inputSchema size under budget', () => {
    const total = tools.reduce((sum, t) => sum + fullSchemaCharSize(t.schemaShape), 0);
    expect(
      total,
      `Total serialized inputSchema chars (${total}) exceeds the budget (${TOTAL_SCHEMA_CHAR_BUDGET}). ` +
        'Every MCP client without deferred tool loading pays this on every session. Consolidating tools ' +
        'only helps if the old tool is actually retired — adding params while keeping the alias makes this ' +
        'number grow (TRA-239).',
    ).toBeLessThanOrEqual(TOTAL_SCHEMA_CHAR_BUDGET);
  });

  it('flags any single tool whose serialized schema has ballooned', () => {
    const offenders = tools
      .map((t) => ({ name: t.name, size: fullSchemaCharSize(t.schemaShape) }))
      .filter((t) => t.size > PER_TOOL_SCHEMA_CHAR_CEILING)
      .map((t) => `  - ${t.name}: ${t.size} chars`);
    expect(offenders.length, `Tool schema(s) past the ceiling:\n${offenders.join('\n')}`).toBe(0);
  });

  it('keeps total param describe() text under budget', () => {
    const total = tools.reduce((sum, t) => sum + sumParamDescriptions(t.schemaShape), 0);
    expect(
      total,
      `Total param describe() chars (${total}) exceeds the budget (${TOTAL_PARAM_DESCRIPTION_CHAR_BUDGET}). ` +
        'Trim per-param descriptions before raising this budget — see TRA-186.',
    ).toBeLessThanOrEqual(TOTAL_PARAM_DESCRIPTION_CHAR_BUDGET);
  });
});

// The 15 tools registered behind `config.topology.enabled && ctx.topoStore` in
// advanced.ts. Opt-in, but any user who turns topology on pays their full schema
// cost every session — so they get the same budget treatment as the always-on
// tools (TRA-211).
const TOPOLOGY_TOOL_NAMES = [
  'get_service_map',
  'get_cross_service_impact',
  'get_api_contract',
  'get_service_deps',
  'get_contract_drift',
  'get_federation_impact',
  'get_subproject_graph',
  'get_subproject_impact',
  'subproject_add_repo',
  'subproject_sync',
  'detect_topic_tunnels',
  'get_subproject_clients',
  'get_contract_versions',
  'discover_claude_sessions',
  'visualize_subproject_topology',
] as const;

// Measured 2026-08-27 (TRA-211): 5,587 description + 5,701 schema = 11,288
// combined chars across the 15 topology tools. Same headroom rationale as
// TOTAL_DESCRIPTION_CHAR_BUDGET.
const TOPOLOGY_COMBINED_CHAR_BUDGET = 13_000;

const TOPOLOGY_CTX: Record<string, unknown> = {
  config: { topology: { enabled: true, repos: [] } },
  topoStore: {},
};

// Full serialized JSON Schema size, not just the prose we write — that's the
// number the topology group was originally measured against.
function fullSchemaCharSize(schemaShape: Record<string, z.ZodTypeAny>): number {
  return JSON.stringify(z.toJSONSchema(z.object(schemaShape))).length;
}

describe('MCP tool-schema token budget guardrail — topology-gated tools (TRA-211)', () => {
  const tools = captureAllTools(TOPOLOGY_CTX);
  const topologyTools = tools.filter((t) =>
    (TOPOLOGY_TOOL_NAMES as readonly string[]).includes(t.name),
  );

  it('registers all topology-gated tools when config.topology.enabled is true', () => {
    const names = new Set(tools.map((t) => t.name));
    const missing = TOPOLOGY_TOOL_NAMES.filter((n) => !names.has(n));
    expect(missing, `Missing topology tools: ${missing.join(', ')}`).toEqual([]);
  });

  it('keeps combined topology-tool description+schema size under budget', () => {
    const total = topologyTools.reduce(
      (sum, t) => sum + t.description.length + fullSchemaCharSize(t.schemaShape),
      0,
    );
    expect(
      total,
      `Topology-tool combined chars (${total}) exceed the budget (${TOPOLOGY_COMBINED_CHAR_BUDGET}). ` +
        'These tools are opt-in but paid in full by any user who enables topology — see TRA-211.',
    ).toBeLessThanOrEqual(TOPOLOGY_COMBINED_CHAR_BUDGET);
  });

  it('flags any single topology tool description past the shared per-tool ceiling', () => {
    const offenders = topologyTools
      .filter((t) => t.description.length > PER_TOOL_DESCRIPTION_CHAR_CEILING)
      .map((t) => `  - ${t.name}: ${t.description.length} chars`);
    expect(offenders.length, offenders.join('\n')).toBe(0);
  });
});

// Regex over `server.tool('name'` call sites. Deliberately dumb rather than an
// AST walk — the codebase registers tools with one consistent call shape, and
// the same shallow-is-enough reasoning as sumParamDescriptions applies.
function scanRegisteredToolNamesFromSource(): Set<string> {
  const registerDir = fileURLToPath(new URL('..', import.meta.url));
  const names = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      for (const m of readFileSync(full, 'utf8').matchAll(
        /server\.tool\(\s*['"]([a-zA-Z0-9_]+)['"]/g,
      )) {
        names.add(m[1]);
      }
    }
  };
  walk(registerDir);
  return names;
}

// Framework tools in framework.ts are gated on `ctx.has('vue', 'nestjs', ...)`,
// which the default stub answers `false` to — so they were invisible to the
// budget for the same reason the topology block was. A blanket-true `has()`
// activates every framework branch at once (TRA-211).
const FRAMEWORK_CTX: Record<string, unknown> = { has: () => true };

// Measured 2026-08-28 (TRA-211). Headroom rationale as above.
const FRAMEWORK_COMBINED_CHAR_BUDGET = 22_000;

describe('MCP tool-schema token budget guardrail — framework-gated tools (TRA-211)', () => {
  const alwaysOn = new Set(captureAllTools().map((t) => t.name));
  // Derived, not hardcoded: whatever only appears once has() answers true.
  const frameworkOnly = captureAllTools(FRAMEWORK_CTX).filter((t) => !alwaysOn.has(t.name));

  it('activates the framework-gated registration branches', () => {
    expect(frameworkOnly.length).toBeGreaterThan(10);
  });

  it('keeps combined framework-tool description+schema size under budget', () => {
    const total = frameworkOnly.reduce(
      (sum, t) => sum + t.description.length + fullSchemaCharSize(t.schemaShape),
      0,
    );
    expect(
      total,
      `Framework-tool combined chars (${total}) exceed the budget (${FRAMEWORK_COMBINED_CHAR_BUDGET}). ` +
        'Paid in full by any user whose project matches one of these frameworks — see TRA-211.',
    ).toBeLessThanOrEqual(FRAMEWORK_COMBINED_CHAR_BUDGET);
  });

  it('flags any single framework tool description past the shared per-tool ceiling', () => {
    const offenders = frameworkOnly
      .filter((t) => t.description.length > PER_TOOL_DESCRIPTION_CHAR_CEILING)
      .map((t) => `  - ${t.name}: ${t.description.length} chars`);
    expect(offenders.length, offenders.join('\n')).toBe(0);
  });
});

// 4 OTLP-backed tools in advanced.ts behind `config.runtime.enabled` — same
// opt-in-but-fully-paid shape as the topology block (TRA-211).
// RuntimeIntelligence is constructed eagerly at registration time, so this stub
// has to be complete enough for its constructor (store.db + retention/mapping).
const RUNTIME_CTX: Record<string, unknown> = {
  config: {
    runtime: {
      enabled: true,
      retention: { prune_interval: 0 },
      mapping: { fqn_attributes: [], route_patterns: [] },
    },
  },
  store: { db: { prepare: () => ({ run: () => undefined, all: () => [], get: () => undefined }) } },
};

// Measured 2026-08-28 (TRA-211). Headroom rationale as above.
const RUNTIME_COMBINED_CHAR_BUDGET = 4_000;

describe('MCP tool-schema token budget guardrail — runtime-gated tools (TRA-211)', () => {
  const alwaysOn = new Set(captureAllTools().map((t) => t.name));
  const runtimeOnly = captureAllTools(RUNTIME_CTX).filter((t) => !alwaysOn.has(t.name));

  it('activates the runtime-gated registration branch', () => {
    expect(runtimeOnly.map((t) => t.name).sort()).toEqual([
      'get_endpoint_analytics',
      'get_runtime_call_graph',
      'get_runtime_deps',
      'get_runtime_profile',
    ]);
  });

  it('keeps combined runtime-tool description+schema size under budget', () => {
    const total = runtimeOnly.reduce(
      (sum, t) => sum + t.description.length + fullSchemaCharSize(t.schemaShape),
      0,
    );
    expect(
      total,
      `Runtime-tool combined chars (${total}) exceed the budget (${RUNTIME_COMBINED_CHAR_BUDGET}) — see TRA-211.`,
    ).toBeLessThanOrEqual(RUNTIME_COMBINED_CHAR_BUDGET);
  });

  it('flags any single runtime tool description past the shared per-tool ceiling', () => {
    const offenders = runtimeOnly
      .filter((t) => t.description.length > PER_TOOL_DESCRIPTION_CHAR_CEILING)
      .map((t) => `  - ${t.name}: ${t.description.length} chars`);
    expect(offenders.length, offenders.join('\n')).toBe(0);
  });
});

/**
 * TRA-346: `compact_schemas` is a no-op for any tool missing from
 * COMPACT_CORE_PARAMS, and silently strips the wrong things for any entry
 * naming params the tool no longer has. Both decayed unnoticed — coverage sat
 * at 61/141 tools, 27 entries referenced renamed params, and 11 entries hid a
 * mandatory param (`add_decision` lost `content`/`type`, so the tool could not
 * be called at all with the setting on). These guards make each of those fail
 * loudly instead of quietly costing tokens or breaking a tool.
 */
describe('compact_schemas coverage (TRA-346)', () => {
  const alwaysOn = captureAllTools();
  // Union of every registration context, so entries for framework-gated tools
  // (get_request_flow, get_component_tree, ...) are validated too.
  const allCaptured = [
    ...alwaysOn,
    ...captureAllTools(FRAMEWORK_CTX),
    ...captureAllTools(TOPOLOGY_CTX),
    ...captureAllTools(RUNTIME_CTX),
  ];
  const shapeOf = new Map(allCaptured.map((t) => [t.name, t.schemaShape]));

  /** A param the caller must pass: not optional and carrying no default. */
  const isMandatory = (field: z.ZodTypeAny): boolean => !field.safeParse(undefined).success;

  it('covers every always-on tool with more than two params', () => {
    const uncovered = alwaysOn
      .filter((t) => Object.keys(t.schemaShape).length > 2 && !COMPACT_CORE_PARAMS[t.name])
      .map((t) => t.name)
      .sort();
    expect(
      uncovered,
      `Tool(s) with no COMPACT_CORE_PARAMS entry: ${uncovered.join(', ')}. ` +
        'compact_schemas strips nothing for them, which is how coverage decayed to 61/141 (TRA-346). ' +
        'Add an entry listing the core params, or [] if nothing is worth exposing.',
    ).toEqual([]);
  });

  it('never lists a param the tool does not declare', () => {
    const stale: string[] = [];
    for (const [tool, params] of Object.entries(COMPACT_CORE_PARAMS)) {
      const shape = shapeOf.get(tool);
      expect(shape, `COMPACT_CORE_PARAMS entry for unregistered tool "${tool}"`).toBeDefined();
      for (const p of params) {
        if (!(p in (shape as Record<string, unknown>))) stale.push(`${tool}.${p}`);
      }
    }
    expect(
      stale,
      `Stale param name(s): ${stale.join(', ')}. A renamed param turns its entry into a filter that ` +
        'keeps nothing — the tool loses every param under compact_schemas (TRA-346).',
    ).toEqual([]);
  });

  it('never strips a mandatory param', () => {
    const hidden: string[] = [];
    for (const [tool, params] of Object.entries(COMPACT_CORE_PARAMS)) {
      const shape = shapeOf.get(tool);
      if (!shape) continue;
      const kept = new Set(params);
      for (const [name, field] of Object.entries(shape)) {
        if (!kept.has(name) && isMandatory(field)) hidden.push(`${tool}.${name}`);
      }
    }
    expect(
      hidden,
      `Mandatory param(s) hidden by compact_schemas: ${hidden.join(', ')}. ` +
        'The handler still requires them, so the client cannot call the tool at all.',
    ).toEqual([]);
  });

  // Measured 2026-08-29 (TRA-346): 86,407 → 50,421 always-on schema chars, a
  // 41.6% cut, after extending coverage to all 141 tools and repairing the
  // stale entries. Below the documented 40-60% band means coverage decayed
  // again — the docs claim went stale exactly this way once.
  it('delivers the documented 40-60% schema reduction', () => {
    let before = 0;
    let after = 0;
    for (const t of alwaysOn) {
      before += fullSchemaCharSize(t.schemaShape);
      const args: unknown[] = [t.name, t.description, { ...t.schemaShape }, () => undefined];
      applySchemaTransforms(args, {
        descriptionVerbosity: 'full',
        compactSchemas: true,
        descriptionOverrides: {},
        sharedParamOverrides: {},
      });
      after += fullSchemaCharSize(args[2] as Record<string, z.ZodTypeAny>);
    }
    const cut = (before - after) / before;
    expect(
      cut,
      `compact_schemas cuts ${(cut * 100).toFixed(1)}% of always-on schema chars ` +
        `(${before} → ${after}); docs/configuration.md and config.ts promise 40-60%.`,
    ).toBeGreaterThanOrEqual(0.4);
  });
});

describe('MCP tool-schema budget coverage reconciliation (TRA-211)', () => {
  it('every tool registered in source is reachable by some captured-tools pass', () => {
    const sourceNames = scanRegisteredToolNamesFromSource();
    expect(sourceNames.size).toBeGreaterThan(100);

    const reachable = new Set([
      ...captureAllTools().map((t) => t.name),
      ...captureAllTools(TOPOLOGY_CTX).map((t) => t.name),
      ...captureAllTools(FRAMEWORK_CTX).map((t) => t.name),
      ...captureAllTools(RUNTIME_CTX).map((t) => t.name),
    ]);
    const unreachable = [...sourceNames].filter((n) => !reachable.has(n)).sort();
    expect(
      unreachable,
      `Tool(s) registered in source but captured by no budget-test context pass: ${unreachable.join(', ')}. ` +
        'If this is a new conditionally-registered tool, add a context-override pass for its gating flag ' +
        '(see the topology pass above) — do not add it to an allowlist, that recreates the TRA-211 blind spot.',
    ).toEqual([]);
  });
});
