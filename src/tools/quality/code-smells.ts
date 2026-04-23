/**
 * Code Smells Scanner — finds deferred work and shortcuts left in the codebase:
 * - TODO / FIXME / HACK / XXX comments
 * - Empty functions / stub implementations
 * - Hardcoded values (magic numbers, IPs, URLs, credentials, feature flags)
 * - Debug artifacts (console.log, debugger, var_dump, binding.pry, dbg!, ...)
 *
 * Scans indexed files in batches using regex + symbol metadata.
 * Follows the same pattern as security-scan.ts.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Store } from '../../db/store.js';
import { ok, err, type TraceMcpResult } from '../../errors.js';
import { validationError } from '../../errors.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SmellCategory =
  | 'todo_comment'
  | 'empty_function'
  | 'hardcoded_value'
  | 'debug_artifact';

const ALL_CATEGORIES: SmellCategory[] = [
  'todo_comment',
  'empty_function',
  'hardcoded_value',
  'debug_artifact',
];

export type SmellPriority = 'high' | 'medium' | 'low';

interface CodeSmellFinding {
  category: SmellCategory;
  priority: SmellPriority;
  tag?: string;            // e.g. TODO, FIXME, HACK, XXX for todo_comment
  file: string;
  line: number;
  snippet: string;
  description: string;
  symbol?: string;         // enclosing symbol name (for empty_function)
}

export interface CodeSmellResult {
  files_scanned: number;
  findings: CodeSmellFinding[];
  summary: Record<SmellCategory, number>;
  total: number;
}

// ---------------------------------------------------------------------------
// TODO / FIXME / HACK / XXX comment detection
// ---------------------------------------------------------------------------

interface TodoTag {
  tag: string;
  priority: SmellPriority;
}

const TODO_TAGS: TodoTag[] = [
  { tag: 'FIXME',   priority: 'high' },
  { tag: 'HACK',    priority: 'high' },
  { tag: 'XXX',     priority: 'medium' },
  { tag: 'TODO',    priority: 'medium' },
  { tag: 'TEMP',    priority: 'medium' },
  { tag: 'WORKAROUND', priority: 'medium' },
  { tag: 'BUG',     priority: 'high' },
  { tag: 'REFACTOR', priority: 'low' },
  { tag: 'OPTIMIZE', priority: 'low' },
  { tag: 'NOTE',    priority: 'low' },
];

// Build a single regex that captures the tag and trailing text.
// Matches: // TODO: ..., # FIXME ..., /* HACK: ..., -- TODO ..., etc.
const TODO_TAG_NAMES = TODO_TAGS.map((t) => t.tag).join('|');
const TODO_REGEX = new RegExp(
  `(?://|#|/\\*|\\*|--|%|;|'|REM\\b)\\s*\\b(${TODO_TAG_NAMES})\\b[:\\s]?(.*)`,
  'i',
);

const TODO_TAG_PRIORITY = new Map<string, SmellPriority>(
  TODO_TAGS.map((t) => [t.tag, t.priority]),
);

function detectTodoComments(
  lines: string[],
  filePath: string,
): CodeSmellFinding[] {
  const findings: CodeSmellFinding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = TODO_REGEX.exec(line);
    if (!m) continue;

    const tag = m[1].toUpperCase();
    const message = (m[2] ?? '').trim();
    const priority = TODO_TAG_PRIORITY.get(tag) ?? 'medium';

    findings.push({
      category: 'todo_comment',
      priority,
      tag,
      file: filePath,
      line: i + 1,
      snippet: line.trim().slice(0, 200),
      description: message || `${tag} comment without description`,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Empty function / stub detection
// ---------------------------------------------------------------------------

/**
 * Detect functions/methods whose body is empty or contains only:
 * - pass / return / return null / return undefined / return nil / ...
 * - throw new Error('not implemented') / raise NotImplementedError
 * - a single TODO/FIXME comment
 *
 * Uses symbol byte ranges from the index + file content.
 */

