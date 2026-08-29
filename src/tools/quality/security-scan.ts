/**
 * Security Scanning — OWASP / CWE pattern-based detection.
 *
 * Phase 1: regex pattern matching against indexed file content.
 * Scans files in batches to avoid N+1; no DB queries per-line.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Store } from '../../db/store.js';
import { err, ok, type TraceMcpResult, validationError } from '../../errors.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export type RuleName =
  | 'sql_injection'
  | 'xss'
  | 'command_injection'
  | 'path_traversal'
  | 'hardcoded_secrets'
  | 'insecure_crypto'
  | 'open_redirect'
  | 'ssrf'
  | 'all';

interface SecurityFinding {
  rule_id: string;
  rule_name: string;
  severity: Severity;
  file: string;
  line: number;
  column: number;
  snippet: string;
  fix: string;
  /** Optional diagnostic — populated when a finding survives interpolation analysis. */
  interpolation_source?: 'non_constant';
  /** Optional evidence string (e.g. "auth context: file path") for reviewers. */
  evidence?: string;
  /**
   * Confidence in the finding:
   *   - "high"   — pattern matched and no known safe shape detected,
   *   - "medium" — pattern matched but heuristics suggest a safer shape (downgraded),
   *   - "low"    — weakly grounded, likely false positive but kept for review.
   */
  confidence: 'low' | 'medium' | 'high';
}

export interface SecurityScanResult {
  files_scanned: number;
  findings: SecurityFinding[];
  summary: Record<Severity, number>;
  /**
   * Findings held back because their confidence was "low". Pass
   * `includeLowConfidence: true` to get them in `findings` instead.
   */
  suppressed_low_confidence: number;
}

// ---------------------------------------------------------------------------
// Security rule definitions
// ---------------------------------------------------------------------------

interface SecurityPattern {
  regex: RegExp;
  languages: Set<string>;
}

interface SecurityRule {
  id: string;
  name: string;
  key: RuleName;
  severity: Severity;
  patterns: SecurityPattern[];
  falsePositiveFilters: RegExp[];
  fix: string;
}

const ALL_LANGUAGES = new Set([
  'typescript',
  'javascript',
  'python',
  'php',
  'ruby',
  'java',
  'csharp',
  'go',
  'rust',
  'kotlin',
  'scala',
  'swift',
]);

const JS_TS = new Set(['typescript', 'javascript']);
const PY = new Set(['python']);
const PHP = new Set(['php']);
const RUBY = new Set(['ruby']);
const JAVA = new Set(['java', 'kotlin', 'scala']);
const GO = new Set(['go']);

