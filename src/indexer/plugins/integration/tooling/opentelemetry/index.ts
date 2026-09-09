/**
 * OpenTelemetryPlugin — detects @opentelemetry/api and related packages,
 * extracts Tracer and Meter initializations, metric instruments, and span boundaries
 * with semantic attributes and events.
 *
 * Pass 1 (extractNodes): tags file roles (telemetry_tracing, telemetry_metrics, telemetry_config, telemetry_usage).
 * Pass 2 (resolveEdges): links tracers, meters, instruments, and spans to enclosing symbols
 *   (or file nodes) and emits parent-child span execution hierarchy edges.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ok, type TraceMcpResult } from '../../../../../errors.js';
import type {
  FileParseResult,
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  RawEdge,
  ResolveContext,
} from '../../../../../plugin-api/types.js';
import { findEnclosingSymbol, lineOfIndex } from '../../_shared/regex-edges.js';

export const OTEL_PACKAGES = [
  '@opentelemetry/api',
  '@opentelemetry/sdk-node',
  '@opentelemetry/sdk-trace-base',
  '@opentelemetry/sdk-trace-node',
  '@opentelemetry/sdk-trace-web',
  '@opentelemetry/semantic-conventions',
  '@opentelemetry/exporter-trace-otlp-http',
  '@opentelemetry/exporter-trace-otlp-grpc',
  '@opentelemetry/auto-instrumentations-node',
  'opentelemetry-api',
  'opentelemetry-sdk',
];

const OTEL_IMPORT_RE = /(?:import|require)\s*(?:\(|{)?\s*.*['"](?:@opentelemetry\/|opentelemetry-)/;

// Tracer initialization: trace.getTracer('name', 'version')
const TRACER_GET_RE =
  /(?:(?:trace|otel|opentelemetry|api|provider)\s*\.\s*)?getTracer\s*\(\s*['"`]([^'"`]+)['"`](?:\s*,\s*['"`]([^'"`]+)['"`])?\s*\)/g;

// Meter initialization: metrics.getMeter('name', 'version')
const METER_GET_RE =
  /(?:(?:metrics|otel|opentelemetry|api|meterProvider)\s*\.\s*)?getMeter\s*\(\s*['"`]([^'"`]+)['"`](?:\s*,\s*['"`]([^'"`]+)['"`])?\s*\)/g;

// Metric instruments: meter.createCounter('name', ...)
const INSTRUMENT_CREATE_RE =
  /\.(createCounter|createHistogram|createUpDownCounter|createObservableGauge|createObservableCounter|createObservableUpDownCounter)\s*\(\s*['"`]([^'"`]+)['"`]/g;

// Span starts: tracer.startActiveSpan('name', ...) or tracer.startSpan('name', ...)
const SPAN_START_RE =
  /\b([a-zA-Z0-9_$]+)?\s*\.\s*(startActiveSpan|startSpan)\s*\(\s*['"`]([^'"`]+)['"`]/g;

// Options attributes: attributes: { 'key': 'val', ... }
const ATTRIBUTES_BLOCK_RE = /attributes\s*:\s*\{([^}]+)\}/;

// Attribute assignments: span.setAttribute('key', 'val')
const SET_ATTRIBUTE_RE =
  /\b[a-zA-Z0-9_$]+\s*\.\s*setAttribute\s*\(\s*['"`]([a-zA-Z0-9_.-]+)['"`]\s*,\s*(?:['"`]([^'"`\n]*)['"`]|(-?\d+(?:\.\d+)?)|(true|false))/g;

// Batch attribute assignments: span.setAttributes({ 'key': 'val' })
const SET_ATTRIBUTES_RE = /\b[a-zA-Z0-9_$]+\s*\.\s*setAttributes\s*\(\s*\{([^}]+)\}\s*\)/g;

// Span events: span.addEvent('name', ...)
const ADD_EVENT_RE =
  /\b[a-zA-Z0-9_$]+\s*\.\s*addEvent\s*\(\s*['"`]([^'"`\n]+)['"`](?:\s*,\s*\{([^}]*)\})?\s*\)/g;

// Exception and status recording
const RECORD_EXCEPTION_RE = /\b[a-zA-Z0-9_$]+\s*\.\s*recordException\s*\(/;
const SET_STATUS_RE = /\b[a-zA-Z0-9_$]+\s*\.\s*setStatus\s*\(/;

export interface OtelTracerInfo {
  name: string;
  version?: string;
  line: number;
  byteIdx: number;
}

export interface OtelMeterInfo {
  name: string;
  version?: string;
  line: number;
  byteIdx: number;
}

export interface OtelInstrumentInfo {
  instrument: string;
  name: string;
  description?: string;
  unit?: string;
  line: number;
  byteIdx: number;
}

export interface OtelSpanInfo {
  name: string;
  kind: 'active' | 'manual';
  isAsync: boolean;
  tracerVar?: string;
  startIdx: number;
  endIdx: number;
  line: number;
  endLine: number;
  parentSpan?: string;
  spanKind?: string;
  attributes: Record<string, string | number | boolean>;
  events: Array<{
    name: string;
    line: number;
    attributes?: Record<string, string | number | boolean>;
  }>;
  hasErrorRecording: boolean;
  hasStatus: boolean;
}

/**
 * Scan forward to find matching brace, skipping string literals and comments.
 */
