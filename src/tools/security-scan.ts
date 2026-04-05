/**
 * Security Scanning — OWASP / CWE pattern-based detection.
 *
 * Phase 1: regex pattern matching against indexed file content.
 * Scans files in batches to avoid N+1; no DB queries per-line.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Store } from '../db/store.js';
import { ok, err, type TraceMcpResult } from '../errors.js';
import { validationError } from '../errors.js';

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

export interface SecurityFinding {
  rule_id: string;
  rule_name: string;
  severity: Severity;
  file: string;
  line: number;
  column: number;
  snippet: string;
  fix: string;
}

export interface SecurityScanResult {
  files_scanned: number;
  findings: SecurityFinding[];
  summary: Record<Severity, number>;
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
  'typescript', 'javascript', 'python', 'php', 'ruby', 'java', 'csharp',
  'go', 'rust', 'kotlin', 'scala', 'swift',
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
      { regex: /\.(executeQuery|executeUpdate|prepareStatement)\s*\(\s*["'][^"']*["']\s*\+/g, languages: JAVA },
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
      { regex:/<\?=\s*\$(?!_SERVER\['REQUEST_METHOD)/g, languages: PHP },
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
      { regex: /(?:exec|system|passthru|shell_exec|popen|proc_open)\s*\(\s*\$[a-zA-Z_]/g, languages: PHP },
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
      { regex: /path\.(?:join|resolve)\s*\([^)]*(?:req\.|params\.|query\.|body\.)/g, languages: JS_TS },
      // JS/TS: fs operations with template literal
      { regex: /fs\.(?:readFile|writeFile|unlink|readdir|stat|access)(?:Sync)?\s*\(\s*`[^`]*\$\{/g, languages: JS_TS },
      // Python: open() with user-controlled path
      { regex: /open\s*\(\s*(?:request\.|f["']|os\.path\.join.*request)/g, languages: PY },
      // PHP: file operations with user input
      { regex: /(?:file_get_contents|fopen|readfile|include|require)\s*\(\s*\$_(?:GET|POST|REQUEST)/g, languages: PHP },
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
      { regex: /(?:api[_-]?key|apikey|api[_-]?secret)\s*[:=]\s*['"][a-zA-Z0-9_\-]{20,}['"]/gi, languages: ALL_LANGUAGES },
      // AWS access key
      { regex: /['"]AKIA[0-9A-Z]{16}['"]/g, languages: ALL_LANGUAGES },
      // Private key inline
      { regex: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g, languages: ALL_LANGUAGES },
      // Generic password assignment
      { regex: /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]{8,}['"]/gi, languages: ALL_LANGUAGES },
      // JWT/Bearer token
      { regex: /['"](?:eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,})['"]/g, languages: ALL_LANGUAGES },
      // Stripe live key
      { regex: /['"]sk_live_[a-zA-Z0-9]{20,}['"]/g, languages: ALL_LANGUAGES },
      // Generic secret assignment
      { regex: /(?:secret|token)\s*[:=]\s*['"][a-zA-Z0-9_\-/+=]{20,}['"]/gi, languages: ALL_LANGUAGES },
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
      { regex: /(?:createHash|MessageDigest\.getInstance|hashlib\.)\s*\(\s*['"]md5['"]/gi, languages: ALL_LANGUAGES },
      // SHA1
      { regex: /(?:createHash|MessageDigest\.getInstance|hashlib\.)\s*\(\s*['"]sha1?['"]/gi, languages: ALL_LANGUAGES },
      // DES
      { regex: /(?:createCipher|Cipher\.getInstance)\s*\(\s*['"](?:des|des-ede|rc4)['"]/gi, languages: ALL_LANGUAGES },
      // Math.random for crypto
      { regex: /Math\.random\s*\(\s*\).*(?:token|key|secret|password|nonce|salt)/gi, languages: JS_TS },
      // Python random for crypto
      { regex: /random\.(?:random|randint|choice)\s*\(.*(?:token|key|secret|password)/gi, languages: PY },
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
      { regex: /(?:res\.redirect|redirect|location\.href|window\.location)\s*(?:=|\()\s*(?:req\.|params\.|query\.)/g, languages: JS_TS },
      // Python: redirect with request
      { regex: /redirect\s*\(\s*request\.(?:GET|POST|args|form)\s*(?:\.|\.get\()/g, languages: PY },
      // PHP: header Location with user input
      { regex: /header\s*\(\s*['"]Location:\s*['"]\s*\.\s*\$_(?:GET|POST|REQUEST)/g, languages: PHP },
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
      { regex: /(?:fetch|axios\.get|axios\.post|got|request)\s*\(\s*(?:req\.|params\.|query\.|body\.|`[^`]*\$\{)/g, languages: JS_TS },
      // Python: requests with user input
      { regex: /requests\.(?:get|post|put|delete|patch)\s*\(\s*(?:request\.|f["'])/g, languages: PY },
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
    ? store.db.prepare("SELECT path, language FROM files WHERE path LIKE ? AND (status = 'ok' OR status IS NULL)").all(`${scope}%`) as { path: string; language: string }[]
    : store.db.prepare("SELECT path, language FROM files WHERE status = 'ok' OR status IS NULL").all() as { path: string; language: string }[];

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
      const lines = content.split('\n');

      for (const rule of activeRules) {
        if (severityRank(rule.severity) < thresholdRank) continue;

        for (const pattern of rule.patterns) {
          if (!pattern.languages.has(file.language)) continue;

          // Reset regex state for each file
          const re = new RegExp(pattern.regex.source, pattern.regex.flags);

          for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
            const line = lines[lineIdx];
            re.lastIndex = 0;
            const match = re.exec(line);
            if (!match) continue;

            const snippet = line.trim();

            // Check false positive filters on the line + surrounding context
            const contextWindow = lines.slice(
              Math.max(0, lineIdx - 2),
              Math.min(lines.length, lineIdx + 3),
            ).join('\n');

            let isFalsePositive = false;
            for (const fp of rule.falsePositiveFilters) {
              if (fp.test(contextWindow) || fp.test(file.path)) {
                isFalsePositive = true;
                break;
              }
            }
            if (isFalsePositive) continue;

            findings.push({
              rule_id: rule.id,
              rule_name: rule.name,
              severity: rule.severity,
              file: file.path,
              line: lineIdx + 1,
              column: match.index + 1,
              snippet: snippet.length > 200 ? snippet.slice(0, 200) + '...' : snippet,
              fix: rule.fix,
            });
          }
        }
      }
    }
  }

  // Sort: critical first, then high, medium, low
  findings.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));

  const summary: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) {
    summary[f.severity]++;
  }

  return ok({ files_scanned: scanned, findings, summary });
}