const RULES: SecurityRule[] = [
  // CWE-89: SQL Injection
  {
    id: 'CWE-89',
    name: 'SQL Injection',
    key: 'sql_injection',
    severity: 'critical',
    patterns: [
      // JS/TS: template literal in query
      { regex: /\.(query|exec|execute|raw|rawQuery)\s*\(\s*`[^`]*\$\{/g, languages: JS_TS },
      // JS/TS: string concatenation in query
      { regex: /\.(query|exec|execute|raw)\s*\(\s*['"][^'"]*['"]\s*\+/g, languages: JS_TS },
      // Python: f-string in execute
      { regex: /\.(execute|executemany|executescript)\s*\(\s*f["']/g, languages: PY },
      // Python: format() in execute
      { regex: /\.(execute|executemany)\s*\(\s*["'][^"']*["']\s*\.format\s*\(/g, languages: PY },
      // Python: % formatting in execute
      { regex: /\.(execute|executemany)\s*\(\s*["'][^"']*%s[^"']*["']\s*%/g, languages: PY },
      // PHP: variable interpolation in query
      { regex: /->query\s*\(\s*["'][^"']*\$[a-zA-Z_]/g, languages: PHP },
      // PHP: concatenation in query
      { regex: /->query\s*\(\s*["'].*\.\s*\$/g, languages: PHP },
      // Ruby: interpolation in query
      { regex: /\.(execute|query|select_all|find_by_sql)\s*\(\s*["'][^"']*#\{/g, languages: RUBY },
      // Java: concatenation in SQL
      {
        regex: /\.(executeQuery|executeUpdate|prepareStatement)\s*\(\s*["'][^"']*["']\s*\+/g,
        languages: JAVA,
      },
      // Go: Sprintf in query
      { regex: /\.(Query|Exec|QueryRow)\s*\(\s*fmt\.Sprintf\s*\(/g, languages: GO },
    ],
    falsePositiveFilters: [
      /parameterized|placeholder|\?\s*,|%s.*prepared/i,
      /prepared\s*statement/i,
      /\.test\.|\.spec\.|__tests__|test_|_test\./,
    ],
    fix: 'Use parameterized queries instead of string interpolation.',
  },

  // CWE-79: Cross-Site Scripting (XSS)
  {
    id: 'CWE-79',
    name: 'Cross-Site Scripting (XSS)',
    key: 'xss',
    severity: 'high',
    patterns: [
      // JS/TS: innerHTML assignment
      { regex: /\.innerHTML\s*=\s*(?!['"]<\/?(?:div|span|p|br)\s*\/?>['"])/g, languages: JS_TS },
      // JS/TS: dangerouslySetInnerHTML
      { regex: /dangerouslySetInnerHTML\s*=\s*\{\s*\{\s*__html\s*:/g, languages: JS_TS },
      // JS/TS: document.write with variable
      { regex: /document\.write\s*\([^)]*(?:\+|`|\$\{)/g, languages: JS_TS },
      // Vue: v-html directive
      { regex: /v-html\s*=\s*["'][^"']+["']/g, languages: JS_TS },
      // PHP: echo without escaping
      { regex: /<\?=\s*\$(?!_SERVER\['REQUEST_METHOD)/g, languages: PHP },
      // PHP: {!! !!} in Blade
      { regex: /\{!!\s*\$[^}]+!!\}/g, languages: PHP },
      // Ruby: raw in ERB
      { regex: /<%=\s*raw\s+/g, languages: RUBY },
      // Python: |safe filter in Jinja
      { regex: /\{\{\s*[^}]+\|\s*safe\s*\}\}/g, languages: PY },
      // Python: mark_safe
      { regex: /mark_safe\s*\(/g, languages: PY },
    ],
    falsePositiveFilters: [
      /DOMPurify|sanitize|escape|htmlspecialchars|strip_tags|bleach/i,
      /\.test\.|\.spec\.|__tests__/,
    ],
    fix: 'Sanitize output using DOMPurify, htmlspecialchars(), or framework escape helpers.',
  },

  // CWE-78: Command Injection
  {
    id: 'CWE-78',
    name: 'Command Injection',
    key: 'command_injection',
    severity: 'critical',
    patterns: [
      // JS/TS: exec/execSync with template literal
      { regex: /(?:exec|execSync|spawnSync)\s*\(\s*`[^`]*\$\{/g, languages: JS_TS },
      // JS/TS: exec with concatenation
      { regex: /(?:exec|execSync)\s*\(\s*['"][^'"]*['"]\s*\+/g, languages: JS_TS },
      // Python: os.system with f-string
      { regex: /os\.(?:system|popen)\s*\(\s*f["']/g, languages: PY },
      // Python: subprocess with shell=True
      { regex: /subprocess\.(?:call|run|Popen)\s*\([^)]*shell\s*=\s*True/g, languages: PY },
      // PHP: exec/system/passthru/shell_exec with variable
      {
        regex: /(?:exec|system|passthru|shell_exec|popen|proc_open)\s*\(\s*\$[a-zA-Z_]/g,
        languages: PHP,
      },
      // PHP: backtick operator with variable
      { regex: /`[^`]*\$[a-zA-Z_][^`]*`/g, languages: PHP },
      // Ruby: system with interpolation
      { regex: /(?:system|exec|%x)\s*(?:\(?\s*)?["'][^"']*#\{/g, languages: RUBY },
      // Go: exec.Command with user input (heuristic)
      { regex: /exec\.Command\s*\(\s*(?:fmt\.Sprintf|[a-z])/g, languages: GO },
    ],
    falsePositiveFilters: [
      /execFile|spawn\s*\(/i, // safe alternatives
      /\.test\.|\.spec\.|__tests__/,
      /shlex\.quote|escapeshellarg|shellescape/i,
      /\bdb\s*\.\s*exec\s*\(/i, // DB-handle .exec() (better-sqlite3, etc.) is not a shell exec API
    ],
    fix: 'Use execFile() with argument arrays, or sanitize/escape shell arguments.',
  },

  // CWE-22: Path Traversal
  {
    id: 'CWE-22',
    name: 'Path Traversal',
    key: 'path_traversal',
    severity: 'high',
    patterns: [
      // JS/TS: path.join with user input (req.params/req.query/req.body)
      {
        regex: /path\.(?:join|resolve)\s*\([^)]*(?:req\.|params\.|query\.|body\.)/g,
        languages: JS_TS,
      },
      // JS/TS: fs operations with template literal
      {
        regex: /fs\.(?:readFile|writeFile|unlink|readdir|stat|access)(?:Sync)?\s*\(\s*`[^`]*\$\{/g,
        languages: JS_TS,
      },
      // Python: open() with user-controlled path
      { regex: /open\s*\(\s*(?:request\.|f["']|os\.path\.join.*request)/g, languages: PY },
      // PHP: file operations with user input
      {
        regex:
          /(?:file_get_contents|fopen|readfile|include|require)\s*\(\s*\$_(?:GET|POST|REQUEST)/g,
        languages: PHP,
      },
    ],
    falsePositiveFilters: [
      /realpath|normalize|sanitize|validate.*path/i,
      /\.test\.|\.spec\.|__tests__/,
    ],
    fix: 'Validate and normalize paths; ensure they stay within the expected directory.',
  },

  // CWE-798: Hardcoded Secrets
  {
    id: 'CWE-798',
    name: 'Hardcoded Secret',
    key: 'hardcoded_secrets',
    severity: 'high',
    patterns: [
      // Generic: API key patterns
      {
        regex: /(?:api[_-]?key|apikey|api[_-]?secret)\s*[:=]\s*['"][a-zA-Z0-9_-]{20,}['"]/gi,
        languages: ALL_LANGUAGES,
      },
      // AWS access key
      { regex: /['"]AKIA[0-9A-Z]{16}['"]/g, languages: ALL_LANGUAGES },
      // Private key inline
      { regex: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g, languages: ALL_LANGUAGES },
      // Generic password assignment
      { regex: /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]{8,}['"]/gi, languages: ALL_LANGUAGES },
      // JWT/Bearer token
      {
        regex: /['"](?:eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,})['"]/g,
        languages: ALL_LANGUAGES,
      },
      // Stripe live key
      { regex: /['"]sk_live_[a-zA-Z0-9]{20,}['"]/g, languages: ALL_LANGUAGES },
      // Generic secret assignment
      {
        regex: /(?:secret|token)\s*[:=]\s*['"][a-zA-Z0-9_\-/+=]{20,}['"]/gi,
        languages: ALL_LANGUAGES,
      },
    ],
    falsePositiveFilters: [
      /process\.env|os\.environ|ENV\[|getenv|env\(|config\(/i,
      /placeholder|example|changeme|xxx|your[_-]?key|replace[_-]?me|todo/i,
      /\.test\.|\.spec\.|__tests__|fixture|mock|fake|dummy/i,
      /\.env\.|\.example|\.sample|\.template/i,
    ],
    fix: 'Move secrets to environment variables or a secrets manager.',
  },

  // CWE-327: Insecure Cryptography
  {
    id: 'CWE-327',
    name: 'Insecure Cryptography',
    key: 'insecure_crypto',
    severity: 'medium',
    patterns: [
      // MD5
      {
        regex: /(?:createHash|MessageDigest\.getInstance|hashlib\.)\s*\(\s*['"]md5['"]/gi,
        languages: ALL_LANGUAGES,
      },
      // SHA1
      {
        regex: /(?:createHash|MessageDigest\.getInstance|hashlib\.)\s*\(\s*['"]sha1?['"]/gi,
        languages: ALL_LANGUAGES,
      },
      // DES
      {
        regex: /(?:createCipher|Cipher\.getInstance)\s*\(\s*['"](?:des|des-ede|rc4)['"]/gi,
        languages: ALL_LANGUAGES,
      },
      // Math.random for crypto
      {
        regex: /Math\.random\s*\(\s*\).*(?:token|key|secret|password|nonce|salt)/gi,
        languages: JS_TS,
      },
      // Python random for crypto
      {
        regex: /random\.(?:random|randint|choice)\s*\(.*(?:token|key|secret|password)/gi,
        languages: PY,
      },
    ],
    falsePositiveFilters: [
      /checksum|etag|cache|hash.*file|content.?hash|fingerprint/i,
      /\.test\.|\.spec\.|__tests__/,
    ],
    fix: 'Use SHA-256+ for hashing, AES-256-GCM for encryption, and crypto.randomBytes for randomness.',
  },

  // CWE-601: Open Redirect
  {
    id: 'CWE-601',
    name: 'Open Redirect',
    key: 'open_redirect',
    severity: 'medium',
    patterns: [
      // JS/TS: redirect with user input
      {
        regex:
          /(?:res\.redirect|redirect|location\.href|window\.location)\s*(?:=|\()\s*(?:req\.|params\.|query\.)/g,
        languages: JS_TS,
      },
      // Python: redirect with request
      { regex: /redirect\s*\(\s*request\.(?:GET|POST|args|form)\s*(?:\.|\.get\()/g, languages: PY },
      // PHP: header Location with user input
      {
        regex: /header\s*\(\s*['"]Location:\s*['"]\s*\.\s*\$_(?:GET|POST|REQUEST)/g,
        languages: PHP,
      },
    ],
    falsePositiveFilters: [
      /allowedUrls|whitelist|safelist|validateUrl|isRelative|startsWith\s*\(\s*['"]\/['"]\)/i,
      /\.test\.|\.spec\.|__tests__/,
    ],
    fix: 'Validate redirect URLs against a whitelist or ensure they are relative paths.',
  },

  // CWE-918: Server-Side Request Forgery (SSRF)
  {
    id: 'CWE-918',
    name: 'Server-Side Request Forgery (SSRF)',
    key: 'ssrf',
    severity: 'high',
    patterns: [
      // JS/TS: fetch/axios with user input
      {
        regex:
          /(?:fetch|axios\.get|axios\.post|got|request)\s*\(\s*(?:req\.|params\.|query\.|body\.|`[^`]*\$\{)/g,
        languages: JS_TS,
      },
      // Python: requests with user input
      {
        regex: /requests\.(?:get|post|put|delete|patch)\s*\(\s*(?:request\.|f["'])/g,
        languages: PY,
      },
      // PHP: file_get_contents/curl with user input
      { regex: /(?:file_get_contents|curl_init)\s*\(\s*\$_(?:GET|POST|REQUEST)/g, languages: PHP },
      // Java: URL connection with user input
      { regex: /new\s+URL\s*\(\s*(?:request\.getParameter|params\.get)/g, languages: JAVA },
    ],
    falsePositiveFilters: [
      /allowedHosts|whitelist|validateUrl|isAllowed/i,
      /\.test\.|\.spec\.|__tests__/,
    ],
    fix: 'Validate and restrict target URLs; use allowlists for permitted hosts.',
  },
];

// ---------------------------------------------------------------------------
// Light reaching-defs: resolve template-literal interpolations to constants
// ---------------------------------------------------------------------------

/**
 * Resolve an identifier in a file to a literal string by scanning upward
 * for a top-level `const X = '...'` / `let X = "..."` / `var X = \`...\``
 * binding. Only matches single-string RHS (no interpolation, no concat).
 *
 * Returns the literal string value (without quotes) or null when:
 * - identifier is reassigned or shadowed,
 * - RHS contains interpolation `${...}`, concatenation `+`, or a call,
 * - identifier is a function parameter (we cannot prove constness),
 * - binding is not found in the file.
 */
function resolveStringBindingInFile(
  lines: string[],
  ident: string,
  fromLine: number,
): string | null {
  // Walk backward from fromLine to line 0 looking for a const/let/var binding.
  const constRe = new RegExp(
    `^\\s*(?:export\\s+)?(?:const|let|var)\\s+${ident}\\s*(?::[^=]+)?=\\s*(['"\`])([^'"\`\\n]*?)\\1\\s*;?\\s*$`,
  );
  const interpolatedRhsRe = new RegExp(
    `^\\s*(?:export\\s+)?(?:const|let|var)\\s+${ident}\\s*[:=].*[\\$\\{\\+]`,
  );
  // Search the entire file (not just upward) — bindings can appear below in TS due to hoisting at module scope.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = constRe.exec(line);
    if (m) return m[2];
    if (i !== fromLine && interpolatedRhsRe.test(line)) {
      // Identifier is bound to a non-literal expression — cannot prove constness.
      return null;
    }
  }
  return null;
}

/**
 * Hostnames considered safe SSRF targets — internal services or well-known SDK bases.
 */
const SSRF_HOST_SAFELIST = new Set<string>([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  'api.anthropic.com',
  'api.openai.com',
  'api.cohere.ai',
  'api.voyageai.com',
  'api.mistral.ai',
  'api.groq.com',
  'generativelanguage.googleapis.com',
]);

function extractHostFromUrl(url: string): string | null {
  // Strip protocol; tolerate template literals where the host portion is literal.
  const stripped = url.replace(/^https?:\/\//i, '');
  const slashIdx = stripped.indexOf('/');
  const portIdx = stripped.indexOf(':');
  const end = [slashIdx, portIdx].filter((x) => x >= 0).sort((a, b) => a - b)[0];
  const host = (end != null ? stripped.slice(0, end) : stripped).trim().toLowerCase();
  if (!host || host.includes('${') || host.includes('$_')) return null;
  return host;
}

/**
 * Build a "candidate URL string" by substituting resolved interpolations into a
 * template-literal-shaped fragment of `line`. Returns null when any unresolved
 * `${...}` remains, otherwise returns the concatenated literal.
 */
function buildResolvedUrl(line: string, lines: string[], fromLine: number): string | null {
  // Pull the first backtick string from the line.
  const tickMatch = /`([^`]*)`/.exec(line);
  if (!tickMatch) return null;
  const tick = tickMatch[1];
  let out = '';
  let i = 0;
  while (i < tick.length) {
    if (tick[i] === '$' && tick[i + 1] === '{') {
      const end = tick.indexOf('}', i + 2);
      if (end === -1) return null;
      const expr = tick.slice(i + 2, end).trim();
      // Only accept bare identifiers.
      const idMatch = /^([A-Za-z_$][\w$]*)$/.exec(expr);
      if (!idMatch) return null;
      const resolved = resolveStringBindingInFile(lines, idMatch[1], fromLine);
      if (resolved == null) return null;
      out += resolved;
      i = end + 1;
    } else {
      out += tick[i];
      i++;
    }
  }
  return out;
}

/**
 * Decide whether a template-literal interpolation should be treated as a
 * compile-time constant for `command_injection`. Returns:
 *  - "constant" when every `${...}` resolves to a literal string,
 *  - "non_constant" otherwise.
 */
function classifyInterpolation(
  line: string,
  lines: string[],
  fromLine: number,
): 'constant' | 'non_constant' {
  const exprs = extractInterpolatedExprs(line);
  if (exprs.length === 0) return 'non_constant';
  for (const expr of exprs) {
    if (!isCompileTimeConstant(expr, lines, fromLine)) return 'non_constant';
  }
  return 'constant';
}

/** Module-location built-ins — fixed at build time, never attacker-controlled. */
const BUILD_TIME_IDENT_RE = /^(?:__dirname|__filename|import\.meta\.(?:dirname|filename|url))$/;

/**
 * True when `expr` evaluates to a value fixed at build time: a string literal,
 * `__dirname`/`__filename`, an identifier bound to a string literal, or a
 * `path.join`/`path.resolve` over those.
 */
function isCompileTimeConstant(expr: string, lines: string[], fromLine: number): boolean {
  const e = expr.trim();
  if (STRING_LITERAL_RE.test(e)) return true;
  if (BUILD_TIME_IDENT_RE.test(e)) return true;

  const call = /^(?:path\.)?(?:join|resolve|normalize)\s*\((.*)\)$/s.exec(e);
  if (call) {
    const args = call[1].trim();
    if (args === '') return true;
    // Bail on nested calls — splitting their arguments needs a real parser.
    if (/[A-Za-z_$][\w$.]*\s*\(/.test(args)) return false;
    return args.split(',').every((a) => isCompileTimeConstant(a, lines, fromLine));
  }

  const head = /^([A-Za-z_$][\w$]*)$/.exec(e);
  if (!head) return false;
  return resolveStringBindingInFile(lines, head[1], fromLine) != null;
}

/**
 * Decide whether an `insecure_crypto` SHA-1/MD5 finding is in a security-adjacent
 * context. Returns true when it should be reported.
 *
 * Heuristic — flag when:
 * - the file path contains a credential-related keyword
 *   (auth/password/token/signing/signature/hmac/secret/login/credential), OR
 * - the surrounding context calls a comparison/equality helper
 *   (compare/equals/timingSafeEqual/verify/validate) on the hash.
 *
 * Otherwise the hash is treated as content-addressable / cache-key and DROPPED.
 */
const SECURITY_PATH_KEYWORDS =
  /(?:auth|password|token|signing|signature|hmac|secret|login|credential|jwt|session|cookie|cipher|encrypt|decrypt)/i;
const SECURITY_USAGE_KEYWORDS =
  /(?:compare|equals|timingSafeEqual|verify|validate|authenticate)\s*\(/i;

function isWeakHashSecurityContext(
  filePath: string,
  contextWindow: string,
): {
  ok: boolean;
  evidence: string;
} {
  if (SECURITY_PATH_KEYWORDS.test(filePath)) {
    return { ok: true, evidence: `file path matches security keyword` };
  }
  if (SECURITY_USAGE_KEYWORDS.test(contextWindow)) {
    return { ok: true, evidence: `hash output used in equality/verify call` };
  }
  return { ok: false, evidence: '' };
}

// ---------------------------------------------------------------------------
// Comment stripper (lossy on comments, preserves strings + line count)
// ---------------------------------------------------------------------------

/**
 * Replace comment contents with spaces while preserving string literals and
 * line numbering. Returns an array parallel to the original lines.
 *
 * Handles:
 *  - C-style `// line comments` to end-of-line.
 *  - C-style `/* block comments *\/` across multiple lines.
 *  - Single, double, and backtick strings (with backslash escapes).
 *
 * Backticks: nested `${...}` may itself contain backticks; we do not recurse,
 * but we treat the outer backtick as a normal string scope, which is enough for
 * comment skipping. String contents are preserved verbatim so regex detectors
 * that target string literals (SQL, exec, fetch URLs) keep working.
 *
 * Regex literals are recognised and skipped whole. Without this a pattern such
 * as /['"`]/ leaves the scanner stuck in "inside a string" state for the rest of
 * the file, so every later comment survives stripping and can raise a finding.
 */

/** Tokens after which a `/` starts a regex literal rather than a division. */
const REGEX_PRECEDING_KEYWORD =
  /(?:^|[^\w$.])(?:return|typeof|case|in|of|do|else|yield|await|new|delete|void|instanceof)\s*$/;

/**
 * Scan a regex literal starting at `source[start] === '/'`. Returns the index
 * just past the closing delimiter and its flags, or -1 when the literal does not
 * terminate on the same line (in which case the `/` was a division operator).
 */
function scanRegexLiteral(source: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\n') return -1;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
    } else if (ch === '[') {
      inClass = true;
    } else if (ch === '/') {
      i++;
      while (i < source.length && /[a-z]/.test(source[i])) i++;
      return i;
    }
    i++;
  }
  return -1;
}

function stripCommentsKeepStrings(source: string): string {
  const len = source.length;
  const out: string[] = new Array(len);
  let i = 0;
  let inLine = false;
  let inBlock = false;
  let stringDelim: string | null = null;
  /** Last non-whitespace character emitted outside comments/strings. */
  let prev = '';
  let prevIdx = -1;
  while (i < len) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLine) {
      // Drop comment chars but keep newline.
      out[i] = ch === '\n' ? '\n' : ' ';
      if (ch === '\n') inLine = false;
      i++;
      continue;
    }

    if (inBlock) {
      if (ch === '*' && next === '/') {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
        inBlock = false;
        continue;
      }
      out[i] = ch === '\n' ? '\n' : ' ';
      i++;
      continue;
    }

    if (stringDelim !== null) {
      out[i] = ch;
      if (ch === '\\' && i + 1 < len) {
        out[i + 1] = source[i + 1];
        i += 2;
        continue;
      }
      if (ch === stringDelim) {
        stringDelim = null;
      }
      i++;
      continue;
    }

    // Not inside a comment or string.
    if (ch === '/' && next === '/') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      inLine = true;
      continue;
    }
    if (ch === '/' && next === '*') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      inBlock = true;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      stringDelim = ch;
      out[i] = ch;
      prev = ch;
      prevIdx = i;
      i++;
      continue;
    }
    if (ch === '/') {
      // Regex literal vs. division: a `/` can only start a regex where an
      // expression may start — after an operator, an opening bracket, a
      // statement separator, or one of the keywords above.
      const isRegexStart =
        prevIdx === -1 ||
        '(,=:[!&|?{};+-*%~^<>'.includes(prev) ||
        REGEX_PRECEDING_KEYWORD.test(source.slice(Math.max(0, prevIdx - 12), prevIdx + 1));
      if (isRegexStart) {
        const end = scanRegexLiteral(source, i);
        if (end !== -1) {
          for (let k = i; k < end; k++) out[k] = source[k];
          prev = '/';
          prevIdx = end - 1;
          i = end;
          continue;
        }
      }
    }
    out[i] = ch;
    if (!/\s/.test(ch)) {
      prev = ch;
      prevIdx = i;
    }
    i++;
  }
  return out.join('');
}

// ---------------------------------------------------------------------------
// Safe-shape detectors (used to drop/downgrade common FP shapes)
// ---------------------------------------------------------------------------

/**
 * Local-path roots commonly used to anchor `path.resolve(root, x)` against a
 * known directory. Path Traversal findings whose first argument is one of these
 * identifiers are downgraded — the resolved path is still bound to `root`'s
 * tree (the caller is expected to validate that staying-within-root via
 * realpath/normalize, but this is the SAFE pattern, not the dangerous one).
 */
const PATH_ROOT_ANCHORS = new Set<string>([
  'projectRoot',
  'projectDir',
  'absRoot',
  'workspaceRoot',
  'cwd',
  '__dirname',
  'baseDir',
  'rootDir',
]);

/**
 * Identifier names commonly used to hold a hardcoded `http://localhost:N` /
 * `http://127.0.0.1:N` URL base. SSRF findings whose interpolated base resolves
 * to such a literal are downgraded.
 */
const SSRF_BASE_IDENT_RE = /^(?:BASE|API|URL|BASE_URL|API_BASE|baseUrl|daemonUrl|url|base|api)$/i;

const LOCAL_URL_LITERAL_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?/i;

// ---------------------------------------------------------------------------
// Backward guard scan — a validator a few lines above the sink
// ---------------------------------------------------------------------------

/** How far above a sink to look for a guard before giving up. */
const GUARD_WINDOW = 40;

/**
 * A line that opens a function/method body — the top of the block we scan.
 * Control-flow braces (`if`, `try`, `for`, …) do NOT stop the walk: a guard
 * normally sits above them, at the top of the enclosing function.
 */
const BLOCK_OPENER_RE =
  /\bfunction\b|=>\s*\{|^\s*(?:(?:export|public|private|protected|static|async|readonly)\s+)*(?!if\b|for\b|while\b|switch\b|catch\b|do\b|return\b)[A-Za-z_$][\w$]*\s*\([^)]*\)\s*(?::[^={]*)?\{\s*$/;

/** `assertFoo(x)` / `invariant(x)` — a validator that throws on bad input. */
const ASSERT_CALL_RE = /\b(?:assert|invariant|ensure|require|validate|check)[A-Za-z_$]*\s*\(/;

/** A conditional that exits the block — `if (...) return|throw|continue`. */
const EXIT_RE = /\b(?:return|throw|continue|process\.exit)\b/;

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract the full expression of each `${...}` interpolation on `line`.
 * Only dotted identifier chains are returned (`this.table`, `pid`, `n.id`);
 * anything else (a call, an operator expression) yields the raw trimmed text.
 */
function extractInterpolatedExprs(line: string): string[] {
  const exprs: string[] = [];
  for (let i = 0; i < line.length - 1; i++) {
    if (line[i] !== '$' || line[i + 1] !== '{') continue;
    let depth = 1;
    let j = i + 2;
    while (j < line.length && depth > 0) {
      if (line[j] === '{') depth++;
      else if (line[j] === '}') depth--;
      if (depth === 0) break;
      j++;
    }
    if (depth !== 0) break;
    exprs.push(line.slice(i + 2, j).trim());
    i = j;
  }
  return exprs;
}

/**
 * Walk backwards from `fromLine` through the enclosing block looking for a
 * validator applied to `expr`. Recognised shapes:
 *   - `assertSafeX(expr)` / `validateX(expr)` — a throwing assertion,
 *   - `if (... expr ...) return|throw|continue` — an early-exit guard.
 *
 * Heuristic by design: it proves a developer checked this value on this path,
 * not that the check is sufficient. Used to suppress findings, never to raise
 * severity.
 */
function hasGuardAbove(lines: string[], fromLine: number, expr: string): boolean {
  if (!/^[A-Za-z_$][\w$]*(?:\.[\w$]+)*$/.test(expr)) return false;
  const mention = new RegExp(`(?:^|[^\\w$.])${escapeForRegex(expr)}(?![\\w$])`);
  const stop = Math.max(0, fromLine - GUARD_WINDOW);
  for (let i = fromLine - 1; i >= stop; i--) {
    const line = lines[i];
    if (mention.test(line)) {
      if (ASSERT_CALL_RE.test(line)) return true;
      // `if (...)` whose body exits — on the same line or the next two.
      if (/\bif\s*\(/.test(line)) {
        const tail = lines.slice(i, Math.min(lines.length, i + 3)).join('\n');
        if (EXIT_RE.test(tail)) return true;
      }
    }
    if (BLOCK_OPENER_RE.test(line)) break;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Origin classification — config-derived values are not remote input
// ---------------------------------------------------------------------------

/** Roots that mean "the operator's own configuration", not remote input. */
const CONFIG_ROOT_RE = /^(?:this\.|self\.)?(?:cfg|config|settings|options|opts|env|process)\b/;

/** Tokens that mark a value as reaching the process from outside. */
const UNTRUSTED_TOKEN_RE = /\b(?:req|request|body|params|query|argv|stdin|payload|incoming)\b/;

/**
 * True when `expr` is a call whose every argument is a string literal or a
 * config-rooted member access — e.g. `modelUrl(this.cfg, this.model, 'x')`.
 */
function isConfigDerivedCall(expr: string): boolean {
  const m = /^[A-Za-z_$][\w$]*(?:\.[\w$]+)*\s*\((.*)\)$/s.exec(expr);
  if (!m) return false;
  const args = m[1].trim();
  if (args === '') return true;
  if (args.includes('(') || args.includes(')')) return false; // nested calls — give up
  return args.split(',').every((raw) => {
    const arg = raw.trim();
    if (/^(['"`]).*\1$/.test(arg)) return true;
    if (UNTRUSTED_TOKEN_RE.test(arg)) return false;
    return CONFIG_ROOT_RE.test(arg) || /^this\.[\w$.]+$/.test(arg);
  });
}

/**
 * True when `expr` is a `for (const expr of ARR)` loop variable whose array is
 * declared locally in the same file and carries no untrusted-source token.
 */
function isLocalLoopVariable(lines: string[], fromLine: number, expr: string): boolean {
  if (!/^[A-Za-z_$][\w$]*$/.test(expr)) return false;
  const loopRe = new RegExp(
    `for\\s*\\(\\s*(?:const|let|var)\\s+${escapeForRegex(expr)}\\s+of\\s+([A-Za-z_$][\\w$.]*)`,
  );
  const stop = Math.max(0, fromLine - GUARD_WINDOW);
  for (let i = fromLine; i >= stop; i--) {
    const m = loopRe.exec(lines[i]);
    if (!m) continue;
    const arr = m[1].split('.')[0];
    if (UNTRUSTED_TOKEN_RE.test(m[1])) return false;
    const declRe = new RegExp(`(?:const|let|var)\\s+${escapeForRegex(arr)}\\s*(?::[^=]+)?=(.*)$`);
    for (let j = 0; j < lines.length; j++) {
      const d = declRe.exec(lines[j]);
      if (d) return !UNTRUSTED_TOKEN_RE.test(d[1]);
    }
    return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Escaper recognition
// ---------------------------------------------------------------------------

/**
 * A whole-expression string literal. Each quote style is matched against its own
 * delimiter, so `'<span style="x">'` — a single-quoted string carrying double
 * quotes — still counts as a literal.
 */
const STRING_LITERAL_RE = /^(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`$\\]|\\.)*`)$/;

/** A call whose name marks it as an output escaper for its argument. */
const ESCAPER_CALL_RE =
  /^(?:[A-Za-z_$][\w$]*\.)*(?:esc|escape|escapeHtml|escapeHTML|htmlEscape|sanitize|sanitise|sanitizeHtml|DOMPurify|encodeURI|encodeURIComponent|htmlspecialchars)[A-Za-z_$]*\s*\(/;

/**
 * Split a JS expression on top-level `+`, ignoring `+` inside strings,
 * parentheses, brackets, or template interpolations.
 */
function splitTopLevelConcat(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let delim: string | null = null;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (delim) {
      if (ch === '\\') i++;
      else if (ch === delim) delim = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') delim = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === '+' && depth === 0) {
      parts.push(expr.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(expr.slice(start).trim());
  return parts.filter((p) => p !== '');
}

/** True when every operand of a concatenation is a literal or an escaper call. */
function isFullyEscapedConcat(expr: string): boolean {
  const parts = splitTopLevelConcat(expr);
  if (parts.length === 0) return false;
  for (const part of parts) {
    if (STRING_LITERAL_RE.test(part)) continue;
    if (ESCAPER_CALL_RE.test(part)) continue;
    // A parenthesised ternary whose branches are all safe — e.g.
    // `(n.repo ? '<b>' + esc(n.repo) + '</b>' : '')`.
    const ternary = /^\((.*)\)$/s.exec(part);
    if (ternary) {
      const q = ternary[1].indexOf('?');
      if (q !== -1) {
        const branches = ternary[1].slice(q + 1);
        const colon = splitTernaryBranches(branches);
        if (colon && colon.every((b) => isFullyEscapedConcat(b.trim()))) continue;
      }
    }
    return false;
  }
  return true;
}

/** Split `a : b` of a ternary tail on the top-level `:`. */
function splitTernaryBranches(tail: string): [string, string] | null {
  let depth = 0;
  let delim: string | null = null;
  for (let i = 0; i < tail.length; i++) {
    const ch = tail[i];
    if (delim) {
      if (ch === '\\') i++;
      else if (ch === delim) delim = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') delim = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ':' && depth === 0) return [tail.slice(0, i), tail.slice(i + 1)];
  }
  return null;
}

/** Identify XSS `innerHTML = ...` shapes that are safe by construction. */
function classifyInnerHtmlAssignment(
  line: string,
  lines?: string[],
  fromLine?: number,
): { safe: true } | { safe: false; confidence: 'high' | 'medium' } {
  // Extract the RHS after `innerHTML =`, continuing across lines until the
  // statement terminates — the assignment is commonly a multi-line concat.
  const m = /\.innerHTML\s*=\s*(.+?);?\s*$/.exec(line);
  if (!m) return { safe: false, confidence: 'high' };
  let rhs = m[1].trim();
  if (lines && fromLine != null && !/;\s*$/.test(line)) {
    for (let i = fromLine + 1; i < Math.min(lines.length, fromLine + 15); i++) {
      const cont = lines[i];
      rhs += ` ${cont.trim().replace(/;\s*$/, '')}`;
      if (/;\s*$/.test(cont.trimEnd())) break;
      if (cont.trim() === '' || /^\s*\}/.test(cont)) break;
    }
    rhs = rhs.trim();
  }

  // Every non-literal operand of the concatenation passes through an escaper.
  if (isFullyEscapedConcat(rhs)) return { safe: true };

  // Literal-only string (no interpolation, no concat).
  // Examples: innerHTML = '', innerHTML = "<div></div>", innerHTML = `static`.
  if (STRING_LITERAL_RE.test(rhs)) return { safe: true };

  // Sanitizer call on the immediate RHS (covers `esc(x)`, `DOMPurify.sanitize(x)`,
  // `encodeURI(x)`, `encodeURIComponent(x)`).
  if (
    /^(?:[A-Za-z_$][\w$]*\.)*(?:esc|sanitize|DOMPurify|escapeHtml|encodeURI|encodeURIComponent)\s*\(/.test(
      rhs,
    )
  ) {
    return { safe: true };
  }

  return { safe: false, confidence: 'high' };
}

/**
 * Classify a Path Traversal finding. Returns:
 *  - { drop: true } when the call is clearly a safe path-join against a known root
 *  - { drop: false, downgrade: true } when the first argument is a known root
 *    anchor (still flagged but at lower severity for review),
 *  - { drop: false, downgrade: false } otherwise.
 */
function classifyPathResolve(line: string): { drop: true } | { drop: false; downgrade: boolean } {
  // Capture the first argument identifier of path.join/path.resolve.
  const m = /path\.(?:join|resolve)\s*\(\s*([A-Za-z_$][\w$]*)\s*,/.exec(line);
  if (!m) return { drop: false, downgrade: false };
  if (PATH_ROOT_ANCHORS.has(m[1])) return { drop: false, downgrade: true };
  return { drop: false, downgrade: false };
}

/**
 * Classify an SSRF `fetch(\`${X}/...\`)` shape. Returns "local" when the
 * interpolated base ident is bound to a localhost URL literal, "downgrade"
 * when the base ident matches the SSRF_BASE_IDENT pattern but cannot be
 * resolved, otherwise null (no special treatment).
 */
function classifySsrfTemplate(
  line: string,
  lines: string[],
  fromLine: number,
): 'local' | 'fixed_authority' | 'config' | 'downgrade' | null {
  if (hasFixedAuthority(line, lines, fromLine)) return 'fixed_authority';
  const exprs = extractInterpolatedExprs(line);
  // Pull the first ${IDENT} in the line.
  const m = /\$\{\s*([A-Za-z_$][\w$]*)\s*\}/.exec(line);
  if (m) {
    const ident = m[1];
    const resolved = resolveStringBindingInFile(lines, ident, fromLine);
    if (resolved && LOCAL_URL_LITERAL_RE.test(resolved)) return 'local';
    if (SSRF_BASE_IDENT_RE.test(ident)) return 'downgrade';
  }
  if (exprs.length > 0 && exprs.every((e) => isConfigDerivedCall(e) || CONFIG_ROOT_RE.test(e))) {
    return 'config';
  }
  return null;
}

/**
 * True when the URL's authority (scheme + host + port) is fully determined
 * before the first interpolation, so no interpolated value can redirect the
 * request to another host. Two shapes qualify:
 *
 *   fetch(`https://api.example.com/v1/${id}`)   — literal host, `/` before ${
 *   fetch(`${BASE_URL}/v1/${id}`)               — BASE_URL resolves to a URL
 *                                                 literal and `/` follows `}`
 *
 * `fetch(\`https://\${host}/x\`)` and `fetch(\`\${BASE}.evil.com\`)` do NOT
 * qualify — the interpolation reaches the authority.
 */
function hasFixedAuthority(line: string, lines: string[], fromLine: number): boolean {
  const tick = /`([^`]*)`/.exec(line);
  if (!tick) return false;
  const tpl = tick[1];
  const first = tpl.indexOf('${');
  if (first === -1) return false;

  // Case 1: the template starts with a literal scheme://host/ prefix.
  if (/^https?:\/\/[^${\s/?#]+[/?#]/.test(tpl.slice(0, first + 2))) return true;

  // Case 2: the template opens with ${IDENT} bound to a URL literal, and the
  // character right after the closing brace closes the authority.
  if (first !== 0) return false;
  const close = tpl.indexOf('}');
  if (close === -1) return false;
  const ident = tpl.slice(2, close).trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(ident)) return false;
  const resolved = resolveStringBindingInFile(lines, ident, fromLine);
  if (!resolved || !/^https?:\/\/[^/]+/.test(resolved)) return false;
  const after = tpl[close + 1] ?? '';
  return resolved.endsWith('/') || after === '/' || after === '?' || after === '#' || after === '';
}

/**
 * Identify low-risk command_injection shapes. Returns one of:
 *  - "open"     — GUI file-open commands (open/xdg-open/start) with a path arg,
 *  - "which"    — `which X` lookup (read-only PATH probe),
 *  - "taskkill" — Windows `taskkill /PID X` with a numeric/pid-bound arg,
 *  - null       — no known safe shape.
 */
function classifyCommandInjection(
  line: string,
  lines: string[],
  fromLine: number,
): 'open' | 'which' | 'taskkill' | null {
  // Match fixed-verb GUI openers.
  if (/(?:exec|execSync|spawnSync)\s*\(\s*`(?:open|xdg-open|start "")\s+/.test(line)) {
    return 'open';
  }
  // `which X` — argument controls only which binary is looked up.
  if (/(?:exec|execSync|spawnSync)\s*\(\s*`which\s+\$\{/.test(line)) return 'which';
  // `taskkill /PID X` — check whether the interpolated value is a numeric literal,
  // or bound to one of `pid` / `process.pid` / `child.pid` in the same function.
  const tk =
    /(?:exec|execSync|spawnSync)\s*\(\s*`taskkill\s+\/PID\s+\$\{\s*([A-Za-z_$][\w$.]*)\s*\}/.exec(
      line,
    );
  if (tk) {
    const ident = tk[1];
    if (/^(?:process\.pid|child\.pid)$/.test(ident)) return 'taskkill';
    if (/^-?\d+$/.test(ident)) return 'taskkill';
    // Look upward in the same file for `const ident = readDaemonPid()` or
    // a numeric assignment — pragmatic heuristic.
    const headIdent = ident.split('.')[0];
    const pidAssignRe = new RegExp(
      `(?:const|let|var)\\s+${headIdent}\\b[^=]*=\\s*(?:readDaemonPid|process\\.pid|child\\.pid|\\d+|.+\\.pid\\b)`,
    );
    for (let i = 0; i < lines.length; i++) {
      if (i === fromLine) continue;
      if (pidAssignRe.test(lines[i])) return 'taskkill';
    }
  }
  return null;
}

/**
 * Lower severity by one step.
 */
function downgradeSeverity(s: Severity): Severity {
  if (s === 'critical') return 'high';
  if (s === 'high') return 'medium';
  if (s === 'medium') return 'low';
  return 'low';
}

// ---------------------------------------------------------------------------
// Pre-compute a lookup map for O(1) rule selection
// ---------------------------------------------------------------------------

const RULE_BY_KEY = new Map<string, SecurityRule[]>();
for (const rule of RULES) {
  const arr = RULE_BY_KEY.get(rule.key) ?? [];
  arr.push(rule);
  RULE_BY_KEY.set(rule.key, arr);
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

const BATCH_SIZE = 100;
const MAX_FILE_SIZE = 512 * 1024; // 512 KB — skip larger files

function resolveRules(ruleNames: RuleName[]): SecurityRule[] {
  if (ruleNames.includes('all')) return RULES;
  const result: SecurityRule[] = [];
  const seen = new Set<string>();
  for (const name of ruleNames) {
    const rules = RULE_BY_KEY.get(name);
    if (rules) {
      for (const r of rules) {
        if (!seen.has(r.id)) {
          seen.add(r.id);
          result.push(r);
        }
      }
    }
  }
  return result;
}

function severityRank(s: Severity): number {
  return s === 'critical' ? 4 : s === 'high' ? 3 : s === 'medium' ? 2 : 1;
}

/**
 * Scan indexed files for security vulnerabilities using pattern matching.
 * Reads files in batches from disk (no N+1). Skips test files and files
 * above MAX_FILE_SIZE.
 */
export function scanSecurity(
  store: Store,
  projectRoot: string,
  opts: {
    scope?: string;
    rules: RuleName[];
    severityThreshold?: Severity;
    /** Report findings whose confidence is "low" (default: false). */
    includeLowConfidence?: boolean;
  },
): TraceMcpResult<SecurityScanResult> {
  const activeRules = resolveRules(opts.rules);
  if (activeRules.length === 0) {
    return err(validationError('No valid rules specified'));
  }

  const thresholdRank = severityRank(opts.severityThreshold ?? 'low');

  // Fetch file list from DB (already indexed)
  const scope = opts.scope?.replace(/\/+$/, '');
  const files: { path: string; language: string }[] = scope
    ? (store.db
        .prepare(
          "SELECT path, language FROM files WHERE path LIKE ? AND (status = 'ok' OR status IS NULL)",
        )
        .all(`${scope}%`) as { path: string; language: string }[])
    : (store.db
        .prepare("SELECT path, language FROM files WHERE status = 'ok' OR status IS NULL")
        .all() as { path: string; language: string }[]);

  const findings: SecurityFinding[] = [];
  let scanned = 0;

  // Process in batches
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);

    for (const file of batch) {
      // Skip test files
      if (/\.(?:test|spec)\.|__tests__|\/tests?\//i.test(file.path)) continue;

      const absPath = path.resolve(projectRoot, file.path);
      let content: string;
      try {
        const buf = readFileSync(absPath);
        if (buf.length > MAX_FILE_SIZE) continue;
        content = buf.toString('utf-8');
      } catch {
        continue; // File deleted since indexing, or unreadable
      }

      scanned++;
      const rawLines = content.split('\n');
      // Strip comments for languages where stripping is safe (C-style: //, /* */).
      // We keep the original raw lines for snippet display, but run pattern
      // matching against the stripped variant so JSDoc examples and `//` notes
      // never trigger a finding.
      const stripped =
        file.language === 'typescript' ||
        file.language === 'javascript' ||
        file.language === 'java' ||
        file.language === 'kotlin' ||
        file.language === 'scala' ||
        file.language === 'csharp' ||
        file.language === 'go' ||
        file.language === 'rust' ||
        file.language === 'swift' ||
        file.language === 'php'
          ? stripCommentsKeepStrings(content)
          : content;
      const lines = stripped.split('\n');

      for (const rule of activeRules) {
        if (severityRank(rule.severity) < thresholdRank) continue;

        for (const pattern of rule.patterns) {
          if (!pattern.languages.has(file.language)) continue;

          // Reset regex state for each file
          const re = new RegExp(pattern.regex.source, pattern.regex.flags);

          for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
            const line = lines[lineIdx];
            // Skip lines blanked by comment stripping (all-whitespace).
            if (line.trim() === '') continue;
            re.lastIndex = 0;
            const match = re.exec(line);
            if (!match) continue;

            const snippet = (rawLines[lineIdx] ?? line).trim();

            // Check false positive filters on the line + surrounding context
            const contextWindow = lines
              .slice(Math.max(0, lineIdx - 2), Math.min(lines.length, lineIdx + 3))
              .join('\n');

            let isFalsePositive = false;
            for (const fp of rule.falsePositiveFilters) {
              if (fp.test(contextWindow) || fp.test(file.path)) {
                isFalsePositive = true;
                break;
              }
            }
            if (isFalsePositive) continue;

            // Light reaching-defs: for rules driven by `${var}` interpolation
            // (command_injection, ssrf, and SQL via template literals), DROP
            // the finding when every interpolation resolves to a literal const
            // binding in the same file.
            let interpolationSource: 'non_constant' | undefined;
            const usesTemplate = /\$\{/.test(line);

            // Backward guard scan: drop when every interpolated value is
            // validated by an assertion or an early-exit check above the sink.
            if (
              usesTemplate &&
              (rule.key === 'sql_injection' ||
                rule.key === 'path_traversal' ||
                rule.key === 'command_injection' ||
                rule.key === 'ssrf')
            ) {
              const exprs = extractInterpolatedExprs(line);
              if (exprs.length > 0 && exprs.every((e) => hasGuardAbove(lines, lineIdx, e))) {
                continue;
              }
            }

            if (
              usesTemplate &&
              (rule.key === 'command_injection' ||
                rule.key === 'sql_injection' ||
                rule.key === 'ssrf')
            ) {
              const cls = classifyInterpolation(line, lines, lineIdx);
              if (cls === 'constant') continue;
              interpolationSource = 'non_constant';
            }

            // SSRF: drop findings whose resolved URL host is on the safelist
            // (localhost, well-known SDK bases like api.anthropic.com).
            if (rule.key === 'ssrf' && usesTemplate) {
              const resolved = buildResolvedUrl(line, lines, lineIdx);
              if (resolved) {
                const host = extractHostFromUrl(resolved);
                if (host && SSRF_HOST_SAFELIST.has(host)) continue;
                // If we partially resolved a host literal directly in the template
                // (e.g. `http://127.0.0.1:${port}/...`), also drop on host hit.
              }
              // Fallback: look for a literal host substring directly in the line.
              const hostMatch = /https?:\/\/([A-Za-z0-9_.-]+)/i.exec(line);
              if (hostMatch) {
                const host = hostMatch[1].toLowerCase();
                if (SSRF_HOST_SAFELIST.has(host)) continue;
              }
            }

            // command_injection: if the command name is a literal (no $ on the
            // shell-command position) and only safe constants are interpolated,
            // already dropped above. Additionally drop when the only `${...}`
            // pieces are bound to a hardcoded allowlist array literal nearby —
            // we approximate by requiring constant resolution which is handled.

            // insecure_crypto (SHA-1/MD5): require a security-adjacent context.
            let evidence: string | undefined;
            if (rule.key === 'insecure_crypto' && /sha1?|md5/i.test(line)) {
              const ctx = isWeakHashSecurityContext(file.path, contextWindow);
              if (!ctx.ok) continue;
              evidence = ctx.evidence;
            }

            // ---- Per-rule safe-shape classification ----
            // Default confidence; we may downgrade severity and/or confidence
            // when a known-safe shape is recognized.
            let severity: Severity = rule.severity;
            let confidence: 'low' | 'medium' | 'high' = 'high';
            let fixOverride: string | null = null;

            if (rule.key === 'xss' && /\.innerHTML\s*=/.test(line)) {
              const cls = classifyInnerHtmlAssignment(line, lines, lineIdx);
              if (cls.safe) continue;
            }

            // SQL: value comes from a loop over a locally derived array — the
            // origin is our own code, not remote input.
            if (rule.key === 'sql_injection' && usesTemplate) {
              const exprs = extractInterpolatedExprs(line);
              if (exprs.length > 0 && exprs.every((e) => isLocalLoopVariable(lines, lineIdx, e))) {
                confidence = 'low';
                evidence = evidence ?? 'value iterated from a locally derived array';
              }
            }

            if (rule.key === 'path_traversal' && /path\.(?:join|resolve)/.test(line)) {
              const cls = classifyPathResolve(line);
              if (cls.drop) continue;
              if (cls.downgrade) {
                severity = 'low';
                confidence = 'low';
                evidence = evidence ?? 'path.resolve anchored to known root directory';
              }
            }

            if (rule.key === 'ssrf' && usesTemplate) {
              const cls = classifySsrfTemplate(line, lines, lineIdx);
              if (cls === 'local' || cls === 'fixed_authority') continue;
              if (cls === 'config') {
                confidence = 'low';
                evidence = evidence ?? 'request URL built from operator configuration';
              }
              if (cls === 'downgrade') {
                severity = downgradeSeverity(severity); // high -> medium
                confidence = 'low';
                evidence = evidence ?? 'fetch base bound to a localhost-shaped identifier';
              }
            }

            if (rule.key === 'command_injection' && usesTemplate) {
              const cmdShape = classifyCommandInjection(line, lines, lineIdx);
              if (cmdShape === 'open') {
                // GUI file-open verb with a path our process produced.
                severity = 'medium';
                confidence = 'medium';
                fixOverride =
                  'GUI file-open with a path our process produced; ensure the path is not attacker-controlled.';
              } else if (cmdShape === 'which') {
                severity = 'low';
                confidence = 'low';
                fixOverride =
                  '`which X` only looks up a binary by name and does not execute it; prefer a hardcoded allowlist of valid command names.';
              } else if (cmdShape === 'taskkill') {
                severity = 'low';
                confidence = 'low';
                fixOverride =
                  '`taskkill /PID X` argument bound to a known numeric PID; verify the source of the PID.';
              }
            }

            // Apply confidence policy: critical/high require medium+ confidence.
            // Otherwise drop one severity step and tag evidence as "weak".
            if ((severity === 'critical' || severity === 'high') && confidence === 'low') {
              severity = downgradeSeverity(severity);
              evidence = evidence ?? 'weak';
            }

            // Honor the per-call severity threshold AFTER downgrades.
            if (severityRank(severity) < thresholdRank) continue;

            const finding: SecurityFinding = {
              rule_id: rule.id,
              rule_name: rule.name,
              severity,
              file: file.path,
              line: lineIdx + 1,
              column: match.index + 1,
              snippet: snippet.length > 200 ? `${snippet.slice(0, 200)}...` : snippet,
              fix: fixOverride ?? rule.fix,
              confidence,
            };
            if (interpolationSource) finding.interpolation_source = interpolationSource;
            if (evidence) finding.evidence = evidence;
            findings.push(finding);
          }
        }
      }
    }
  }

  // Low-confidence findings are weakly grounded by construction. Reporting them
  // by default is what trains users to ignore the whole list, so they are opt-in
  // and the suppressed count is surfaced instead of being silently dropped.
  let suppressedLow = 0;
  let reported = findings;
  if (!opts.includeLowConfidence) {
    reported = findings.filter((f) => f.confidence !== 'low');
    suppressedLow = findings.length - reported.length;
  }

  // Sort: critical first, then high, medium, low
  reported.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));

  const summary: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of reported) {
    summary[f.severity]++;
  }

  return ok({
    files_scanned: scanned,
    findings: reported,
    summary,
    suppressed_low_confidence: suppressedLow,
  });
}