function findMatchingBrace(source: string, openIdx: number): number {
  let depth = 0;
  let inString: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = openIdx; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inString) {
      if (ch === '\\') {
        i++; // skip escaped char
        continue;
      }
      if (ch === inString) {
        inString = null;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }

    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
}

/**
 * Extract static key-value attributes from an object literal body string.
 */
function extractAttributesFromBlock(
  blockContent: string,
): Record<string, string | number | boolean> {
  const attrs: Record<string, string | number | boolean> = {};
  const kvRe =
    /(?:['"`]([a-zA-Z0-9_.-]+)['"`]|([a-zA-Z0-9_.-]+))\s*:\s*(?:['"`]([^'"`\n]*)['"`]|(-?\d+(?:\.\d+)?)|(true|false))/g;

  let m: RegExpExecArray | null;
  while ((m = kvRe.exec(blockContent)) !== null) {
    const key = m[1] ?? m[2];
    if (!key) continue;
    if (m[3] !== undefined) {
      attrs[key] = m[3];
    } else if (m[4] !== undefined) {
      attrs[key] = Number(m[4]);
    } else if (m[5] !== undefined) {
      attrs[key] = m[5] === 'true';
    }
  }

  return attrs;
}

/**
 * Extract all OpenTelemetry entities from source text.
 */
export function extractOtelEntities(
  source: string,
  _filePath = '',
): {
  tracers: OtelTracerInfo[];
  meters: OtelMeterInfo[];
  instruments: OtelInstrumentInfo[];
  spans: OtelSpanInfo[];
} {
  const tracers: OtelTracerInfo[] = [];
  const meters: OtelMeterInfo[] = [];
  const instruments: OtelInstrumentInfo[] = [];
  const spans: OtelSpanInfo[] = [];

  // 1. Tracers
  TRACER_GET_RE.lastIndex = 0;
  let tm: RegExpExecArray | null;
  while ((tm = TRACER_GET_RE.exec(source)) !== null) {
    tracers.push({
      name: tm[1],
      version: tm[2] || undefined,
      line: lineOfIndex(source, tm.index),
      byteIdx: tm.index,
    });
  }

  // 2. Meters
  METER_GET_RE.lastIndex = 0;
  let mm: RegExpExecArray | null;
  while ((mm = METER_GET_RE.exec(source)) !== null) {
    meters.push({
      name: mm[1],
      version: mm[2] || undefined,
      line: lineOfIndex(source, mm.index),
      byteIdx: mm.index,
    });
  }

  // 3. Metric Instruments
  INSTRUMENT_CREATE_RE.lastIndex = 0;
  let im: RegExpExecArray | null;
  while ((im = INSTRUMENT_CREATE_RE.exec(source)) !== null) {
    const fullMethod = im[1];
    const name = im[2];
    const line = lineOfIndex(source, im.index);

    // Look ahead in options argument for description/unit
    const lookahead = source.slice(im.index, im.index + 400);
    const descMatch = lookahead.match(/description\s*:\s*['"`]([^'"`]+)['"`]/);
    const unitMatch = lookahead.match(/unit\s*:\s*['"`]([^'"`]+)['"`]/);

    const instrumentType = fullMethod
      .replace(/^create/, '')
      .replace(/^[A-Z]/, (c) => c.toLowerCase());

    instruments.push({
      instrument: instrumentType,
      name,
      description: descMatch ? descMatch[1] : undefined,
      unit: unitMatch ? unitMatch[1] : undefined,
      line,
      byteIdx: im.index,
    });
  }

  // 4. Spans
  SPAN_START_RE.lastIndex = 0;
  let sm: RegExpExecArray | null;
  while ((sm = SPAN_START_RE.exec(source)) !== null) {
    const tracerVar = sm[1] || undefined;
    const method = sm[2];
    const name = sm[3];
    const startIdx = sm.index;
    const line = lineOfIndex(source, startIdx);

    const isStartActive = method === 'startActiveSpan';
    let endIdx = startIdx;
    let endLine = line;
    let isAsync = false;
    let spanKind: string | undefined;
    const attributes: Record<string, string | number | boolean> = {};
    const events: OtelSpanInfo['events'] = [];
    let hasErrorRecording = false;
    let hasStatus = false;

    // Check for SpanKind in lookahead (e.g. kind: SpanKind.SERVER or SpanKind.INTERNAL)
    const optionsWindow = source.slice(startIdx, startIdx + 500);
    const kindMatch = optionsWindow.match(/kind\s*:\s*(?:SpanKind\.)?([A-Z_]+)/);
    if (kindMatch) spanKind = kindMatch[1];

    // Check options attributes: { attributes: { ... } }
    const attrBlockMatch = optionsWindow.match(ATTRIBUTES_BLOCK_RE);
    if (attrBlockMatch) {
      Object.assign(attributes, extractAttributesFromBlock(attrBlockMatch[1]));
    }

    if (isStartActive) {
      // Find the callback arrow or function: => { or function(...) {
      const windowAfter = source.slice(startIdx, startIdx + 1200);
      const asyncMatch = windowAfter.match(
        /async\s*(?:\([^)]*\)|[a-zA-Z0-9_$]+)\s*=>|\basync\s+function/,
      );
      if (asyncMatch && asyncMatch.index! < 250) {
        isAsync = true;
      }

      // Find opening brace of callback
      const callbackArrowIdx = source.indexOf('=>', startIdx);
      const callbackFnIdx = source.indexOf('function', startIdx);
      let braceSearchStart = startIdx;
      if (callbackArrowIdx !== -1 && (callbackFnIdx === -1 || callbackArrowIdx < callbackFnIdx)) {
        braceSearchStart = callbackArrowIdx + 2;
      } else if (callbackFnIdx !== -1) {
        braceSearchStart = callbackFnIdx + 8;
      }

      const openBrace = source.indexOf('{', braceSearchStart);
      if (openBrace !== -1 && openBrace - startIdx < 600) {
        const closeBrace = findMatchingBrace(source, openBrace);
        if (closeBrace !== -1) {
          endIdx = closeBrace;
          endLine = lineOfIndex(source, endIdx);
        }
      }
    } else {
      // Manual span: `const span = tracer.startSpan(...)`
      // Search forward for `span.end()` up to 2000 chars
      const lookahead = source.slice(startIdx, startIdx + 2000);
      const endCallMatch = lookahead.match(/\b([a-zA-Z0-9_$]+)\.end\s*\(\s*\)/);
      if (endCallMatch && endCallMatch.index !== undefined) {
        endIdx = startIdx + endCallMatch.index + endCallMatch[0].length;
        endLine = lineOfIndex(source, endIdx);
      }
    }

    // Inspect the span body for calls: setAttribute, setAttributes, addEvent, recordException, setStatus
    const spanBody = source.slice(startIdx, Math.max(endIdx, startIdx + 200));

    // setAttribute calls
    SET_ATTRIBUTE_RE.lastIndex = 0;
    let am: RegExpExecArray | null;
    while ((am = SET_ATTRIBUTE_RE.exec(spanBody)) !== null) {
      const k = am[1];
      if (am[2] !== undefined) {
        attributes[k] = am[2];
      } else if (am[3] !== undefined) {
        attributes[k] = Number(am[3]);
      } else if (am[4] !== undefined) {
        attributes[k] = am[4] === 'true';
      }
    }

    // setAttributes calls
    SET_ATTRIBUTES_RE.lastIndex = 0;
    let sam: RegExpExecArray | null;
    while ((sam = SET_ATTRIBUTES_RE.exec(spanBody)) !== null) {
      Object.assign(attributes, extractAttributesFromBlock(sam[1]));
    }

    // addEvent calls
    ADD_EVENT_RE.lastIndex = 0;
    let em: RegExpExecArray | null;
    while ((em = ADD_EVENT_RE.exec(spanBody)) !== null) {
      const eventName = em[1];
      const eventLine = lineOfIndex(source, startIdx + em.index);
      const eventAttrs = em[2] ? extractAttributesFromBlock(em[2]) : undefined;
      events.push({
        name: eventName,
        line: eventLine,
        attributes: eventAttrs,
      });
    }

    if (RECORD_EXCEPTION_RE.test(spanBody)) hasErrorRecording = true;
    if (SET_STATUS_RE.test(spanBody)) hasStatus = true;

    spans.push({
      name,
      kind: isStartActive ? 'active' : 'manual',
      isAsync,
      tracerVar,
      startIdx,
      endIdx,
      line,
      endLine,
      spanKind,
      attributes,
      events,
      hasErrorRecording,
      hasStatus,
    });
  }

  // 5. Determine Parent-Child nesting among spans in the file
  for (let i = 0; i < spans.length; i++) {
    const child = spans[i];
    let parentCandidate: OtelSpanInfo | undefined;
    let smallestParentSpanSize = Number.POSITIVE_INFINITY;

    for (let j = 0; j < spans.length; j++) {
      if (i === j) continue;
      const potentialParent = spans[j];
      if (child.startIdx > potentialParent.startIdx && child.startIdx < potentialParent.endIdx) {
        const size = potentialParent.endIdx - potentialParent.startIdx;
        if (size < smallestParentSpanSize) {
          smallestParentSpanSize = size;
          parentCandidate = potentialParent;
        }
      }
    }

    if (parentCandidate) {
      child.parentSpan = parentCandidate.name;
    }
  }

  return { tracers, meters, instruments, spans };
}

export class OpenTelemetryPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'opentelemetry',
    version: '1.0.0',
    priority: 35,
    category: 'tooling',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    if (ctx.packageJson) {
      const deps = {
        ...(ctx.packageJson.dependencies as Record<string, string> | undefined),
        ...(ctx.packageJson.devDependencies as Record<string, string> | undefined),
      };
      for (const pkg of OTEL_PACKAGES) {
        if (pkg in deps) return true;
      }
    }

    if (ctx.allDependencies) {
      for (const dep of ctx.allDependencies) {
        if (OTEL_PACKAGES.includes(dep.name)) return true;
      }
    }

    try {
      const pkgPath = path.join(ctx.rootPath, 'package.json');
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);
      const deps = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
      };
      for (const p of OTEL_PACKAGES) {
        if (p in deps) return true;
      }
    } catch {
      return false;
    }

    return false;
  }

  registerSchema() {
    return {
      edgeTypes: [
        {
          name: 'otel_span',
          category: 'telemetry',
          description: 'OpenTelemetry span boundary (startActiveSpan / startSpan)',
        },
        {
          name: 'otel_span_child',
          category: 'telemetry',
          description: 'Nested OpenTelemetry child span execution link',
        },
        {
          name: 'otel_tracer',
          category: 'telemetry',
          description: 'OpenTelemetry tracer initialization (trace.getTracer)',
        },
        {
          name: 'otel_meter',
          category: 'telemetry',
          description: 'OpenTelemetry meter initialization (metrics.getMeter)',
        },
        {
          name: 'otel_instrument',
          category: 'telemetry',
          description: 'OpenTelemetry metric instrument (createCounter, createHistogram, etc.)',
        },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (!['typescript', 'javascript', 'typescriptreact', 'javascriptreact'].includes(language)) {
      return ok({ status: 'ok', symbols: [], edges: [] });
    }

    const source = content.toString('utf-8');
    const hasImport = OTEL_IMPORT_RE.test(source);
    const hasTracerSignal = source.includes('getTracer');
    const hasMeterSignal = source.includes('getMeter');
    const hasSpanSignal = source.includes('startActiveSpan') || source.includes('startSpan');

    if (!hasImport && !hasTracerSignal && !hasMeterSignal && !hasSpanSignal) {
      return ok({ status: 'ok', symbols: [], edges: [] });
    }

    const { tracers, meters, instruments, spans } = extractOtelEntities(source, filePath);

    const result: FileParseResult = {
      status: 'ok',
      symbols: [],
      edges: [],
      metadata: { tracers, meters, instruments, spans },
    };

    // Assign framework role based on primary telemetry pattern
    if (spans.length > 0) {
      result.frameworkRole = 'telemetry_tracing';
    } else if (instruments.length > 0) {
      result.frameworkRole = 'telemetry_metrics';
    } else if (tracers.length > 0 || meters.length > 0) {
      result.frameworkRole = 'telemetry_config';
    } else if (hasImport) {
      result.frameworkRole = 'telemetry_usage';
    }

    for (const tracer of tracers) {
      result.symbols.push({
        name: tracer.name,
        kind: 'variable',
        symbolId: `otel-tracer::${tracer.name}`,
        lineStart: tracer.line,
        lineEnd: tracer.line,
        byteStart: tracer.byteIdx,
        byteEnd: tracer.byteIdx + tracer.name.length,
        signature: `trace.getTracer('${tracer.name}')`,
        metadata: {
          telemetry: 'tracer',
          version: tracer.version,
        },
      });
    }

    for (const meter of meters) {
      result.symbols.push({
        name: meter.name,
        kind: 'variable',
        symbolId: `otel-meter::${meter.name}`,
        lineStart: meter.line,
        lineEnd: meter.line,
        byteStart: meter.byteIdx,
        byteEnd: meter.byteIdx + meter.name.length,
        signature: `metrics.getMeter('${meter.name}')`,
        metadata: {
          telemetry: 'meter',
          version: meter.version,
        },
      });
    }

    for (const inst of instruments) {
      result.symbols.push({
        name: inst.name,
        kind: 'variable',
        symbolId: `otel-instrument::${inst.name}`,
        lineStart: inst.line,
        lineEnd: inst.line,
        byteStart: inst.byteIdx,
        byteEnd: inst.byteIdx + inst.name.length,
        signature: `meter.create${inst.instrument.charAt(0).toUpperCase() + inst.instrument.slice(1)}('${inst.name}')`,
        metadata: {
          telemetry: 'instrument',
          instrument: inst.instrument,
          type: inst.instrument,
          description: inst.description,
          unit: inst.unit,
        },
      });
    }

    for (const span of spans) {
      result.symbols.push({
        name: span.name,
        kind: 'function',
        symbolId: `otel-span::${span.name}`,
        lineStart: span.line,
        lineEnd: span.endLine,
        byteStart: span.startIdx,
        byteEnd: span.endIdx,
        signature: `${span.tracerVar ? span.tracerVar + '.' : ''}${span.kind === 'active' ? 'startActiveSpan' : 'startSpan'}('${span.name}')`,
        metadata: {
          telemetry: 'span',
          kind: span.kind,
          spanKind: span.spanKind,
          parentSpan: span.parentSpan,
          hasErrorRecording: span.hasErrorRecording,
          hasStatus: span.hasStatus,
        },
      });
    }

    // Populate file-level edges for unit test assertions and inspection
    for (const span of spans) {
      result.edges!.push({
        edgeType: 'otel_span',
        targetSymbolId: `otel-span::${span.name}`,
        metadata: {
          name: span.name,
          kind: span.kind,
          isAsync: span.isAsync,
          tracer: span.tracerVar,
          parentSpan: span.parentSpan,
          spanKind: span.spanKind,
          attributes: span.attributes,
          events: span.events,
          hasErrorRecording: span.hasErrorRecording,
          hasStatus: span.hasStatus,
          line: span.line,
          endLine: span.endLine,
          filePath,
        },
        resolution: 'text_matched',
      });

      if (span.parentSpan) {
        result.edges!.push({
          edgeType: 'otel_span_child',
          targetSymbolId: `otel-span::${span.name}`,
          metadata: {
            childSpan: span.name,
            parentSpan: span.parentSpan,
            line: span.line,
            filePath,
          },
          resolution: 'text_matched',
        });
      }
    }

    for (const tracer of tracers) {
      result.edges!.push({
        edgeType: 'otel_tracer',
        targetSymbolId: `otel-tracer::${tracer.name}`,
        metadata: {
          name: tracer.name,
          version: tracer.version,
          line: tracer.line,
          filePath,
        },
        resolution: 'text_matched',
      });
    }

    for (const meter of meters) {
      result.edges!.push({
        edgeType: 'otel_meter',
        targetSymbolId: `otel-meter::${meter.name}`,
        metadata: {
          name: meter.name,
          version: meter.version,
          line: meter.line,
          filePath,
        },
        resolution: 'text_matched',
      });
    }

    for (const inst of instruments) {
      result.edges!.push({
        edgeType: 'otel_instrument',
        targetSymbolId: `otel-instrument::${inst.name}`,
        metadata: {
          instrument: inst.instrument,
          type: inst.instrument,
          name: inst.name,
          description: inst.description,
          unit: inst.unit,
          line: inst.line,
          filePath,
        },
        resolution: 'text_matched',
      });
    }

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];

    for (const file of ctx.getAllFiles()) {
      if (
        file.language !== 'typescript' &&
        file.language !== 'javascript' &&
        file.language !== 'typescriptreact' &&
        file.language !== 'javascriptreact'
      ) {
        continue;
      }

      const source = ctx.readFile(file.path);
      if (!source) continue;

      const hasImport = OTEL_IMPORT_RE.test(source);
      const hasTracerSignal = source.includes('getTracer');
      const hasMeterSignal = source.includes('getMeter');
      const hasSpanSignal = source.includes('startActiveSpan') || source.includes('startSpan');

      if (!hasImport && !hasTracerSignal && !hasMeterSignal && !hasSpanSignal) {
        continue;
      }

      const allSymbols = ctx.getSymbolsByFile(file.id);
      const symbols = allSymbols.filter((s) => !s.symbolId?.startsWith('otel-'));
      const { tracers, meters, instruments, spans } = extractOtelEntities(source, file.path);

      // 1. Tracer initialization edges
      for (const tracer of tracers) {
        const encl = findEnclosingSymbol(symbols, tracer.line);
        edges.push({
          edgeType: 'otel_tracer',
          sourceNodeType: encl ? 'symbol' : 'file',
          sourceRefId: encl ? encl.id : file.id,
          sourceSymbolId: encl?.symbolId,
          targetSymbolId: `otel-tracer::${tracer.name}`,
          metadata: {
            name: tracer.name,
            version: tracer.version,
            line: tracer.line,
            filePath: file.path,
            symbolName: encl?.name,
          },
          resolution: 'text_matched',
        });
      }

      // 2. Meter initialization edges
      for (const meter of meters) {
        const encl = findEnclosingSymbol(symbols, meter.line);
        edges.push({
          edgeType: 'otel_meter',
          sourceNodeType: encl ? 'symbol' : 'file',
          sourceRefId: encl ? encl.id : file.id,
          sourceSymbolId: encl?.symbolId,
          targetSymbolId: `otel-meter::${meter.name}`,
          metadata: {
            name: meter.name,
            version: meter.version,
            line: meter.line,
            filePath: file.path,
            symbolName: encl?.name,
          },
          resolution: 'text_matched',
        });
      }

      // 3. Metric instrument edges
      for (const inst of instruments) {
        const encl = findEnclosingSymbol(symbols, inst.line);
        edges.push({
          edgeType: 'otel_instrument',
          sourceNodeType: encl ? 'symbol' : 'file',
          sourceRefId: encl ? encl.id : file.id,
          sourceSymbolId: encl?.symbolId,
          targetSymbolId: `otel-instrument::${inst.name}`,
          metadata: {
            instrument: inst.instrument,
            type: inst.instrument,
            name: inst.name,
            description: inst.description,
            unit: inst.unit,
            line: inst.line,
            filePath: file.path,
            symbolName: encl?.name,
          },
          resolution: 'text_matched',
        });
      }

      // 4. Span boundaries and execution edges
      for (const span of spans) {
        const encl = findEnclosingSymbol(symbols, span.line);

        edges.push({
          edgeType: 'otel_span',
          sourceNodeType: encl ? 'symbol' : 'file',
          sourceRefId: encl ? encl.id : file.id,
          sourceSymbolId: encl?.symbolId,
          targetSymbolId: `otel-span::${span.name}`,
          metadata: {
            name: span.name,
            kind: span.kind,
            isAsync: span.isAsync,
            tracer: span.tracerVar,
            parentSpan: span.parentSpan,
            spanKind: span.spanKind,
            attributes: span.attributes,
            events: span.events,
            hasErrorRecording: span.hasErrorRecording,
            hasStatus: span.hasStatus,
            line: span.line,
            endLine: span.endLine,
            filePath: file.path,
            symbolName: encl?.name,
          },
          resolution: 'text_matched',
        });

        // 5. Nested child span hierarchy edge
        if (span.parentSpan) {
          edges.push({
            edgeType: 'otel_span_child',
            sourceNodeType: encl ? 'symbol' : 'file',
            sourceRefId: encl ? encl.id : file.id,
            sourceSymbolId: encl?.symbolId,
            targetSymbolId: `otel-span::${span.name}`,
            metadata: {
              childSpan: span.name,
              parentSpan: span.parentSpan,
              line: span.line,
              filePath: file.path,
              symbolName: encl?.name,
            },
            resolution: 'text_matched',
          });
        }
      }
    }

    return ok(edges);
  }
}
