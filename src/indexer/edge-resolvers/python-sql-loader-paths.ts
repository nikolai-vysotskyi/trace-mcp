/**
 * Static Python → `.sql` path extraction for `loads_sql` (Phase 4).
 * String literals, module constants, Path(__file__) chains, loader calls.
 */

import path from 'node:path';
import { isOffsetInPythonCommentOrString } from './python-literal-mask.js';

export const PYTHON_SQL_LOADER_CALLEES = [
  'read_sql_file',
  'render_sql_file',
  'load_query_sql',
  'load_sql_with_connectorx',
  'load_sql_with_benchmark',
  'load_incremental_with_connectorx',
  'load_incremental_with_benchmark',
  'load_sql_text_with_connectorx',
] as const;

const LOADER_CALLEE_PATTERN = PYTHON_SQL_LOADER_CALLEES.join('|');

export interface PythonSqlLoadRef {
  line: number;
  sqlPath: string;
  via: 'loader_call' | 'qualified_literal' | 'path_chain';
  callee?: string;
}

export function normalizeRepoRelativePath(p: string): string {
  if (!p) return '';
  const posix = p.split(path.sep).join('/');
  const normalized = path.posix.normalize(posix).replace(/^\.\//, '');
  return normalized === '.' ? '' : normalized;
}

export function isStaticSqlPathLiteral(raw: string): boolean {
  if (!raw.endsWith('.sql')) return false;
  if (raw.includes('{') || raw.includes('}') || raw.includes('%') || raw.includes('$')) {
    return false;
  }
  if (raw.includes('\n') || raw.includes('\r')) return false;
  return true;
}

function lineNumberAt(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

function dirnameDepth(pyFileRel: string): number {
  const d = path.posix.dirname(normalizeRepoRelativePath(pyFileRel));
  if (!d || d === '.') return 0;
  return d.split('/').filter(Boolean).length;
}

/** Repo-relative prefix after N× `.parent` from the `.py` file directory. */
export function ascendFromPyFile(pyFileRel: string, parentCount: number): string {
  let dir = path.posix.dirname(normalizeRepoRelativePath(pyFileRel));
  for (let i = 0; i < parentCount; i++) {
    dir = path.posix.dirname(dir);
  }
  return normalizeRepoRelativePath(dir);
}

function joinRepoSegments(base: string, segments: string[]): string {
  const parts = [...(base ? [base] : []), ...segments];
  return normalizeRepoRelativePath(parts.join('/'));
}

function parsePathSegments(rhs: string): string[] {
  const segs: string[] = [];
  for (const m of rhs.matchAll(/\/\s*["']([^"']+)["']/g)) {
    if (m[1]) segs.push(m[1]);
  }
  return segs;
}

/**
 * Module-level `ROOT = Path(__file__).resolve().parent…` and
 * `VAR = ROOT / "scripts" / … / "file.sql"` style constants.
 */
export function extractPathConstants(source: string, pyFileRel: string): Map<string, string> {
  const map = new Map<string, string>();

  const rootMatch = source.match(
    /^\s*ROOT\s*=\s*Path\(__file__\)\.resolve\(\)((?:\.parent)*)\s*(?:#.*)?$/m,
  );
  if (rootMatch) {
    const rawParents = (rootMatch[1].match(/\.parent/g) ?? []).length;
    const depth = dirnameDepth(pyFileRel);
    const parentCount = depth > 0 ? Math.min(rawParents, depth) : rawParents;
    map.set('ROOT', ascendFromPyFile(pyFileRel, parentCount));
  }

  const assignRe =
    /^([A-Z][A-Z0-9_]*)\s*=\s*([A-Z][A-Z0-9_]*)\s*((?:\/\s*["'][^"']+["']\s*)+)\s*(?:#.*)?$/gm;
  for (let pass = 0; pass < 8; pass++) {
    let added = false;
    for (const m of source.matchAll(assignRe)) {
      const name = m[1];
      const baseName = m[2];
      const rhs = m[3];
      if (!name || !baseName || !rhs) continue;
      const base = map.get(baseName);
      if (base === undefined) continue;
      const segs = parsePathSegments(rhs);
      if (segs.length === 0) continue;
      const joined = joinRepoSegments(base, segs);
      if (map.get(name) !== joined) {
        map.set(name, joined);
        added = true;
      }
    }
    if (!added) break;
  }

  return map;
}

function extractStringSqlConstants(source: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /^([A-Z][A-Z0-9_]*)\s*=\s*['"]([^'"]+\.sql)['"]\s*(?:#.*)?$/gm;
  for (const m of source.matchAll(re)) {
    const name = m[1];
    const val = m[2];
    if (name && val && isStaticSqlPathLiteral(val)) map.set(name, val);
  }
  return map;
}

function buildConstantsMap(source: string, pyFileRel: string): Map<string, string> {
  const map = extractPathConstants(source, pyFileRel);
  for (const [k, v] of extractStringSqlConstants(source)) map.set(k, v);
  return map;
}

function resolveIdentifier(name: string, constants: Map<string, string>): string | null {
  const c = constants.get(name);
  if (!c) return null;
  if (c.endsWith('.sql') && isStaticSqlPathLiteral(c)) return c;
  return null;
}

function resolveFirstArg(arg: string, constants: Map<string, string>): string | null {
  const trimmed = arg.trim();
  const str = trimmed.match(/^['"]([^'"]+\.sql)['"]$/);
  if (str?.[1] && isStaticSqlPathLiteral(str[1])) return str[1];
  const id = trimmed.match(/^([A-Z][A-Z0-9_]*)$/);
  if (id?.[1]) return resolveIdentifier(id[1], constants);
  return null;
}

function resolveSqlPathKeyword(callTail: string, constants: Map<string, string>): string | null {
  const kw = callTail.match(/\bsql_path\s*=\s*([A-Z][A-Z0-9_]*)/);
  if (kw?.[1]) return resolveIdentifier(kw[1], constants);
  return null;
}

/**
 * Resolve a candidate path against indexed `.sql` file paths (repo-relative, POSIX).
 */
export function resolveToIndexedSqlPath(
  candidate: string,
  pyFileRel: string,
  indexedSqlPaths: Set<string>,
): string | null {
  const norm = normalizeRepoRelativePath(candidate);
  if (indexedSqlPaths.has(norm)) return norm;
  const fromPy = normalizeRepoRelativePath(
    path.posix.join(path.posix.dirname(normalizeRepoRelativePath(pyFileRel)), norm),
  );
  if (indexedSqlPaths.has(fromPy)) return fromPy;
  return null;
}

export function extractPythonSqlLoadRefs(source: string, pyFileRel: string): PythonSqlLoadRef[] {
  if (!pyFileRel) return [];
  const constants = buildConstantsMap(source, pyFileRel);
  const out: PythonSqlLoadRef[] = [];
  const seen = new Set<string>();

  const loaderRe = new RegExp(`\\b(${LOADER_CALLEE_PATTERN})\\s*\\(([^)]*)`, 'g');
  for (const m of source.matchAll(loaderRe)) {
    const at = m.index ?? 0;
    if (isOffsetInPythonCommentOrString(source, at)) continue;
    const callee = m[1];
    const args = m[2];
    if (!callee || args == null) continue;
    let sqlPath =
      resolveSqlPathKeyword(args, constants) ??
      resolveFirstArg(args.split(',')[0] ?? '', constants);
    if (!sqlPath) continue;
    const line = lineNumberAt(source, m.index ?? 0);
    const key = `${line}:${sqlPath}:${callee}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ line, sqlPath, via: 'loader_call', callee });
  }

  const helperRe = /\b_load_extract_df\s*\(\s*([A-Z][A-Z0-9_]*)\s*[,)]/g;
  for (const m of source.matchAll(helperRe)) {
    if (isOffsetInPythonCommentOrString(source, m.index ?? 0)) continue;
    const id = m[1];
    if (!id) continue;
    const sqlPath = resolveIdentifier(id, constants);
    if (!sqlPath) continue;
    const line = lineNumberAt(source, m.index ?? 0);
    const key = `${line}:${sqlPath}:_load_extract_df`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ line, sqlPath, via: 'path_chain', callee: '_load_extract_df' });
  }

  const litRe = /(?<![fF])['"]([^'"]+\.sql)['"]/g;
  for (const m of source.matchAll(litRe)) {
    const at = m.index ?? 0;
    if (isOffsetInPythonCommentOrString(source, at)) continue;
    const sqlPath = m[1];
    if (!sqlPath || !isStaticSqlPathLiteral(sqlPath)) continue;
    if (!sqlPath.includes('/')) continue;
    const line = lineNumberAt(source, m.index ?? 0);
    const key = `lit:${line}:${sqlPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ line, sqlPath, via: 'qualified_literal' });
  }

  return out;
}
