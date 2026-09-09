/**
 * OpenTelemetry E2E integration test.
 * Asserts file -> framework_role mapping and verifies that resolveEdges emits
 * otel_span, otel_span_child, otel_tracer, otel_meter, and otel_instrument
 * edges with metadata linked to enclosing function symbols and file nodes.
 */

import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { OpenTelemetryPlugin } from '../../src/indexer/plugins/integration/tooling/opentelemetry/index.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore } from '../test-utils.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/opentelemetry-app');

function makeConfig(): TraceMcpConfig {
  return {
    root: FIXTURE,
    include: ['src/**/*.ts'],
    exclude: ['node_modules/**'],
    plugins: [],
  };
}

interface EdgeWithMeta {
  targetSymbolId: string;
  meta: Record<string, unknown>;
  srcSymbolId: string | null;
  nodeType: string | undefined;
}

function loadEdges(store: Store, edgeType: string): EdgeWithMeta[] {
  const edges = store.getEdgesByType(edgeType);
  return edges.map((e) => {
    const meta = e.metadata ? JSON.parse(e.metadata) : {};
    const node = store.db
      .prepare('SELECT node_type, ref_id FROM nodes WHERE id = ?')
      .get(e.source_node_id) as { node_type: string; ref_id: number } | undefined;
    let srcSymbolId: string | null = null;
    if (node?.node_type === 'symbol') {
      const s = store.db.prepare('SELECT symbol_id FROM symbols WHERE id = ?').get(node.ref_id) as
        | { symbol_id: string }
        | undefined;
      if (s) srcSymbolId = s.symbol_id;
    }
    return {
      targetSymbolId: e.target_symbol_id,
      meta,
      srcSymbolId,
      nodeType: node?.node_type,
    };
  });
}

describe('OpenTelemetry E2E', () => {
  let store: Store;

  beforeAll(async () => {
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerFrameworkPlugin(new OpenTelemetryPlugin());

    const pipeline = new IndexingPipeline(store, registry, makeConfig(), FIXTURE);
    await pipeline.indexAll();
  });

  it('indexes fixture files', () => {
    const files = store.getAllFiles();
    expect(files.length).toBeGreaterThanOrEqual(2);
    const tsFiles = files.filter((f) => f.path.endsWith('.ts'));
    expect(tsFiles.length).toBe(2);
  });

  it('assigns framework roles correctly', () => {
    const files = store.getAllFiles();
    const agentFile = files.find((f) => f.path.endsWith('agent.ts'));
    const telemetryFile = files.find((f) => f.path.endsWith('telemetry.ts'));

    expect(agentFile?.framework_role).toBe('telemetry_tracing');
    expect(telemetryFile?.framework_role).toBe('telemetry_metrics');
  });

  it('records otel_tracer and otel_meter edges', () => {
    const tracerEdges = loadEdges(store, 'otel_tracer');
    expect(tracerEdges.length).toBeGreaterThan(0);
    const tracer = tracerEdges.find((e) => e.meta.name === 'agent-tracer');
    expect(tracer).toBeDefined();
    expect(tracer?.meta.version).toBe('1.0.0');

    const meterEdges = loadEdges(store, 'otel_meter');
    expect(meterEdges.length).toBeGreaterThan(0);
    const meter = meterEdges.find((e) => e.meta.name === 'agent-meter');
    expect(meter).toBeDefined();
    expect(meter?.meta.version).toBe('1.0.0');
  });

  it('records otel_instrument metric edges', () => {
    const instrumentEdges = loadEdges(store, 'otel_instrument');
    expect(instrumentEdges.length).toBeGreaterThan(0);
    const counter = instrumentEdges.find((e) => e.meta.name === 'agent.steps.completed');
    expect(counter).toBeDefined();
    expect(counter?.meta.type).toBe('counter');
  });

  it('records otel_span edges and links them to enclosing functions', () => {
    const spanEdges = loadEdges(store, 'otel_span');
    expect(spanEdges.length).toBe(2);

    const stepSpan = spanEdges.find((e) => e.meta.name === 'agent.step');
    expect(stepSpan).toBeDefined();
    expect(stepSpan?.meta.hasErrorRecording).toBe(true);
    expect(stepSpan?.meta.hasStatus).toBe(true);
    // Enclosing symbol should be executeStep
    expect(stepSpan?.srcSymbolId).toContain('executeStep');

    const toolSpan = spanEdges.find((e) => e.meta.name === 'agent.tool_call');
    expect(toolSpan).toBeDefined();
    expect(toolSpan?.meta.parentSpan).toBe('agent.step');
    expect(toolSpan?.meta.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'tool.invoked' })]),
    );
    expect(toolSpan?.srcSymbolId).toContain('executeStep');
  });

  it('records otel_span_child edges representing span execution hierarchy', () => {
    const childEdges = loadEdges(store, 'otel_span_child');
    expect(childEdges.length).toBe(1);
    expect(childEdges[0].meta.childSpan).toBe('agent.tool_call');
    expect(childEdges[0].meta.parentSpan).toBe('agent.step');
  });
});
