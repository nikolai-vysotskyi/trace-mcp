/**
 * Taint Analysis — Phase 1: Intra-procedural taint tracking.
 *
 * Tracks flow of untrusted data from sources (user input) to sinks (dangerous functions)
 * within individual functions. Framework-aware: knows Express req.params, Laravel $request->input,
 * Django request.GET, FastAPI Query(), etc.
 *
 * More accurate than pattern-based security scanning — finds actual data flow paths
 * and recognizes sanitizers that neutralize the taint.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Store } from '../db/store.js';
import { ok, type TraceMcpResult } from '../errors.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaintSourceKind =
  | 'http_param' | 'http_body' | 'http_header' | 'cookie'
  | 'env' | 'file_read' | 'db_result' | 'user_input';

export type TaintSinkKind =
  | 'sql_query' | 'exec' | 'eval' | 'innerHTML' | 'redirect'
  | 'file_write' | 'response_body' | 'template_raw';

export interface TaintSource {
  kind: TaintSourceKind;
  expression: string;
  variable: string;
  line: number;
}

export interface TaintSink {
  kind: TaintSinkKind;
  expression: string;
  variable: string;
  line: number;
  cwe: string;
}

export interface TaintFlowStep {
  expression: string;
  line: number;
  type: 'source' | 'assignment' | 'sink';
}

export interface TaintFlow {
  source: TaintSource;
  sink: TaintSink;
  path: TaintFlowStep[];
  sanitized: boolean;
  sanitizer?: string;
  confidence: 'high' | 'medium' | 'low';
  file: string;
}

export interface TaintAnalysisResult {
  files_analyzed: number;
  flows: TaintFlow[];
  summary: {
    critical: number;
    sanitized: number;
    total: number;
  };
}

// ---------------------------------------------------------------------------
// Source patterns (framework-aware)
// ---------------------------------------------------------------------------

interface SourcePattern {
  regex: RegExp;
  kind: TaintSourceKind;
  languages: Set<string>;
  varExtractor: (match: RegExpExecArray) => string;
}

const JS_TS = new Set(['typescript', 'javascript']);
const PY = new Set(['python']);
const PHP = new Set(['php']);
const RUBY = new Set(['ruby']);
const JAVA = new Set(['java', 'kotlin']);
const GO = new Set(['go']);
const ALL = new Set(['typescript', 'javascript', 'python', 'php', 'ruby', 'java', 'kotlin', 'go']);

const SOURCE_PATTERNS: SourcePattern[] = [
  // Express / Node.js
  { regex: /(?:const|let|var)\s+(\w+)\s*=\s*req\.(params|query|body)\[?['"]?(\w*)['"]?\]?/g, kind: 'http_param', languages: JS_TS, varExtractor: m => m[1] },
  { regex: /(?:const|let|var)\s+(\w+)\s*=\s*req\.(?:params|query|body)\.(\w+)/g, kind: 'http_param', languages: JS_TS, varExtractor: m => m[1] },
  { regex: /req\.(params|query|body)\[?['"]?(\w+)['"]?\]?/g, kind: 'http_param', languages: JS_TS, varExtractor: m => `req.${m[1]}.${m[2]}` },
  { regex: /(?:const|let|var)\s+(\w+)\s*=\s*req\.headers\[?['"]?(\w+)['"]?\]?/g, kind: 'http_header', languages: JS_TS, varExtractor: m => m[1] },
  { regex: /(?:const|let|var)\s+(\w+)\s*=\s*req\.cookies\[?['"]?(\w+)['"]?\]?/g, kind: 'cookie', languages: JS_TS, varExtractor: m => m[1] },

  // Destructured params: const { id, name } = req.params
  { regex: /(?:const|let|var)\s+\{\s*([^}]+)\}\s*=\s*req\.(params|query|body)/g, kind: 'http_param', languages: JS_TS, varExtractor: m => m[1].split(',').map(s => s.trim().split(':')[0].trim())[0] },

  // FastAPI
  { regex: /(\w+)\s*:\s*\w+\s*=\s*(?:Query|Path|Body|Header|Cookie)\s*\(/g, kind: 'http_param', languages: PY, varExtractor: m => m[1] },

  // Django
  { regex: /(\w+)\s*=\s*request\.(GET|POST|data|FILES)\[?['"]?(\w+)['"]?\]?/g, kind: 'http_param', languages: PY, varExtractor: m => m[1] },
  { regex: /(\w+)\s*=\s*request\.(?:GET|POST)\.get\(['"](\w+)['"]/g, kind: 'http_param', languages: PY, varExtractor: m => m[1] },

  // Flask
  { regex: /(\w+)\s*=\s*request\.(args|form|json)\[?\.?['"]?(\w+)['"]?\]?/g, kind: 'http_param', languages: PY, varExtractor: m => m[1] },

  // Laravel / PHP
  { regex: /(\$\w+)\s*=\s*\$request->(input|get|query|post|all)\s*\(\s*['"](\w+)['"]/g, kind: 'http_param', languages: PHP, varExtractor: m => m[1] },
  { regex: /(\$\w+)\s*=\s*\$_(?:GET|POST|REQUEST)\[['"](\w+)['"]\]/g, kind: 'http_param', languages: PHP, varExtractor: m => m[1] },
  { regex: /(\$\w+)\s*=\s*request\(\)\s*->\s*(?:input|get|query)\s*\(\s*['"](\w+)['"]/g, kind: 'http_param', languages: PHP, varExtractor: m => m[1] },

  // Rails / Ruby
  { regex: /(\w+)\s*=\s*params\[?:(\w+)\]?/g, kind: 'http_param', languages: RUBY, varExtractor: m => m[1] },

  // Go (Gin/Echo)
  { regex: /(\w+)\s*:?=\s*c\.(?:Param|Query|PostForm|FormValue)\s*\(\s*"(\w+)"/g, kind: 'http_param', languages: GO, varExtractor: m => m[1] },

  // Java (Spring)
  { regex: /@(?:RequestParam|PathVariable|RequestBody)[^)]*\)\s*(?:\w+\s+)?(\w+)/g, kind: 'http_param', languages: JAVA, varExtractor: m => m[1] },

  // Environment variables
  { regex: /(?:const|let|var)\s+(\w+)\s*=\s*process\.env\[?\.?['"]?(\w+)['"]?\]?/g, kind: 'env', languages: JS_TS, varExtractor: m => m[1] },
  { regex: /(\w+)\s*=\s*os\.(?:getenv|environ\.get)\s*\(\s*['"](\w+)['"]/g, kind: 'env', languages: PY, varExtractor: m => m[1] },

  // File reads
  { regex: /(?:const|let|var)\s+(\w+)\s*=\s*(?:fs\.readFileSync|await\s+fs\.promises\.readFile)\s*\(/g, kind: 'file_read', languages: JS_TS, varExtractor: m => m[1] },

  // User input
  { regex: /(?:const|let|var)\s+(\w+)\s*=\s*(?:prompt|readline|input)\s*\(/g, kind: 'user_input', languages: ALL, varExtractor: m => m[1] },
];

// ---------------------------------------------------------------------------
// Sink patterns
// ---------------------------------------------------------------------------

interface SinkPattern {
  regex: RegExp;
  kind: TaintSinkKind;
  cwe: string;
  languages: Set<string>;
  varExtractor: (match: RegExpExecArray, line: string) => string | null;
}

const SINK_PATTERNS: SinkPattern[] = [
  // SQL Injection (CWE-89)
  { regex: /\.(query|exec|execute|raw|rawQuery)\s*\(\s*`[^`]*\$\{(\w+)/g, kind: 'sql_query', cwe: 'CWE-89', languages: JS_TS, varExtractor: (m) => m[2] },
  { regex: /\.(query|exec|execute|raw)\s*\(\s*['"][^'"]*['"]\s*\+\s*(\w+)/g, kind: 'sql_query', cwe: 'CWE-89', languages: JS_TS, varExtractor: (m) => m[2] },
  { regex: /\.(execute|executemany)\s*\(\s*f["'][^"']*\{(\w+)/g, kind: 'sql_query', cwe: 'CWE-89', languages: PY, varExtractor: (m) => m[2] },
  { regex: /->(?:query|whereRaw|selectRaw)\s*\(\s*["'][^"']*\.\s*(\$\w+)/g, kind: 'sql_query', cwe: 'CWE-89', languages: PHP, varExtractor: (m) => m[1] },
  { regex: /DB::(?:raw|select|statement)\s*\(\s*["'][^"']*\.\s*(\$\w+)/g, kind: 'sql_query', cwe: 'CWE-89', languages: PHP, varExtractor: (m) => m[1] },
  { regex: /\.(?:Query|Exec|QueryRow)\s*\(\s*(?:fmt\.Sprintf|"[^"]*"\s*\+)\s*[^,)]*(\w+)/g, kind: 'sql_query', cwe: 'CWE-89', languages: GO, varExtractor: (m) => m[1] },

  // Command Injection (CWE-78)
  { regex: /(?:exec|execSync|spawn|spawnSync)\s*\(\s*`[^`]*\$\{(\w+)/g, kind: 'exec', cwe: 'CWE-78', languages: JS_TS, varExtractor: (m) => m[1] },
  { regex: /(?:exec|execSync|spawn)\s*\(\s*['"][^'"]*['"]\s*\+\s*(\w+)/g, kind: 'exec', cwe: 'CWE-78', languages: JS_TS, varExtractor: (m) => m[1] },
  { regex: /os\.(?:system|popen)\s*\(\s*f?["'][^"']*(?:\{(\w+)|["']\s*\+\s*(\w+))/g, kind: 'exec', cwe: 'CWE-78', languages: PY, varExtractor: (m) => m[1] || m[2] },
  { regex: /subprocess\.(?:run|call|Popen)\s*\(\s*f?["'][^"']*(?:\{(\w+)|["']\s*\+\s*(\w+))/g, kind: 'exec', cwe: 'CWE-78', languages: PY, varExtractor: (m) => m[1] || m[2] },
  { regex: /(?:shell_exec|exec|system|passthru)\s*\(\s*["'][^"']*\.\s*(\$\w+)/g, kind: 'exec', cwe: 'CWE-78', languages: PHP, varExtractor: (m) => m[1] },

  // Eval (CWE-95)
  { regex: /eval\s*\(\s*(\w+)/g, kind: 'eval', cwe: 'CWE-95', languages: ALL, varExtractor: (m) => m[1] },

  // XSS (CWE-79)
  { regex: /\.innerHTML\s*=\s*(\w+)/g, kind: 'innerHTML', cwe: 'CWE-79', languages: JS_TS, varExtractor: (m) => m[1] },
  { regex: /dangerouslySetInnerHTML\s*=\s*\{\s*\{\s*__html\s*:\s*(\w+)/g, kind: 'innerHTML', cwe: 'CWE-79', languages: JS_TS, varExtractor: (m) => m[1] },
  { regex: /\{!!\s*(\$\w+)\s*!!\}/g, kind: 'template_raw', cwe: 'CWE-79', languages: PHP, varExtractor: (m) => m[1] },

  // Open Redirect (CWE-601)
  { regex: /(?:res\.redirect|redirect|location\.href\s*=)\s*\(?\s*(\w+)/g, kind: 'redirect', cwe: 'CWE-601', languages: ALL, varExtractor: (m) => m[1] },

  // File Write (CWE-73)
  { regex: /(?:fs\.writeFileSync|fs\.promises\.writeFile|writeFile)\s*\(\s*(\w+)/g, kind: 'file_write', cwe: 'CWE-73', languages: JS_TS, varExtractor: (m) => m[1] },
];

// ---------------------------------------------------------------------------
// Sanitizer patterns
// ---------------------------------------------------------------------------

interface SanitizerPattern {
  regex: RegExp;
  languages: Set<string>;
  name: string;
}

const SANITIZER_PATTERNS: SanitizerPattern[] = [
  // General
  { regex: /parseInt\s*\(/g, languages: ALL, name: 'parseInt' },
  { regex: /Number\s*\(/g, languages: JS_TS, name: 'Number()' },
  { regex: /parseFloat\s*\(/g, languages: ALL, name: 'parseFloat' },
  { regex: /encodeURIComponent\s*\(/g, languages: JS_TS, name: 'encodeURIComponent' },
  { regex: /encodeURI\s*\(/g, languages: JS_TS, name: 'encodeURI' },

  // JS/TS sanitizers
  { regex: /DOMPurify\.sanitize\s*\(/g, languages: JS_TS, name: 'DOMPurify.sanitize' },
  { regex: /(?:validator\.)?escape\s*\(/g, languages: JS_TS, name: 'escape()' },
  { regex: /sanitize(?:Html)?\s*\(/g, languages: JS_TS, name: 'sanitize()' },

  // Parameterized queries
  { regex: /\?\s*,|%s.*prepared|\$\d+/g, languages: ALL, name: 'parameterized query' },
  { regex: /\.prepare\s*\(/g, languages: ALL, name: 'prepared statement' },

  // Python
  { regex: /bleach\.clean\s*\(/g, languages: PY, name: 'bleach.clean' },
  { regex: /html\.escape\s*\(/g, languages: PY, name: 'html.escape' },
  { regex: /django\.utils\.html\.escape\s*\(/g, languages: PY, name: 'django.escape' },
  { regex: /markupsafe\.escape\s*\(/g, languages: PY, name: 'markupsafe.escape' },
  { regex: /int\s*\(/g, languages: PY, name: 'int()' },

  // PHP
  { regex: /htmlspecialchars\s*\(/g, languages: PHP, name: 'htmlspecialchars' },
  { regex: /htmlentities\s*\(/g, languages: PHP, name: 'htmlentities' },
  { regex: /strip_tags\s*\(/g, languages: PHP, name: 'strip_tags' },
  { regex: /(?:e|escape)\s*\(\s*(\$\w+)/g, languages: PHP, name: 'e()' },
  { regex: /Validator::make|->validate\s*\(/g, languages: PHP, name: 'Laravel Validator' },
  { regex: /\{\{\s*\$\w+\s*\}\}/g, languages: PHP, name: 'Blade {{ }} auto-escape' },

  // Ruby
  { regex: /ERB::Util\.html_escape\s*\(/g, languages: RUBY, name: 'html_escape' },
  { regex: /sanitize\s*\(/g, languages: RUBY, name: 'sanitize()' },

  // Go
  { regex: /html\.EscapeString\s*\(/g, languages: GO, name: 'html.EscapeString' },
  { regex: /template\.HTMLEscapeString\s*\(/g, languages: GO, name: 'template.HTMLEscapeString' },
];

// ---------------------------------------------------------------------------
// Variable flow tracking (intra-procedural)
// ---------------------------------------------------------------------------

interface VarAssignment {
  variable: string;
  fromVariable: string;
  line: number;
  expression: string;
}

function trackVariableFlow(lines: string[], _language: string): VarAssignment[] {
  const assignments: VarAssignment[] = [];

  // Track assignments: var = expr involving another var
  const assignPatterns = [
    // JS/TS: const/let/var x = y.something or y
    /(?:const|let|var)\s+(\w+)\s*=\s*(\w+)(?:\.\w+|\[['"]?\w+['"]?\])?/g,
    // Python/Ruby: x = y.something
    /^(\w+)\s*=\s*(\w+)(?:\.\w+|\[['"]?\w+['"]?\])?/gm,
    // PHP: $x = $y->something or $y
    /(\$\w+)\s*=\s*(\$\w+)(?:->|\[)/g,
    // Go: x := y.Something
    /(\w+)\s*:?=\s*(\w+)(?:\.\w+)?/g,
  ];

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    for (const pattern of assignPatterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        if (match[1] !== match[2]) { // avoid self-assignment
          assignments.push({
            variable: match[1],
            fromVariable: match[2],
            line: lineIdx + 1,
            expression: line.trim(),
          });
        }
      }
    }
  }

  return assignments;
}

// ---------------------------------------------------------------------------
// Core analysis
// ---------------------------------------------------------------------------

function analyzeFile(
  content: string,
  filePath: string,
  language: string,
): TaintFlow[] {
  const lines = content.split('\n');
  const flows: TaintFlow[] = [];

  // Step 1: Find all sources
  const sources: TaintSource[] = [];
  for (const sp of SOURCE_PATTERNS) {
    if (!sp.languages.has(language)) continue;
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      sp.regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = sp.regex.exec(line)) !== null) {
        sources.push({
          kind: sp.kind,
          expression: line.trim(),
          variable: sp.varExtractor(match),
          line: lineIdx + 1,
        });
      }
    }
  }

  if (sources.length === 0) return flows;

  // Step 2: Find all sinks
  const sinks: TaintSink[] = [];
  for (const skp of SINK_PATTERNS) {
    if (!skp.languages.has(language)) continue;
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      skp.regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = skp.regex.exec(line)) !== null) {
        const variable = skp.varExtractor(match, line);
        if (variable) {
          sinks.push({
            kind: skp.kind,
            expression: line.trim(),
            variable,
            line: lineIdx + 1,
            cwe: skp.cwe,
          });
        }
      }
    }
  }

  if (sinks.length === 0) return flows;

  // Step 3: Track variable assignments
  const assignments = trackVariableFlow(lines, language);

  // Step 4: Build taint propagation graph
  // For each source, track which variables become tainted through assignments
  for (const source of sources) {
    const taintedVars = new Set<string>();
    taintedVars.add(source.variable);

    // Propagate taint through assignments
    // Multi-pass to handle transitive assignments
    let changed = true;
    const maxPasses = 10;
    let pass = 0;
    while (changed && pass < maxPasses) {
      changed = false;
      pass++;
      for (const assign of assignments) {
        if (assign.line > source.line && taintedVars.has(assign.fromVariable) && !taintedVars.has(assign.variable)) {
          taintedVars.add(assign.variable);
          changed = true;
        }
      }
    }

    // Step 5: Check if any tainted variable reaches a sink
    for (const sink of sinks) {
      if (sink.line <= source.line) continue; // sink must come after source
      if (!taintedVars.has(sink.variable)) continue;

      // Step 6: Check for sanitizers between source and sink
      let sanitized = false;
      let sanitizerName: string | undefined;

      for (let lineIdx = source.line - 1; lineIdx < sink.line; lineIdx++) {
        const line = lines[lineIdx];
        for (const san of SANITIZER_PATTERNS) {
          if (!san.languages.has(language)) continue;
          san.regex.lastIndex = 0;
          if (san.regex.test(line)) {
            // Check if the sanitizer operates on a tainted variable
            for (const tv of taintedVars) {
              if (line.includes(tv)) {
                sanitized = true;
                sanitizerName = san.name;
                break;
              }
            }
            if (sanitized) break;
          }
        }
        if (sanitized) break;
      }

      // Build flow path
      const flowPath: TaintFlowStep[] = [
        { expression: source.expression, line: source.line, type: 'source' },
      ];

      // Add intermediate assignments
      for (const assign of assignments) {
        if (assign.line > source.line && assign.line < sink.line && taintedVars.has(assign.fromVariable)) {
          flowPath.push({ expression: assign.expression, line: assign.line, type: 'assignment' });
        }
      }

      flowPath.push({ expression: sink.expression, line: sink.line, type: 'sink' });

      // Determine confidence
      const directFlow = flowPath.length <= 3; // source → sink or source → assign → sink
      const confidence = directFlow ? 'high' : taintedVars.size <= 3 ? 'medium' : 'low';

      flows.push({
        source,
        sink,
        path: flowPath,
        sanitized,
        sanitizer: sanitizerName,
        confidence,
        file: filePath,
      });
    }
  }

  return flows;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function taintAnalysis(
  store: Store,
  projectRoot: string,
  opts: {
    scope?: string;
    sources?: TaintSourceKind[];
    sinks?: TaintSinkKind[];
    includeSanitized?: boolean;
    limit?: number;
  } = {},
): TraceMcpResult<TaintAnalysisResult> {
  const includeSanitized = opts.includeSanitized ?? false;
  const limit = opts.limit ?? 100;
  const sourceFilter = opts.sources ? new Set(opts.sources) : null;
  const sinkFilter = opts.sinks ? new Set(opts.sinks) : null;

  // Get indexed files
  const scope = opts.scope?.replace(/\/+$/, '');
  const files: { path: string; language: string }[] = scope
    ? store.db.prepare("SELECT path, language FROM files WHERE path LIKE ? AND (status = 'ok' OR status IS NULL)").all(`${scope}%`) as { path: string; language: string }[]
    : store.db.prepare("SELECT path, language FROM files WHERE (status = 'ok' OR status IS NULL)").all() as { path: string; language: string }[];

  // Filter out test files
  const isTest = (p: string) => /(?:^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec)\.\w+$/.test(p);
  const sourceFiles = files.filter(f => !isTest(f.path) && f.language);

  let allFlows: TaintFlow[] = [];
  let analyzed = 0;

  for (const file of sourceFiles) {
    if (allFlows.length >= limit) break;

    const absPath = path.join(projectRoot, file.path);
    let content: string;
    try {
      content = readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }

    const flows = analyzeFile(content, file.path, file.language);
    analyzed++;

    for (const flow of flows) {
      // Apply filters
      if (sourceFilter && !sourceFilter.has(flow.source.kind)) continue;
      if (sinkFilter && !sinkFilter.has(flow.sink.kind)) continue;
      if (!includeSanitized && flow.sanitized) continue;

      allFlows.push(flow);
      if (allFlows.length >= limit) break;
    }
  }

  const critical = allFlows.filter(f => !f.sanitized).length;
  const sanitized = allFlows.filter(f => f.sanitized).length;

  return ok({
    files_analyzed: analyzed,
    flows: allFlows,
    summary: {
      critical,
      sanitized,
      total: allFlows.length,
    },
  });
}
