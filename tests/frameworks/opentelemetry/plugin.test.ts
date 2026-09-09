import { describe, expect, it } from 'vitest';
import {
  OpenTelemetryPlugin,
  extractOtelEntities,
} from '../../../src/indexer/plugins/integration/tooling/opentelemetry/index.js';
import type { ProjectContext, RawEdge, ResolveContext } from '../../../src/plugin-api/types.js';

function makeCtx(
  deps: Record<string, string>,
  devDeps: Record<string, string> = {},
): ProjectContext {
  return {
    rootPath: '/tmp/test-project',
    packageJson: { dependencies: deps, devDependencies: devDeps },
    configFiles: [],
    detectedVersions: [],
    allDependencies: [],
  };
}

function extract(
  plugin: OpenTelemetryPlugin,
  code: string,
  filePath = 'src/tracer.ts',
  lang = 'typescript',
) {
  const r = plugin.extractNodes(filePath, Buffer.from(code), lang);
  if (r.isErr()) throw new Error(JSON.stringify(r._unsafeUnwrapErr()));
  return r._unsafeUnwrap();
}

describe('OpenTelemetryPlugin', () => {
  const plugin = new OpenTelemetryPlugin();

  describe('manifest & schema', () => {
    it('has expected manifest properties', () => {
      expect(plugin.manifest.name).toBe('opentelemetry');
      expect(plugin.manifest.category).toBe('tooling');
      expect(plugin.manifest.priority).toBe(35);
    });

    it('registers schema edge types', () => {
      const schema = plugin.registerSchema();
      const edgeNames = schema.edgeTypes?.map((e) => e.name);
      expect(edgeNames).toContain('otel_span');
      expect(edgeNames).toContain('otel_span_child');
      expect(edgeNames).toContain('otel_tracer');
      expect(edgeNames).toContain('otel_meter');
      expect(edgeNames).toContain('otel_instrument');
    });
  });

  describe('detect()', () => {
    it('detects @opentelemetry/api in dependencies', () => {
      expect(plugin.detect(makeCtx({ '@opentelemetry/api': '^1.9.1' }))).toBe(true);
    });

    it('detects @opentelemetry/sdk-node in devDependencies', () => {
      expect(plugin.detect(makeCtx({}, { '@opentelemetry/sdk-node': '^0.51.0' }))).toBe(true);
    });

    it('detects opentelemetry-api alias', () => {
      expect(plugin.detect(makeCtx({ 'opentelemetry-api': '^1.0.0' }))).toBe(true);
    });

    it('returns false when no opentelemetry package is listed', () => {
      expect(plugin.detect(makeCtx({ express: '^4.18.0', pino: '^9.0.0' }))).toBe(false);
    });
  });

  describe('extractNodes() — roles & entities', () => {
    it('extracts Tracer initialization and assigns telemetry_config role', () => {
      const code = `
        import { trace } from '@opentelemetry/api';
        export const tracer = trace.getTracer('agent-service', '1.2.0');
      `;
      const res = extract(plugin, code);
      expect(res.frameworkRole).toBe('telemetry_config');

      const tracerEdge = res.edges?.find((e) => e.edgeType === 'otel_tracer');
      expect(tracerEdge).toBeDefined();
      expect(tracerEdge?.metadata?.name).toBe('agent-service');
      expect(tracerEdge?.metadata?.version).toBe('1.2.0');
      expect(tracerEdge?.targetSymbolId).toBe('otel-tracer::agent-service');
    });

    it('extracts Meter and instruments and assigns telemetry_metrics role', () => {
      const code = `
        import { metrics } from '@opentelemetry/api';
        export const meter = metrics.getMeter('agentic-metrics', '0.5.0');
        export const stepCounter = meter.createCounter('agent_steps_total', {
          description: 'Total number of agent reasoning steps',
          unit: 'steps'
        });
        export const latencyHistogram = meter.createHistogram('llm_latency_ms', {
          description: 'LLM tool call latency',
          unit: 'ms'
        });
      `;
      const res = extract(plugin, code);
      expect(res.frameworkRole).toBe('telemetry_metrics');

      const meterEdge = res.edges?.find((e) => e.edgeType === 'otel_meter');
      expect(meterEdge).toBeDefined();
      expect(meterEdge?.metadata?.name).toBe('agentic-metrics');
      expect(meterEdge?.metadata?.version).toBe('0.5.0');

      const counterEdge = res.edges?.find((e) => e.metadata?.name === 'agent_steps_total');
      expect(counterEdge).toBeDefined();
      expect(counterEdge?.edgeType === 'otel_instrument');
      expect(counterEdge?.metadata?.instrument).toBe('counter');
      expect(counterEdge?.metadata?.unit).toBe('steps');

      const histEdge = res.edges?.find((e) => e.metadata?.name === 'llm_latency_ms');
      expect(histEdge).toBeDefined();
      expect(histEdge?.metadata?.instrument).toBe('histogram');
      expect(histEdge?.metadata?.unit).toBe('ms');
    });

    it('extracts active spans with attributes and events, tagging telemetry_tracing', () => {
      const code = `
        import { trace, SpanStatusCode, SpanKind } from '@opentelemetry/api';
        const tracer = trace.getTracer('workflow-tracer');

        export async function executeAgentTurn(input: string) {
          return tracer.startActiveSpan(
            'agent.turn',
            { kind: SpanKind.INTERNAL, attributes: { 'gen_ai.system': 'anthropic', 'gen_ai.request.model': 'claude-3-5-sonnet' } },
            async (span) => {
              span.setAttribute('agent.input_length', 42);
              span.setAttribute('is_replay', false);
              span.addEvent('prompt_dispatched', { 'prompt.tokens': 120 });

              try {
                const res = await fetch('/llm');
                span.addEvent('response_received');
                return res;
              } catch (err) {
                span.recordException(err as Error);
                span.setStatus({ code: SpanStatusCode.ERROR });
                throw err;
              } finally {
                span.end();
              }
            }
          );
        }
      `;
      const res = extract(plugin, code);
      expect(res.frameworkRole).toBe('telemetry_tracing');

      const spanEdge = res.edges?.find(
        (e) => e.edgeType === 'otel_span' && e.metadata?.name === 'agent.turn',
      );
      expect(spanEdge).toBeDefined();
      expect(spanEdge?.targetSymbolId).toBe('otel-span::agent.turn');
      expect(spanEdge?.metadata?.kind).toBe('active');
      expect(spanEdge?.metadata?.isAsync).toBe(true);
      expect(spanEdge?.metadata?.spanKind).toBe('INTERNAL');
      expect(spanEdge?.metadata?.attributes).toMatchObject({
        'gen_ai.system': 'anthropic',
        'gen_ai.request.model': 'claude-3-5-sonnet',
        'agent.input_length': 42,
        is_replay: false,
      });

      const events = spanEdge?.metadata?.events as Array<{ name: string }>;
      expect(events.map((ev) => ev.name)).toContain('prompt_dispatched');
      expect(events.map((ev) => ev.name)).toContain('response_received');

      expect(spanEdge?.metadata?.hasErrorRecording).toBe(true);
      expect(spanEdge?.metadata?.hasStatus).toBe(true);
    });

    it('extracts manual spans via tracer.startSpan', () => {
      const code = `
        import { trace } from '@opentelemetry/api';
        const tracer = trace.getTracer('tools');

        export function runTool(toolName: string) {
          const span = tracer.startSpan('mcp.tool_call');
          span.setAttribute('tool.name', 'grep');
          span.end();
        }
      `;
      const res = extract(plugin, code);
      expect(res.frameworkRole).toBe('telemetry_tracing');

      const manualSpan = res.edges?.find((e) => e.metadata?.name === 'mcp.tool_call');
      expect(manualSpan).toBeDefined();
      expect(manualSpan?.metadata?.kind).toBe('manual');
      expect(manualSpan?.metadata?.attributes).toMatchObject({
        'tool.name': 'grep',
      });
    });

    it('detects nested parent-child span boundaries and emits otel_span_child edge', () => {
      const code = `
        import { trace } from '@opentelemetry/api';
        const tracer = trace.getTracer('agent');

        export async function orchestrate() {
          return tracer.startActiveSpan('agent.orchestration', async (parentSpan) => {
            await tracer.startActiveSpan('agent.sub_task_1', async (child1) => {
              child1.setAttribute('task.index', 1);
              child1.end();
            });

            await tracer.startActiveSpan('agent.sub_task_2', async (child2) => {
              child2.setAttribute('task.index', 2);
              child2.end();
            });

            parentSpan.end();
          });
        }
      `;
      const res = extract(plugin, code);
      const spans = res.edges?.filter((e) => e.edgeType === 'otel_span');
      expect(spans).toHaveLength(3);

      const parent = spans?.find((s) => s.metadata?.name === 'agent.orchestration');
      const child1 = spans?.find((s) => s.metadata?.name === 'agent.sub_task_1');
      const child2 = spans?.find((s) => s.metadata?.name === 'agent.sub_task_2');

      expect(parent?.metadata?.parentSpan).toBeUndefined();
      expect(child1?.metadata?.parentSpan).toBe('agent.orchestration');
      expect(child2?.metadata?.parentSpan).toBe('agent.orchestration');

      const childEdges = res.edges?.filter((e) => e.edgeType === 'otel_span_child');
      expect(childEdges).toHaveLength(2);
      expect(childEdges?.map((e) => e.metadata?.childSpan)).toContain('agent.sub_task_1');
      expect(childEdges?.map((e) => e.metadata?.childSpan)).toContain('agent.sub_task_2');
    });

    it('assigns telemetry_usage when OpenTelemetry is imported without direct span calls', () => {
      const code = `
        import type { Span, Tracer } from '@opentelemetry/api';
        export interface TracedService {
          tracer: Tracer;
        }
      `;
      const res = extract(plugin, code);
      expect(res.frameworkRole).toBe('telemetry_usage');
    });

    it('returns empty result for non-telemetry files', () => {
      const code = `
        export function add(a: number, b: number) {
          return a + b;
        }
      `;
      const res = extract(plugin, code);
      expect(res.frameworkRole).toBeUndefined();
      expect(res.edges).toHaveLength(0);
    });
  });

  describe('resolveEdges() — symbol-level linkage and execution topology', () => {
    it('links spans to enclosing functions and top-level tracers to file nodes', () => {
      const code = `import { trace } from '@opentelemetry/api';
export const tracer = trace.getTracer('agent-tracer', '1.0.0');

export async function processStep() {
  return tracer.startActiveSpan('step.execute', async (span) => {
    span.setAttribute('step.id', 'step-123');
    span.end();
  });
}
`;
      const files = [{ id: 10, path: 'src/agent.ts', language: 'typescript' }];
      const symbols = [
        {
          id: 101,
          symbolId: 'src/agent.ts::tracer#variable',
          name: 'tracer',
          kind: 'variable',
          lineStart: 2,
          lineEnd: 2,
        },
        {
          id: 102,
          symbolId: 'src/agent.ts::processStep#function',
          name: 'processStep',
          kind: 'function',
          lineStart: 4,
          lineEnd: 9,
        },
      ];

      const ctx: ResolveContext = {
        rootPath: '/tmp/test-project',
        getAllFiles: () => files,
        getSymbolsByFile: (fileId) => (fileId === 10 ? symbols : []),
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 0,
        readFile: (p) => (p === 'src/agent.ts' ? code : undefined),
      };

      const edgesResult = plugin.resolveEdges(ctx);
      expect(edgesResult.isOk()).toBe(true);
      const edges = edgesResult._unsafeUnwrap();

      // Tracer edge anchored to tracer variable symbol
      const tracerEdge = edges.find((e) => e.edgeType === 'otel_tracer');
      expect(tracerEdge).toBeDefined();
      expect(tracerEdge?.sourceNodeType).toBe('symbol');
      expect(tracerEdge?.sourceRefId).toBe(101);
      expect(tracerEdge?.targetSymbolId).toBe('otel-tracer::agent-tracer');

      // Span edge anchored to processStep function symbol
      const spanEdge = edges.find((e) => e.edgeType === 'otel_span');
      expect(spanEdge).toBeDefined();
      expect(spanEdge?.sourceNodeType).toBe('symbol');
      expect(spanEdge?.sourceRefId).toBe(102);
      expect(spanEdge?.sourceSymbolId).toBe('src/agent.ts::processStep#function');
      expect(spanEdge?.targetSymbolId).toBe('otel-span::step.execute');
      expect(spanEdge?.metadata?.symbolName).toBe('processStep');
      expect(spanEdge?.metadata?.attributes).toMatchObject({ 'step.id': 'step-123' });
    });
  });
});
