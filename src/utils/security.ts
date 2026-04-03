import path from 'node:path';
import { ok, err, type TraceMcpResult } from '../errors.js';
import { securityViolation } from '../errors.js';

const DEFAULT_SECRET_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /key/i,
  /credential/i,
  /api_key/i,
  /private_key/i,
];

// ─── Sensitive file detection ─────────────────────────────────────────
// Filename/extension patterns that indicate credential or key files.


const SENSITIVE_FILE_PATTERNS = [
  // Env files (handled specially by env-parser, but still blocked from raw indexing)
  '.env', '.env.*', '*.env',
  // Certificates & keys
  '*.pem', '*.key', '*.p12', '*.pfx', '*.crt', '*.cer',
  // Keystores
  '*.keystore', '*.jks',
  // Credential files
  '*.credentials', '*.token', '*.secrets',
  'credentials.json', 'service-account*.json',
  // SSH keys
  'id_rsa', 'id_rsa.*', 'id_ed25519', 'id_ed25519.*', 'id_dsa', 'id_ecdsa',
  // Auth / config files with secrets
  '.htpasswd', '.netrc', '.npmrc', '.pypirc',
  // Broad wildcard (with doc exemption below)
  '*secret*',
];

// Documentation extensions where the broad *secret* glob produces false positives
// (e.g. docs/secrets-handling.md is documentation, not a credential file).
const DOC_SAFE_EXTENSIONS = new Set([
  '.md', '.markdown', '.mdx', '.rst', '.txt',
  '.adoc', '.asciidoc', '.asc', '.html', '.htm', '.ipynb',
]);

// Patterns exempt from doc-extension files
const DOC_EXEMPT_PATTERNS = new Set(['*secret*']);

/**
 * Check if a file path matches known sensitive/credential file patterns.
 * Uses filename/extension matching, not content inspection.
 */
export function isSensitiveFile(filePath: string): boolean {
  const name = path.basename(filePath).toLowerCase();
  const ext = path.extname(name);

  for (const pattern of SENSITIVE_FILE_PATTERNS) {
    // Skip broad patterns for documentation files
    if (DOC_EXEMPT_PATTERNS.has(pattern) && DOC_SAFE_EXTENSIONS.has(ext)) {
      continue;
    }
    if (matchGlob(name, pattern)) return true;
  }
  return false;
}

/** Simple glob match supporting * wildcard and .ext.* suffix patterns. */
function matchGlob(name: string, pattern: string): boolean {
  // Exact match
  if (name === pattern) return true;

  // .env.* → matches .env.local, .env.production, etc.
  if (pattern === '.env.*' && /^\.env\..+$/.test(name)) return true;

  // id_rsa.* → matches id_rsa.pub, etc.
  if (pattern.endsWith('.*') && !pattern.startsWith('*')) {
    const prefix = pattern.slice(0, -2);
    if (name === prefix || (name.startsWith(prefix + '.') && name.length > prefix.length + 1)) {
      return true;
    }
  }

  // *.ext → matches any file with that extension
  if (pattern.startsWith('*.') && !pattern.includes('*', 1)) {
    const ext = pattern.slice(1); // .pem, .key, etc.
    if (name.endsWith(ext)) return true;
  }

  // *substring* → contains match
  if (pattern.startsWith('*') && pattern.endsWith('*') && pattern.length > 2) {
    const sub = pattern.slice(1, -1);
    if (name.includes(sub)) return true;
  }

  // service-account*.json → prefix + suffix
  if (pattern.includes('*') && !pattern.startsWith('*') && !pattern.endsWith('*')) {
    const starIdx = pattern.indexOf('*');
    const prefix = pattern.slice(0, starIdx);
    const suffix = pattern.slice(starIdx + 1);
    if (name.startsWith(prefix) && name.endsWith(suffix)) return true;
  }

  return false;
}

const DEFAULT_MAX_FILE_SIZE = 1_048_576; // 1 MB

const ARTISAN_WHITELIST = new Set(['route:list', 'model:show', 'event:list']);

export interface SecurityConfig {
  secretPatterns?: string[];
  maxFileSizeBytes?: number;
  rootPath: string;
}

export function validatePath(filePath: string, rootPath: string): TraceMcpResult<string> {
  const resolved = path.resolve(rootPath, filePath);
  const normalizedRoot = path.resolve(rootPath);

  if (!resolved.startsWith(normalizedRoot + path.sep) && resolved !== normalizedRoot) {
    return err(securityViolation(`Path traversal detected: ${filePath}`));
  }

  return ok(resolved);
}

export function detectSecrets(
  content: string,
  patterns?: string[],
): { found: boolean; matches: string[] } {
  const regexes: RegExp[] = [];
  if (patterns?.length) {
    for (const p of patterns) {
      try { regexes.push(new RegExp(p, 'i')); } catch { /* skip invalid regex */ }
    }
  } else {
    regexes.push(...DEFAULT_SECRET_PATTERNS);
  }

  const matches: string[] = [];
  for (const regex of regexes) {
    if (regex.test(content)) {
      matches.push(regex.source);
    }
  }

  return { found: matches.length > 0, matches };
}

export function validateFileSize(
  sizeBytes: number,
  maxBytes?: number,
): TraceMcpResult<void> {
  const limit = maxBytes ?? DEFAULT_MAX_FILE_SIZE;
  if (sizeBytes > limit) {
    return err(
      securityViolation(`File size ${sizeBytes} exceeds limit ${limit}`),
    );
  }
  return ok(undefined);
}

/** Escape a string for safe interpolation into a RegExp constructor. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function validateArtisanCommand(command: string): TraceMcpResult<string> {
  if (!ARTISAN_WHITELIST.has(command)) {
    return err(
      securityViolation(
        `Artisan command '${command}' not in whitelist: [${[...ARTISAN_WHITELIST].join(', ')}]`,
      ),
    );
  }
  return ok(command);
}
