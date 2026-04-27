/**
 * Export security context for MCP server analysis.
 *
 * Generates enrichment JSON for skill-scan: tool registrations with annotations,
 * transitive call graphs classified by security category, sensitive data flows,
 * and per-file capability maps.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Store } from '../../db/store.js';
import type { RouteRow } from '../../db/types.js';
import { ok, } from 'neverthrow';
import type { TraceMcpResult } from '../../errors.js';
import { getCallGraph } from '../framework/call-graph.js';
import { taintAnalysis } from './taint-analysis.js';

// ── Types ──────────────────────────────────────────────────────────────

export type SecurityCategory =
  | 'file_read'
  | 'file_write'
  | 'network_outbound'
  | 'env_read'
  | 'shell_exec'
  | 'crypto'
  | 'serialization';

export interface HandlerCall {
  function: string;
  file: string;
  line: number;
  category: SecurityCategory;
}

export interface ToolRegistrationEntry {
  name: string;
  description: string | null;
  file: string;
  line: number;
  annotations: Record<string, boolean> | null;
  handler_resolved: boolean;
  handler_calls: HandlerCall[];
}

export interface SensitiveFlowEntry {
  source: { kind: string; name: string; file: string; line: number };
  sink: { kind: string; file: string; line: number };
  hops: string[];
}

export interface EnrichmentResult {
  $schema: string;
  version: '1';
  generator: string;
  generated_at: string;
  tool_registrations: ToolRegistrationEntry[];
  sensitive_flows: SensitiveFlowEntry[];
  capability_map: Record<string, string[]>;
  warnings: string[];
}

export interface ExportSecurityContextOpts {
  scope?: string;
  depth?: number;
}

// ── Security category classification ───────────────────────────────────

const CATEGORY_PATTERNS: Array<{ pattern: RegExp; category: SecurityCategory }> = [
  // file_read
  {
    pattern: /^(?:readFile|readFileSync|readdir|readdirSync|createReadStream|promises\.readFile)$/,
    category: 'file_read',
  },
  { pattern: /^(?:fs\.read|fs\.promises\.read|fsPromises\.read)/, category: 'file_read' },

  // file_write
  {
    pattern:
      /^(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|promises\.writeFile)$/,
    category: 'file_write',
  },
  {
    pattern:
      /^(?:unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync|rename|renameSync|copyFile|copyFileSync)$/,
    category: 'file_write',
  },
  {
    pattern: /^(?:fs\.write|fs\.promises\.write|fs\.unlink|fs\.rm|fsPromises\.write)/,
    category: 'file_write',
  },
  { pattern: /^(?:mkdir|mkdirSync|promises\.mkdir)$/, category: 'file_write' },

  // network_outbound
  { pattern: /^(?:fetch|request|got|axios)$/, category: 'network_outbound' },
  {
    pattern: /^(?:http\.request|https\.request|http\.get|https\.get)$/,
    category: 'network_outbound',
  },
  {
    pattern: /^(?:net\.connect|net\.createConnection|tls\.connect)$/,
    category: 'network_outbound',
  },
  { pattern: /^(?:XMLHttpRequest|WebSocket)$/, category: 'network_outbound' },

  // env_read
  { pattern: /^(?:process\.env|env\.)/, category: 'env_read' },
  { pattern: /^(?:getenv|os\.environ|dotenv)/, category: 'env_read' },

  // shell_exec
  {
    pattern: /^(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)$/,
    category: 'shell_exec',
  },
  { pattern: /^(?:child_process\.|cp\.)/, category: 'shell_exec' },

  // crypto
  {
    pattern:
      /^(?:createHash|createCipher|createCipheriv|createDecipher|createDecipheriv|createSign|createVerify|createHmac)$/,
    category: 'crypto',
  },
  { pattern: /^(?:crypto\.)/, category: 'crypto' },

  // serialization
  { pattern: /^(?:eval|Function)$/, category: 'serialization' },
  { pattern: /^(?:deserialize|unserialize|pickle\.loads|yaml\.load)$/, category: 'serialization' },
];

function classifyFunction(name: string): SecurityCategory | null {
  for (const { pattern, category } of CATEGORY_PATTERNS) {
    if (pattern.test(name)) return category;
  }
  return null;
}

// ── Annotation parsing ─────────────────────────────────────────────────

const ANNOTATION_RE = /\{\s*(?:readOnlyHint|destructiveHint|idempotentHint|openWorldHint)\s*:/;

function parseAnnotations(source: string, toolCallIndex: number): Record<string, boolean> | null {
  // Find the .tool( call and scan forward for annotation-like objects
  // Annotations appear after the schema object and before the handler function
  const searchRegion = source.slice(toolCallIndex, toolCallIndex + 2000);

  // Look for annotation object patterns
  const annotationMatch = searchRegion.match(
    /\{\s*(readOnlyHint\s*:\s*(true|false)\s*,?\s*)?(destructiveHint\s*:\s*(true|false)\s*,?\s*)?(idempotentHint\s*:\s*(true|false)\s*,?\s*)?(openWorldHint\s*:\s*(true|false)\s*,?\s*)\}/,
  );

  if (!annotationMatch) return null;

  const annotations: Record<string, boolean> = {};
  if (annotationMatch[2]) annotations.readOnlyHint = annotationMatch[2] === 'true';
  if (annotationMatch[4]) annotations.destructiveHint = annotationMatch[4] === 'true';
  if (annotationMatch[6]) annotations.idempotentHint = annotationMatch[6] === 'true';
  if (annotationMatch[8]) annotations.openWorldHint = annotationMatch[8] === 'true';

  return Object.keys(annotations).length > 0 ? annotations : null;
}

// More flexible: match individual hint fields anywhere near the tool call
function parseAnnotationsFlexible(
  source: string,
  toolCallIndex: number,
): Record<string, boolean> | null {
  const searchRegion = source.slice(toolCallIndex, toolCallIndex + 3000);

  // Check if there's any annotation hint in this region
  if (!ANNOTATION_RE.test(searchRegion)) return null;

  const annotations: Record<string, boolean> = {};
  const hints = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;

  for (const hint of hints) {
    const re = new RegExp(`${hint}\\s*:\\s*(true|false)`);
    const m = searchRegion.match(re);
    if (m) annotations[hint] = m[1] === 'true';
  }

  return Object.keys(annotations).length > 0 ? annotations : null;
}

// ── Call graph walking ─────────────────────────────────────────────────

interface CallGraphNode {
  symbol_id: string;
  name: string;
  kind: string;
  file: string;
  line: number | null;
  calls?: CallGraphNode[];
}

function collectCallsFromGraph(
  node: CallGraphNode,
  visited: Set<string>,
  results: HandlerCall[],
): void {
  if (visited.has(node.symbol_id)) return;
  visited.add(node.symbol_id);

  // Classify this node
  const category = classifyFunction(node.name);
  if (category && node.file && node.line) {
    results.push({
      function: node.name,
      file: node.file,
      line: node.line,
      category,
    });
  }

  // Recurse into callees
  if (node.calls) {
    for (const callee of node.calls) {
      collectCallsFromGraph(callee, visited, results);
    }
  }
}

// ── Inline handler scanning ────────────────────────────────────────────

// Direct security-sensitive call patterns
const SECURITY_CALL_RE =
  /\b((?:fs|http|https|net|crypto|child_process|cp)\.\w+|fetch|exec|execSync|spawn|spawnSync|eval|require|writeFile\w*|readFile\w*|unlink\w*|request|axios|got)\s*\(/g;
const ENV_ACCESS_RE = /process\.env\b/g;

// Generic function call pattern — captures any function call for symbol lookup
const GENERIC_CALL_RE = /\b([a-zA-Z_$]\w*)\s*\(/g;
// Skip known non-function keywords
const SKIP_KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'typeof',
  'new',
  'async',
  'await',
  'function',
  'const',
  'let',
  'var',
  'class',
  'import',
  'export',
  'throw',
  'delete',
  'void',
  'yield',
  'as',
  'from',
]);

function findHandlerBounds(
  source: string,
  toolCallIndex: number,
): { start: number; end: number } | null {
  const region = source.slice(toolCallIndex, toolCallIndex + 10000);

  // Find async handler: match the full `async (...) => {` pattern
  // We need to find the `=> {` to locate the actual body opening brace
  const arrowMatch = region.match(/async\s+(?:\([^)]*\)|[^=]*?)\s*=>\s*\{/);
  const funcMatch = region.match(/async\s+function\s*\([^)]*\)\s*\{/);
  const match = arrowMatch ?? funcMatch;
  if (!match || match.index === undefined) return null;

  // The body opening brace is the last `{` in the match
  const bodyBraceOffset = match.index + match[0].length - 1;
  const afterBrace = region.slice(bodyBraceOffset);

  // Match braces to find handler end (start at depth=1 since we're past the opening brace)
  let depth = 1;
  let end = -1;
  for (let i = 1; i < afterBrace.length; i++) {
    if (afterBrace[i] === '{') depth++;
    else if (afterBrace[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) end = Math.min(afterBrace.length, 5000);

  const absStart = toolCallIndex + bodyBraceOffset;
  const absEnd = toolCallIndex + bodyBraceOffset + end;
  return { start: absStart, end: absEnd };
}

function scanInlineHandler(
  source: string,
  toolCallIndex: number,
  filePath: string,
  store: Store,
  projectRoot: string,
  depth: number,
): { calls: HandlerCall[]; calledSymbolIds: string[] } {
  const bounds = findHandlerBounds(source, toolCallIndex);
  if (!bounds) return { calls: [], calledSymbolIds: [] };

  const handlerBody = source.slice(bounds.start, bounds.end);
  const results: HandlerCall[] = [];
  const calledSymbolIds: string[] = [];

  let m: RegExpExecArray | null;

  // 1. Direct security-sensitive calls
  const secRe = new RegExp(SECURITY_CALL_RE.source, 'g');
  while ((m = secRe.exec(handlerBody)) !== null) {
    const funcName = m[1];
    const category = classifyFunction(funcName);
    if (category) {
      const lineOffset = source.slice(0, bounds.start + m.index).split('\n').length;
      results.push({ function: funcName, file: filePath, line: lineOffset, category });
    }
  }

  // 2. process.env access
  const envRe = new RegExp(ENV_ACCESS_RE.source, 'g');
  while ((m = envRe.exec(handlerBody)) !== null) {
    const lineOffset = source.slice(0, bounds.start + m.index).split('\n').length;
    results.push({
      function: 'process.env',
      file: filePath,
      line: lineOffset,
      category: 'env_read',
    });
  }

  // 3. Generic function calls — look up in store and trace call graphs
  const genericRe = new RegExp(GENERIC_CALL_RE.source, 'g');
  const seenFuncs = new Set<string>();
  while ((m = genericRe.exec(handlerBody)) !== null) {
    const funcName = m[1];
    if (SKIP_KEYWORDS.has(funcName) || seenFuncs.has(funcName)) continue;
    seenFuncs.add(funcName);

    // Look up symbol in the store
    const sym =
      store.getSymbolByName(funcName, 'function') ?? store.getSymbolByName(funcName, 'method');
    if (!sym) continue;

    calledSymbolIds.push(sym.symbol_id);

    // Build call graph from this symbol to find transitive security calls
    const cgResult = getCallGraph(store, { symbolId: sym.symbol_id }, depth);
    if (cgResult.isOk() && cgResult.value.root) {
      const visited = new Set<string>();
      collectCallsFromGraph(cgResult.value.root as CallGraphNode, visited, results);
    }

    // Also scan the resolved function's source for direct security calls
    // (catches calls to node built-ins like readFileSync which aren't in the call graph)
    const file = sym.file_id ? store.getFileById(sym.file_id) : null;
    if (file && sym.line_start && sym.line_end) {
      const symAbsPath = path.resolve(projectRoot, file.path);
      try {
        const symSource = readFileSync(symAbsPath, 'utf-8');
        const lines = symSource.split('\n');
        const symBody = lines.slice(sym.line_start - 1, sym.line_end).join('\n');
        scanSourceForSecurityCalls(symBody, file.path, sym.line_start, results);
      } catch {
        /* file unreadable */
      }
    }
  }

  return { calls: results, calledSymbolIds };
}

