import path from 'node:path';
import { err, ok, securityViolation, type TraceMcpResult } from '../errors.js';

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
// Two-rule model (both checked against the relative path):
//
// Rule 1 — BASENAME patterns: match specific credential/key basenames against
//   the file's basename only. A directory name containing "secret" does NOT
//   by itself exclude files beneath it. Source-code extensions (.ts, .js,
//   .py, .go, …) are never credential data — *secret* is intentionally absent
//   from this list; source files whose basename contains "secret" are indexed.
//   ponytail: pattern list is intentionally minimal — add only well-known
//   credential filename conventions, not broad substrings.
//
// Rule 2 — SECRET-STORE DIRECTORY: a file is sensitive when it lives inside a
//   directory whose name is exactly "secret" or "secrets" (whole path segment,
//   not a substring like "secrets-manager") AND the file carries a
//   data/credential extension (.yaml, .json, .env, .pem, .key, …).
//   Source files (e.g. router.go, index.ts) under such directories are indexed.

// ponytail: keep this list to well-known credential filename patterns only.
const SENSITIVE_BASENAME_PATTERNS = [
  // Env files (handled specially by env-parser, but still blocked from raw indexing)
  '.env',
  '.env.*',
  '*.env',
  // Certificates & keys
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.crt',
  '*.cer',
  // Keystores
  '*.keystore',
  '*.jks',
  // Credential files
  '*.credentials',
  '*.token',
  '*.secrets',
  'credentials.json',
  'service-account*.json',
  // SSH keys
  'id_rsa',
  'id_rsa.*',
  'id_ed25519',
  'id_ed25519.*',
  'id_dsa',
  'id_ecdsa',
  // Auth / config files with secrets
  '.htpasswd',
  '.netrc',
  '.npmrc',
  '.pypirc',
];

// Extensions that represent data/credential files rather than source code.
// Used by the secret-store directory rule (Rule 2).
// ponytail: keep to data serialisation and credential formats only.
const SECRET_STORE_DATA_EXTENSIONS = new Set([
  '.yaml',
  '.yml',
  '.json',
  '.toml',
  '.env',
  '.pem',
  '.key',
  '.crt',
  '.cer',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.credentials',
  '.token',
  '.secrets',
  '.tfvars',
  '.tfstate',
  '.ini',
  '.conf',
  '.config',
  '.properties',
]);

// Exact directory segment names that designate a secret store.
// Must be a WHOLE segment ("secrets" matches, "secrets-manager" does not).
const SECRET_STORE_DIR_SEGMENTS = new Set(['secret', 'secrets']);

/**
 * Return true when `segments` contains a whole-segment secret-store dir name.
 * Checks every directory component; the filename itself is excluded.
 */
function hasSecretStoreSegment(segments: string[]): boolean {
  // segments is path.dirname split; last element is the immediate parent dir
  return segments.some((seg) => SECRET_STORE_DIR_SEGMENTS.has(seg.toLowerCase()));
}

/**
 * Check if a file path matches known sensitive/credential file patterns.
 * Uses filename/extension matching and secret-store directory detection.
 * Does NOT inspect file content.
 *
 * Rule 1 — basename patterns applied to the file's basename only.
 * Rule 2 — secret-store dir: whole-segment "secret"/"secrets" parent dir
 *           AND a data/credential extension (not a source-code extension).
 */
export function isSensitiveFile(filePath: string): boolean {
  const basename = path.basename(filePath).toLowerCase();
  const ext = path.extname(basename);

  // Rule 1: basename patterns
  for (const pattern of SENSITIVE_BASENAME_PATTERNS) {
    if (matchGlob(basename, pattern)) return true;
  }

  // Rule 1b: a file literally named like a secret (basename contains a
  // "secret" token) AND carrying a data/credential extension — e.g.
  // app-secret.yml, secrets.yaml. Source extensions (.ts/.go/…) and doc
  // extensions (.md/.rst/.txt/.html) are excluded by the data-extension
  // gate, so secret-utils.ts and secrets-handling.md stay indexed.
  if (basename.includes('secret') && SECRET_STORE_DATA_EXTENSIONS.has(ext)) return true;

  // Rule 2: secret-store directory + data/credential extension
  if (SECRET_STORE_DATA_EXTENSIONS.has(ext)) {
    const dirParts = path.dirname(filePath).split(/[\\/]/).filter(Boolean);
    if (hasSecretStoreSegment(dirParts)) return true;
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
    if (name === prefix || (name.startsWith(`${prefix}.`) && name.length > prefix.length + 1)) {
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
      try {
        regexes.push(new RegExp(p, 'i'));
      } catch {
        /* skip invalid regex */
      }
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

export function validateFileSize(sizeBytes: number, maxBytes?: number): TraceMcpResult<void> {
  const limit = maxBytes ?? DEFAULT_MAX_FILE_SIZE;
  if (sizeBytes > limit) {
    return err(securityViolation(`File size ${sizeBytes} exceeds limit ${limit}`));
  }
  return ok(undefined);
}

/** Escape a string for safe interpolation into a RegExp constructor. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Detect binary content by scanning for null bytes in the first 8 KB.
 * Returns true if the buffer likely contains binary data.
 *
 * Heuristic: real binaries are *dense* with null bytes (>= ~0.4% of the
 * sampled window) while source files only ever contain rare, intentional
 * `'\x00'` literals (e.g. hash separators, parser sentinels). A single
 * null byte must NOT condemn an otherwise-text TypeScript/Python/Rust
 * file to being skipped by the indexer — that produced silent dropouts
 * where files appeared in the `files` table but their interior symbols
 * were never extracted.
 *
 * Threshold: require both an absolute floor (>=4 null bytes) AND a
 * density floor (~0.4% of the sampled window). Binaries (PNG, gzip,
 * ELF) sit orders of magnitude above this floor; legitimate source
 * files sit orders of magnitude below it.
 */
export function isBinaryBuffer(buf: Buffer): boolean {
  const checkLen = Math.min(buf.length, 8192);
  if (checkLen === 0) return false;
  let nulls = 0;
  for (let i = 0; i < checkLen; i++) {
    if (buf[i] === 0x00) nulls++;
  }
  if (nulls < 4) return false;
  // 0.4% density floor — guards against e.g. minified bundles that
  // happen to contain a few `\0` literal bytes.
  return nulls * 256 >= checkLen;
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
