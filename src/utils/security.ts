import fs from 'node:fs';
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
  const prefix = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep;

  if (!resolved.startsWith(prefix) && resolved !== normalizedRoot) {
    return err(securityViolation(`Path traversal detected: ${filePath}`));
  }

  return ok(resolved);
}

/**
 * Write-path confinement for mutating tools (TRA-1848).
 *
 * `validatePath` is lexical (resolve-based) and intentionally stays that way
 * for read paths. Writes need more: a path that is lexically inside the root
 * can still escape it through a symlink — either a symlinked file at the
 * target or a symlinked parent directory pointing outside. This check runs
 * immediately before a write and layers on top of the lexical check:
 *  1. lexical confinement (same rule as `validatePath`),
 *  2. reject when the target itself is a symlink,
 *  3. realpath confinement of the target (or, for not-yet-existing targets,
 *     of the nearest existing ancestor) against the realpath of the root.
 *
 * Returns the resolved absolute path on success.
 */
export function validateWritePath(filePath: string, rootPath: string): TraceMcpResult<string> {
  const lexical = validatePath(filePath, rootPath);
  if (lexical.isErr()) return lexical;
  const abs = lexical.value;

  // 2. The target itself must not be a symlink — writing through it would
  //    modify whatever it points at, outside any root comparison.
  let linkStat: fs.Stats | null = null;
  try {
    linkStat = fs.lstatSync(abs);
  } catch {
    // ENOENT — target doesn't exist yet; handled by the parent-dir check below.
  }
  if (linkStat?.isSymbolicLink()) {
    return err(securityViolation(`Refusing to write through symlink: ${filePath}`));
  }

  // 3. Realpath confinement — resolves symlinked parent directories too.
  const realRoot = safeRealpath(path.resolve(rootPath)) ?? path.resolve(rootPath);
  const realTarget = realpathOfExistingTarget(abs);
  if (realTarget !== null) {
    const rootPrefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
    if (realTarget !== realRoot && !realTarget.startsWith(rootPrefix)) {
      return err(securityViolation(`Path escapes project root via symlink: ${filePath}`));
    }
  }

  return ok(abs);
}

/** Best-effort realpath; null when the path (or its ancestors) can't be resolved. */
function safeRealpath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Realpath of `abs` when it exists, otherwise the realpath of the nearest
 * existing ancestor with the missing remainder re-appended. Null when no
 * ancestor exists on disk (nothing to resolve symlinks against — the lexical
 * check above already passed, so there is no escape to detect).
 */
function realpathOfExistingTarget(abs: string): string | null {
  const direct = safeRealpath(abs);
  if (direct !== null) return direct;

  const missing: string[] = [];
  let cursor = abs;
  for (;;) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return null; // filesystem root — no existing ancestor
    missing.unshift(path.basename(cursor));
    const realParent = safeRealpath(parent);
    if (realParent !== null) return path.join(realParent, ...missing);
    cursor = parent;
  }
}

/**
 * Verify every absolute target in `absPaths` is writable inside `projectRoot`
 * (lexical + symlink confinement via {@link validateWritePath}). Returns the
 * first violation message, or null when all targets are confined. Mutating
 * tools call this BEFORE any write so a violation aborts the whole mutation
 * instead of leaving a partial one on disk (TRA-1848).
 */
export function firstWriteViolation(
  projectRoot: string,
  absPaths: Iterable<string>,
): string | null {
  for (const absPath of absPaths) {
    const check = validateWritePath(absPath, projectRoot);
    if (check.isErr()) {
      const e = check.error;
      return 'detail' in e && typeof e.detail === 'string' ? e.detail : e.code;
    }
  }
  return null;
}

/**
 * True for absolute-looking paths on any OS (`/x`, `\x`, `C:\x`, `C:/x`).
 * `path.isAbsolute` is platform-dependent (on POSIX it misses `C:\x`), and
 * agents send whatever their OS produced — so match the shape explicitly.
 */
export function isAbsolutePathLike(p: string): boolean {
  return /^([A-Za-z]:)?[\\/]/.test(p);
}

/**
 * Map a caller-supplied file path to the project-relative spelling the index
 * stores (TRA-1660).
 *
 * Agents only ever learn absolute paths (Read/Grep/hooks return those), so a
 * `get_outline` call with `/root/src/foo.ts` used to MISS the indexed
 * `src/foo.ts` with a bare NOT_FOUND. An absolute path inside the project
 * root is silently folded to relative; anything else (already-relative
 * spellings, paths outside the root) is returned in a canonicalised but
 * otherwise unchanged form so downstream guards keep rejecting escapes.
 */
export function normalizeToProjectRelative(filePath: string, rootPath: string): string {
  if (!filePath || !rootPath) return filePath;
  const rel = path.relative(path.resolve(rootPath), path.resolve(rootPath, filePath));
  if (!rel) return filePath;
  // Outside the root (`..` or `..\...`) — leave untouched; validatePath
  // rejects it downstream exactly as before.
  if (rel === '..' || rel.startsWith(`..${path.sep}`)) return filePath;
  return rel.split(path.sep).join('/');
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