const STUB_BODY_PATTERNS = [
  // completely empty (just whitespace / braces)
  /^\s*$/,
  // Python pass
  /^\s*pass\s*$/,
  // bare return / return null / return undefined / return nil / return None
  /^\s*return(?:\s+(?:null|undefined|nil|None|false|0|''))?\s*;?\s*$/,
  // throw not-implemented
  /^\s*throw\s+new\s+(?:Error|NotImplementedError|UnsupportedOperationException)\s*\(\s*(['"`].*?['"`])?\s*\)\s*;?\s*$/,
  // Python raise
  /^\s*raise\s+(?:NotImplementedError|NotImplemented)\s*(?:\(.*\))?\s*$/,
  // Single-line TODO/FIXME comment only
  /^\s*(?:\/\/|#|--|%)\s*(?:TODO|FIXME|HACK|XXX)\b.*$/i,
  // Ellipsis (Python stub)
  /^\s*\.\.\.\s*$/,
];

const CALLABLE_KINDS = new Set([
  'function', 'method', 'arrow_function', 'closure',
  'constructor', 'static_method', 'class_method',
  'generator', 'async_function', 'async_method',
]);

interface SymbolRange {
  name: string;
  kind: string;
  symbol_id: string;
  line_start: number;
  line_end: number;
  byte_start: number;
  byte_end: number;
  signature: string | null;
}

function detectEmptyFunctions(
  content: string,
  lines: string[],
  symbols: SymbolRange[],
  filePath: string,
  language: string,
): CodeSmellFinding[] {
  const findings: CodeSmellFinding[] = [];

  for (const sym of symbols) {
    if (!CALLABLE_KINDS.has(sym.kind)) continue;
    if (sym.line_start == null || sym.line_end == null) continue;

    // Extract the body: everything between the first { and last } (or after : for Python)
    const rawBody = content.slice(sym.byte_start, sym.byte_end);
    let body: string;

    if (language === 'python') {
      // For Python, strip the def line(s) and decorator lines
      const bodyLines = rawBody.split('\n');
      // Find the first line that starts with 'def ' or is the colon-ending line
      let startIdx = 0;
      for (let i = 0; i < bodyLines.length; i++) {
        if (/:\s*(?:#.*)?$/.test(bodyLines[i].trimEnd())) {
          startIdx = i + 1;
          break;
        }
      }
      body = bodyLines.slice(startIdx).join('\n');
    } else {
      // C-like: strip everything up to the first { and after the last }
      const openBrace = rawBody.indexOf('{');
      const closeBrace = rawBody.lastIndexOf('}');
      if (openBrace === -1 || closeBrace === -1 || closeBrace <= openBrace) {
        // No braces — might be an expression body arrow function, skip
        continue;
      }
      body = rawBody.slice(openBrace + 1, closeBrace);
    }

    // Strip comment lines (single-line only — good enough for stub detection)
    const strippedLines = body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .filter((l) => !(/^(?:\/\/|#|--|\/\*|\*\/|\*)\s*$/.test(l)));

    const joined = strippedLines.join('\n');

    // Check if body matches any stub pattern
    const isEmpty = strippedLines.length === 0;
    const isStub = !isEmpty && strippedLines.length <= 2 && STUB_BODY_PATTERNS.some((p) => p.test(joined));

    if (isEmpty || isStub) {
      const description = isEmpty
        ? `Empty ${sym.kind} '${sym.name}' — no implementation`
        : `Stub ${sym.kind} '${sym.name}' — placeholder implementation`;

      findings.push({
        category: 'empty_function',
        priority: isEmpty ? 'medium' : 'low',
        file: filePath,
        line: sym.line_start,
        snippet: (sym.signature ?? lines[sym.line_start - 1]?.trim() ?? sym.name).slice(0, 200),
        description,
        symbol: sym.name,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Hardcoded value detection
// ---------------------------------------------------------------------------

interface HardcodePattern {
  name: string;
  regex: RegExp;
  priority: SmellPriority;
  description: string;
  /** Skip if the line matches any of these (false-positive filters) */
  falsePositives: RegExp[];
}

const HARDCODE_PATTERNS: HardcodePattern[] = [
  // Hardcoded IP addresses (not 127.0.0.1 or 0.0.0.0 which are often intentional)
  {
    name: 'hardcoded_ip',
    regex: /(?<![.\d])(?!(?:127\.0\.0\.1|0\.0\.0\.0|255\.255\.255\.\d+)\b)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?![\d.])/g,
    priority: 'medium',
    description: 'Hardcoded IP address — use configuration or environment variable',
    falsePositives: [
      /version|semver|v\d/i,
      /(?:\/\/|#|--|\/\*)\s*(?:example|e\.g\.|i\.e\.|see|cf\.|docs)/i,
      /(?:test|spec|mock|fixture|seed|sample)/i,
      /0\.0\.0\.0|127\.0\.0\.1|localhost/,
    ],
  },
  // Hardcoded port numbers in connection strings
  {
    name: 'hardcoded_port',
    regex: /(?:port\s*[:=]\s*|:\s*)(\d{4,5})\b/g,
    priority: 'low',
    description: 'Hardcoded port number — use configuration or environment variable',
    falsePositives: [
      /(?:test|spec|mock|fixture)/i,
      /process\.env|os\.environ|getenv|ENV\[|config\./i,
      /(?:\/\/|#)\s*default/i,
      /\.env|\.ya?ml|\.toml|\.ini|\.cfg|Dockerfile|docker-compose/,
    ],
  },
  // Hardcoded URLs (http/https) — likely should be configurable
  {
    name: 'hardcoded_url',
    regex: /(?:['"`])(https?:\/\/(?!(?:localhost|127\.0\.0\.1|example\.com|schemas?\.))[\w.-]+\.\w+[^'"`\s]*?)(?:['"`])/g,
    priority: 'medium',
    description: 'Hardcoded URL — use configuration or environment variable',
    falsePositives: [
      /(?:test|spec|mock|fixture|__tests__)/i,
      /(?:\/\/|#)\s*(?:see|docs|ref|link|source|from|via|credit)/i,
      /schema\.org|json-schema|w3\.org|ietf\.org|creativecommons|spdx\.org/i,
      /swagger|openapi|license|readme|changelog/i,
      /(?:npmjs?|pypi|rubygems|crates|maven|nuget|packagist)\.(?:org|io|dev)/i,
      /github\.com|gitlab\.com|bitbucket\.org/i,
    ],
  },
  // Magic numbers in comparisons, assignments, or returns
  {
    name: 'magic_number',
    regex: /(?:===?\s*|!==?\s*|[<>]=?\s*|return\s+|=\s+)(-?\d{2,}(?:\.\d+)?)\b/g,
    priority: 'low',
    description: 'Magic number — extract to a named constant for readability',
    falsePositives: [
      /(?:test|spec|mock|fixture|__tests__)/i,
      // Common non-magic values
      /(?:===?\s*|!==?\s*|return\s+|=\s+)(?:0|1|2|10|100|1000|200|201|204|301|302|400|401|403|404|409|422|429|500|502|503)\b/,
      /(?:status|code|http|statusCode|response)\s*(?:===?|!==?)/i,
      /(?:length|size|count|index|offset|width|height|margin|padding)\s*(?:===?|!==?|[<>]=?)/i,
      /\.(?:status|code|length|size|indexOf|charCodeAt)\s*(?:===?|!==?)/i,
      /(?:Math\.|parseInt|parseFloat|Number\()/,
      /(?:timeout|delay|interval|duration|ttl|retry|retries|max_|min_|limit)/i,
    ],
  },
  // Hardcoded credentials / secrets patterns (not already caught by security scanner)
  {
    name: 'hardcoded_credential',
    regex: /(?:password|passwd|pwd|secret|api_?key|token|auth)\s*[:=]\s*['"`](?![\s'"`)]{0,2}$)[^'"`\n]{3,}['"`]/gi,
    priority: 'high',
    description: 'Hardcoded credential — use environment variable or secret manager',
    falsePositives: [
      /(?:test|spec|mock|fixture|__tests__|example|sample|dummy|placeholder)/i,
      /process\.env|os\.environ|getenv|ENV\[|config\./i,
      /TODO|FIXME|CHANGEME|REPLACE|PLACEHOLDER|YOUR_/i,
      /(?:schema|type|validation|interface|swagger|openapi)/i,
    ],
  },
  // Hardcoded feature flags / toggles
  {
    name: 'hardcoded_feature_flag',
    regex: /(?:feature|flag|toggle|experiment|beta|enable|disable)[\w_]*\s*[:=]\s*(?:true|false|1|0)\b/gi,
    priority: 'low',
    description: 'Hardcoded feature flag — use a feature flag service or configuration',
    falsePositives: [
      /(?:test|spec|mock|fixture|__tests__)/i,
      /(?:default|fallback|config|schema|type|interface)/i,
      /process\.env|os\.environ|getenv|ENV\[/i,
    ],
  },
];

function detectHardcodedValues(
  lines: string[],
  filePath: string,
): CodeSmellFinding[] {
  const findings: CodeSmellFinding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    for (const pattern of HARDCODE_PATTERNS) {
      const re = new RegExp(pattern.regex.source, pattern.regex.flags);
      re.lastIndex = 0;
      const m = re.exec(line);
      if (!m) continue;

      // Check false positives on line + path
      let isFP = false;
      for (const fp of pattern.falsePositives) {
        if (fp.test(line) || fp.test(filePath)) {
          isFP = true;
          break;
        }
      }
      if (isFP) continue;

      findings.push({
        category: 'hardcoded_value',
        priority: pattern.priority,
        tag: pattern.name,
        file: filePath,
        line: i + 1,
        snippet: line.trim().slice(0, 200),
        description: pattern.description,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Debug artifact detection
// ---------------------------------------------------------------------------

interface DebugPattern {
  name: string;
  languages: Set<string> | null; // null = all languages
  regex: RegExp;
  priority: SmellPriority;
  description: string;
  falsePositives: RegExp[];
}

const JS_LANGS = new Set(['typescript', 'javascript', 'tsx', 'jsx']);
const PY_LANGS = new Set(['python']);
const PHP_LANGS = new Set(['php']);
const RUBY_LANGS = new Set(['ruby']);
const JAVA_LANGS = new Set(['java', 'kotlin', 'scala']);
const CS_LANGS = new Set(['csharp']);
const RUST_LANGS = new Set(['rust']);
const GO_LANGS = new Set(['go']);

const COMMON_FP: RegExp[] = [
  /(?:\/\/|#|--|\/\*|\*)\s*(?:eslint-disable|tslint-disable|noqa|phpcs:ignore|rubocop:disable)/i,
];

const DEBUG_PATTERNS: DebugPattern[] = [
  // JavaScript / TypeScript
  {
    name: 'console_log',
    languages: JS_LANGS,
    regex: /\bconsole\.(?:log|debug|trace|dir|table|group|groupEnd|time|timeEnd|count)\s*\(/g,
    priority: 'medium',
    description: 'Debug console statement — remove before production',
    falsePositives: [
      ...COMMON_FP,
      /(?:logger|log)\.(?:log|debug|trace)/, // real loggers
    ],
  },
  {
    name: 'debugger_statement',
    languages: JS_LANGS,
    regex: /^[^'"`]*?\bdebugger\b\s*;?\s*(?:\/\/.*)?$/,
    priority: 'high',
    description: 'debugger statement left in code',
    falsePositives: [...COMMON_FP, /(?:\/\/|\*)\s*debugger/i],
  },
  {
    name: 'alert_statement',
    languages: JS_LANGS,
    regex: /(?<![.\w])alert\s*\(/g,
    priority: 'low',
    description: 'alert() call — likely a debug leftover',
    falsePositives: [...COMMON_FP, /window\.alert|\.on\(['"`]alert/i],
  },

  // Python
  {
    name: 'pdb_set_trace',
    languages: PY_LANGS,
    regex: /\b(?:pdb|ipdb|pudb|web_pdb|remote_pdb)\.set_trace\s*\(/g,
    priority: 'high',
    description: 'pdb.set_trace() breakpoint left in code',
    falsePositives: COMMON_FP,
  },
  {
    name: 'breakpoint_call',
    languages: PY_LANGS,
    regex: /(?<![.\w])breakpoint\s*\(\s*\)/g,
    priority: 'high',
    description: 'breakpoint() left in code',
    falsePositives: COMMON_FP,
  },
  {
    name: 'import_pdb',
    languages: PY_LANGS,
    regex: /^\s*import\s+(?:pdb|ipdb|pudb)\b/,
    priority: 'medium',
    description: 'Debugger import — remove if no longer needed',
    falsePositives: COMMON_FP,
  },

  // PHP
  {
    name: 'php_var_dump',
    languages: PHP_LANGS,
    regex: /(?<![\w>:])\b(?:var_dump|print_r|var_export)\s*\(/g,
    priority: 'high',
    description: 'PHP debug dump — remove before production',
    falsePositives: COMMON_FP,
  },
  {
    name: 'laravel_dd_dump',
    languages: PHP_LANGS,
    regex: /(?<![\w>:])\b(?:dd|dump|ddd)\s*\(/g,
    priority: 'high',
    description: 'Laravel dd()/dump() — remove before production',
    falsePositives: [
      ...COMMON_FP,
      /(?:function|method|class)\s+(?:dd|dump)\s*\(/i,
    ],
  },
  {
    name: 'php_die_exit',
    languages: PHP_LANGS,
    regex: /(?<![\w>:])\b(?:die|exit)\s*\(\s*(?:['"`]|\d)/g,
    priority: 'medium',
    description: 'die()/exit() with debug argument — review usage',
    falsePositives: [...COMMON_FP, /exit\s*\(\s*0\s*\)/],
  },
  {
    name: 'php_xdebug_break',
    languages: PHP_LANGS,
    regex: /\bxdebug_break\s*\(/g,
    priority: 'high',
    description: 'xdebug_break() breakpoint left in code',
    falsePositives: COMMON_FP,
  },

  // Ruby
  {
    name: 'ruby_pry_irb',
    languages: RUBY_LANGS,
    regex: /\bbinding\.(?:pry|irb|remote_pry|break)\b/g,
    priority: 'high',
    description: 'binding.pry/irb breakpoint left in code',
    falsePositives: COMMON_FP,
  },
  {
    name: 'ruby_byebug',
    languages: RUBY_LANGS,
    regex: /^\s*(?:byebug|debugger)\s*$/,
    priority: 'high',
    description: 'byebug/debugger left in code',
    falsePositives: COMMON_FP,
  },
  {
    name: 'ruby_pp',
    languages: RUBY_LANGS,
    regex: /^\s*pp\s+[^=]/,
    priority: 'low',
    description: 'pp (pretty-print) — likely a debug leftover',
    falsePositives: COMMON_FP,
  },

  // Java / Kotlin / Scala
  {
    name: 'java_print_stacktrace',
    languages: JAVA_LANGS,
    regex: /\.printStackTrace\s*\(\s*\)/g,
    priority: 'medium',
    description: 'printStackTrace() — use a proper logger instead',
    falsePositives: COMMON_FP,
  },
  {
    name: 'java_system_out',
    languages: JAVA_LANGS,
    regex: /\bSystem\.(?:out|err)\.(?:println|print|printf)\s*\(/g,
    priority: 'low',
    description: 'System.out/err println — use a logger in production code',
    falsePositives: [
      ...COMMON_FP,
      /public\s+static\s+void\s+main\s*\(/, // main method can legitimately use stdout
    ],
  },

  // C#
  {
    name: 'cs_console_write',
    languages: CS_LANGS,
    regex: /\bConsole\.(?:Write|WriteLine)\s*\(/g,
    priority: 'low',
    description: 'Console.Write — use a logger in production code',
    falsePositives: [...COMMON_FP, /static\s+void\s+Main\s*\(/],
  },
  {
    name: 'cs_debug_write',
    languages: CS_LANGS,
    regex: /\bDebug\.(?:Write|WriteLine|Print)\s*\(/g,
    priority: 'medium',
    description: 'Debug.Write left in code',
    falsePositives: COMMON_FP,
  },

  // Rust
  {
    name: 'rust_dbg',
    languages: RUST_LANGS,
    regex: /\bdbg!\s*\(/g,
    priority: 'high',
    description: 'dbg!() macro — remove before production',
    falsePositives: COMMON_FP,
  },
  {
    name: 'rust_todo_unimpl',
    languages: RUST_LANGS,
    regex: /\b(?:todo|unimplemented)!\s*\(/g,
    priority: 'medium',
    description: 'todo!() / unimplemented!() macro — placeholder implementation',
    falsePositives: COMMON_FP,
  },

  // Go (conservative — fmt.Println is often legitimate)
  {
    name: 'go_println_debug',
    languages: GO_LANGS,
    regex: /\bfmt\.Println\s*\(\s*['"`](?:DEBUG|TRACE|TODO|HERE|XXX|TEST|\d+|[^'"`\n]*=)/gi,
    priority: 'medium',
    description: 'fmt.Println with debug-like label — remove before production',
    falsePositives: COMMON_FP,
  },
];

function detectDebugArtifacts(
  lines: string[],
  filePath: string,
  language: string,
): CodeSmellFinding[] {
  const findings: CodeSmellFinding[] = [];
  const lang = (language || '').toLowerCase();

  const applicable = DEBUG_PATTERNS.filter((p) => !p.languages || p.languages.has(lang));
  if (applicable.length === 0) return findings;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip pure comment lines quickly — debug artifacts in comments aren't real
    if (/^\s*(?:\/\/|#|--|\*|\/\*)/.test(line)) continue;

    for (const pattern of applicable) {
      const re = new RegExp(pattern.regex.source, pattern.regex.flags);
      re.lastIndex = 0;
      const m = re.exec(line);
      if (!m) continue;

      let isFP = false;
      for (const fp of pattern.falsePositives) {
        if (fp.test(line) || fp.test(filePath)) {
          isFP = true;
          break;
        }
      }
      if (isFP) continue;

      findings.push({
        category: 'debug_artifact',
        priority: pattern.priority,
        tag: pattern.name,
        file: filePath,
        line: i + 1,
        snippet: line.trim().slice(0, 200),
        description: pattern.description,
      });
      break; // one finding per line is enough
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Priority helpers
// ---------------------------------------------------------------------------

const PRIORITY_ORDER: Record<SmellPriority, number> = { high: 0, medium: 1, low: 2 };

function priorityRank(p: SmellPriority): number {
  return PRIORITY_ORDER[p];
}

// ---------------------------------------------------------------------------
// Main scanner
// ---------------------------------------------------------------------------

const BATCH_SIZE = 100;
const MAX_FILE_SIZE = 512 * 1024; // 512 KB

// Documentation / non-code files indexed by trace-mcp that must not be scanned
// for code smells. Markdown headings like `### Bug Fixes` would otherwise match
// the TODO regex (via the `#` comment-delimiter + `BUG` tag).
const NON_CODE_EXTENSIONS = new Set([
  '.md', '.mdx', '.markdown', '.rst', '.adoc', '.asciidoc', '.txt',
]);
const NON_CODE_LANGUAGES = new Set([
  'markdown', 'mdx', 'rst', 'restructuredtext', 'asciidoc', 'text', 'plaintext',
]);

export function scanCodeSmells(
  store: Store,
  projectRoot: string,
  opts: {
    category?: SmellCategory[];
    scope?: string;
    priority_threshold?: SmellPriority;
    include_tests?: boolean;
    tags?: string[];
    limit?: number;
  } = {},
): TraceMcpResult<CodeSmellResult> {
  const categories = new Set(opts.category ?? ALL_CATEGORIES);
  const thresholdRank = priorityRank(opts.priority_threshold ?? 'low');
  const includeTests = opts.include_tests ?? false;
  const tagFilter = opts.tags ? new Set(opts.tags.map((t) => t.toUpperCase())) : null;
  const limit = opts.limit ?? 200;

  // Fetch indexed files
  const scope = opts.scope?.replace(/\/+$/, '');
  const files: { id: number; path: string; language: string }[] = scope
    ? store.db.prepare("SELECT id, path, language FROM files WHERE path LIKE ? AND (status = 'ok' OR status IS NULL)").all(`${scope}%`) as { id: number; path: string; language: string }[]
    : store.db.prepare("SELECT id, path, language FROM files WHERE status = 'ok' OR status IS NULL").all() as { id: number; path: string; language: string }[];

  const allFindings: CodeSmellFinding[] = [];
  let scanned = 0;

  // Pre-fetch symbols for empty function detection (batch by file)
  const needsEmptyFn = categories.has('empty_function');

  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);

    for (const file of batch) {
      // Skip test files unless explicitly included
      if (!includeTests && /\.(?:test|spec)\.|__tests__|\/tests?\//i.test(file.path)) continue;

      // Skip documentation / non-code files — markdown headings and prose
      // trigger false positives across every category.
      const ext = path.extname(file.path).toLowerCase();
      if (NON_CODE_EXTENSIONS.has(ext)) continue;
      if (file.language && NON_CODE_LANGUAGES.has(file.language.toLowerCase())) continue;

      const absPath = path.resolve(projectRoot, file.path);
      let content: string;
      try {
        const buf = readFileSync(absPath);
        if (buf.length > MAX_FILE_SIZE) continue;
        content = buf.toString('utf-8');
      } catch {
        continue;
      }

      scanned++;
      const lines = content.split('\n');

      // 1. TODO comments
      if (categories.has('todo_comment')) {
        const todos = detectTodoComments(lines, file.path);
        for (const f of todos) {
          if (priorityRank(f.priority) > thresholdRank) continue;
          if (tagFilter && f.tag && !tagFilter.has(f.tag)) continue;
          allFindings.push(f);
        }
      }

      // 2. Empty functions
      if (needsEmptyFn) {
        const symbols = store.getSymbolsByFile(file.id) as SymbolRange[];
        const empties = detectEmptyFunctions(content, lines, symbols, file.path, file.language ?? '');
        for (const f of empties) {
          if (priorityRank(f.priority) > thresholdRank) continue;
          allFindings.push(f);
        }
      }

      // 3. Hardcoded values
      if (categories.has('hardcoded_value')) {
        const hardcoded = detectHardcodedValues(lines, file.path);
        for (const f of hardcoded) {
          if (priorityRank(f.priority) > thresholdRank) continue;
          allFindings.push(f);
        }
      }

      // 4. Debug artifacts
      if (categories.has('debug_artifact')) {
        const artifacts = detectDebugArtifacts(lines, file.path, file.language ?? '');
        for (const f of artifacts) {
          if (priorityRank(f.priority) > thresholdRank) continue;
          if (tagFilter && f.tag && !tagFilter.has(f.tag.toUpperCase())) continue;
          allFindings.push(f);
        }
      }
    }
  }

  // Sort: high priority first, then by file
  allFindings.sort((a, b) =>
    priorityRank(a.priority) - priorityRank(b.priority)
    || a.file.localeCompare(b.file)
    || a.line - b.line,
  );

  const summary: Record<SmellCategory, number> = {
    todo_comment: 0,
    empty_function: 0,
    hardcoded_value: 0,
    debug_artifact: 0,
  };
  for (const f of allFindings) {
    summary[f.category]++;
  }

  return ok({
    files_scanned: scanned,
    findings: allFindings.slice(0, limit),
    summary,
    total: allFindings.length,
  });
}