/** Scan a source body for direct security-sensitive calls (node built-ins, etc.) */
function scanSourceForSecurityCalls(
  body: string,
  filePath: string,
  startLine: number,
  results: HandlerCall[],
): void {
  let m: RegExpExecArray | null;

  const secRe = new RegExp(SECURITY_CALL_RE.source, 'g');
  while ((m = secRe.exec(body)) !== null) {
    const funcName = m[1];
    const category = classifyFunction(funcName);
    if (category) {
      const lineOffset = startLine + body.slice(0, m.index).split('\n').length - 1;
      results.push({ function: funcName, file: filePath, line: lineOffset, category });
    }
  }

  const envRe = new RegExp(ENV_ACCESS_RE.source, 'g');
  while ((m = envRe.exec(body)) !== null) {
    const lineOffset = startLine + body.slice(0, m.index).split('\n').length - 1;
    results.push({
      function: 'process.env',
      file: filePath,
      line: lineOffset,
      category: 'env_read',
    });
  }
}

// ── Main export ────────────────────────────────────────────────────────

declare const PKG_VERSION_INJECTED: string;
const PKG_VERSION =
  typeof PKG_VERSION_INJECTED !== 'undefined' ? PKG_VERSION_INJECTED : '0.0.0-dev';

export function exportSecurityContext(
  store: Store,
  projectRoot: string,
  opts: ExportSecurityContextOpts = {},
): TraceMcpResult<EnrichmentResult> {
  const depth = Math.min(opts.depth ?? 3, 5);
  const warnings: string[] = [];

  // Step 1: Find MCP tool registrations via routes
  const allRoutes = store.getAllRoutes();
  const toolRoutes = allRoutes.filter((r: RouteRow) => r.method === 'TOOL');

  if (toolRoutes.length === 0) {
    warnings.push(
      'No MCP tool registrations found in the index. Ensure the project uses @modelcontextprotocol/sdk and has been indexed.',
    );
  }

  // Step 2-4: Process each tool registration
  const toolRegistrations: ToolRegistrationEntry[] = [];
  const capabilityMap: Record<string, Set<SecurityCategory>> = {};

  for (const route of toolRoutes) {
    const fileRow = route.file_id ? store.getFileById(route.file_id) : null;
    if (!fileRow) continue;

    // Apply scope filter
    if (opts.scope && !fileRow.path.startsWith(opts.scope)) continue;

    const absPath = path.resolve(projectRoot, fileRow.path);
    let source: string;
    try {
      source = readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }

    // Find the .tool() registration line for this specific tool
    const toolNameEscaped = route.uri.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const toolCallRe = new RegExp(`\\.tool\\(\\s*['"]${toolNameEscaped}['"]`);
    const toolCallMatch = toolCallRe.exec(source);
    const toolCallIndex = toolCallMatch?.index ?? 0;
    const toolLine =
      toolCallIndex > 0 ? source.slice(0, toolCallIndex).split('\n').length : (route.line ?? 0);

    // Parse annotations
    const annotations =
      parseAnnotationsFlexible(source, toolCallIndex) ?? parseAnnotations(source, toolCallIndex);

    // Build call graph from handler
    let handlerCalls: HandlerCall[] = [];
    let handlerResolved = false;

    // Scan inline handler body: extract direct security calls + look up
    // called functions in the store and trace their call graphs
    if (toolCallIndex > 0) {
      const scanResult = scanInlineHandler(
        source,
        toolCallIndex,
        fileRow.path,
        store,
        projectRoot,
        depth,
      );
      handlerCalls = scanResult.calls;
      handlerResolved = handlerCalls.length > 0 || scanResult.calledSymbolIds.length > 0;
    }

    // Deduplicate handler calls
    const seen = new Set<string>();
    handlerCalls = handlerCalls.filter((c) => {
      const key = `${c.function}:${c.file}:${c.line}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Update capability map
    for (const call of handlerCalls) {
      if (!capabilityMap[call.file]) capabilityMap[call.file] = new Set();
      capabilityMap[call.file].add(call.category);
    }

    toolRegistrations.push({
      name: route.uri,
      description: route.name ?? null,
      file: fileRow.path,
      line: toolLine,
      annotations,
      handler_resolved: handlerResolved,
      handler_calls: handlerCalls,
    });
  }

  // Step 5: Sensitive data flows via taint analysis
  const sensitiveFlows: SensitiveFlowEntry[] = [];

  // Get MCP server files for scoped taint analysis
  const mcpServerFiles = new Set(toolRegistrations.map((t) => t.file));
  if (mcpServerFiles.size > 0) {
    // Run taint analysis scoped to directories containing MCP server files
    const mcpDirs = [...new Set([...mcpServerFiles].map((f) => path.dirname(f)))];
    for (const dir of mcpDirs) {
      const taintResult = taintAnalysis(store, projectRoot, {
        scope: dir,
        sources: ['env', 'file_read'],
        includeSanitized: false,
        limit: 50,
      });

      if (taintResult.isOk()) {
        for (const flow of taintResult.value.flows) {
          sensitiveFlows.push({
            source: {
              kind: flow.source.kind,
              name: flow.source.variable,
              file: flow.file,
              line: flow.source.line,
            },
            sink: {
              kind: flow.sink.kind,
              file: flow.file,
              line: flow.sink.line,
            },
            hops: flow.path.map((step) => `${flow.file}:${step.line}`),
          });
        }
      }
    }
  }

  // Step 6: Build capability map (convert Sets to arrays)
  const capabilityMapOutput: Record<string, string[]> = {};
  for (const [file, categories] of Object.entries(capabilityMap)) {
    capabilityMapOutput[file] = [...categories].sort();
  }

  // Step 7: Assemble result
  return ok({
    $schema: 'https://skill-scan.dev/schemas/enrichment/v1.json',
    version: '1' as const,
    generator: `trace-mcp/${PKG_VERSION}`,
    generated_at: new Date().toISOString(),
    tool_registrations: toolRegistrations,
    sensitive_flows: sensitiveFlows,
    capability_map: capabilityMapOutput,
    warnings,
  });
}
