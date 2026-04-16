/**
 * BladePlugin — detects Blade template directives and creates edges
 * for @extends, @include, @component, and <x-component> usage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok, type TraceMcpResult } from '../../../../../errors.js';
import type {
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  FileParseResult,
  RawEdge,
  ResolveContext,
} from '../../../../../plugin-api/types.js';

interface BladeDirective {
  type: 'extends' | 'include' | 'component' | 'x-component';
  name: string;
  line: number;
}

/** Detect @extends('layout.name') */
const EXTENDS_RE = /@extends\(\s*['"]([\w.-]+)['"]\s*\)/g;

/** Detect @include('partial.name') and @includeIf, @includeWhen etc. */
const INCLUDE_RE = /@include(?:If|When|Unless|First)?\(\s*['"]([\w.-]+)['"]/g;

/** Detect @component('component.name') */
const COMPONENT_RE = /@component\(\s*['"]([\w.-]+)['"]/g;

/** Detect <x-component-name> (Blade anonymous/class components) */
const X_COMPONENT_RE = /<x-([\w.-]+)/g;

/** Detect @section('name') */
const SECTION_RE = /@section\(\s*['"]([\w.-]+)['"]/g;

/** Detect @yield('name') */
const YIELD_RE = /@yield\(\s*['"]([\w.-]+)['"]/g;

export function extractBladeDirectives(source: string): BladeDirective[] {
  const directives: BladeDirective[] = [];

  const extract = (re: RegExp, type: BladeDirective['type']) => {
    let match: RegExpExecArray | null;
    const regex = new RegExp(re.source, 'g');
    while ((match = regex.exec(source)) !== null) {
      const before = source.substring(0, match.index);
      const line = before.split('\n').length;
      directives.push({ type, name: match[1], line });
    }
  };

  extract(EXTENDS_RE, 'extends');
  extract(INCLUDE_RE, 'include');
  extract(COMPONENT_RE, 'component');
  extract(X_COMPONENT_RE, 'x-component');

  return directives;
}

/**
 * Cached per-context lookup: function name → matching PHP function symbols
 * across the whole project. Blade's resolveEdges doesn't know workspace of
 * each file, so we fall back to the closest-by-path heuristic in the caller.
 */
interface PhpFnRecord { id: number; symbolId: string; filePath: string }
let _phpFunctionIndex: Map<string, PhpFnRecord[]> | null = null;
let _phpFunctionIndexCtx: ResolveContext | null = null;

function rebuildPhpFunctionIndex(ctx: ResolveContext): void {
  _phpFunctionIndex = new Map();
  _phpFunctionIndexCtx = ctx;
  const filePathById = new Map<number, string>();
  for (const file of ctx.getAllFiles()) {
    if (file.language !== 'php') continue;
    filePathById.set(file.id, file.path);
  }
  for (const [fileId, filePath] of filePathById) {
    for (const sym of ctx.getSymbolsByFile(fileId)) {
      if (sym.kind !== 'function') continue;
      const list = _phpFunctionIndex.get(sym.name) ?? [];
      list.push({ id: sym.id, symbolId: sym.symbolId, filePath });
      _phpFunctionIndex.set(sym.name, list);
    }
  }
}

/**
 * Find a PHP function symbol by name, preferring one whose file shares the
 * longest common prefix with the caller's file path. This mirrors project/
 * workspace isolation — a Blade template in fair-laravel/ prefers the
 * helper defined in fair-laravel/ over one in thewed-laravel/.
 */
function findPhpFunctionByName(
  name: string, ctx: ResolveContext, callerPath: string,
): { id: number; symbolId: string } | null {
  if (_phpFunctionIndexCtx !== ctx) rebuildPhpFunctionIndex(ctx);
  const candidates = _phpFunctionIndex!.get(name);
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1) return { id: candidates[0].id, symbolId: candidates[0].symbolId };

  // Pick the candidate with the longest common path prefix with the caller.
  const callerSegments = callerPath.split('/');
  let best: PhpFnRecord | null = null;
  let bestScore = -1;
  for (const cand of candidates) {
    const candSegments = cand.filePath.split('/');
    let shared = 0;
    const minLen = Math.min(callerSegments.length, candSegments.length);
    for (let i = 0; i < minLen; i++) {
      if (callerSegments[i] === candSegments[i]) shared++;
      else break;
    }
    if (shared > bestScore) {
      bestScore = shared;
      best = cand;
    }
  }
  return best ? { id: best.id, symbolId: best.symbolId } : null;
}

export function extractBladeSections(source: string): string[] {
  const sections: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(SECTION_RE.source, 'g');
  while ((match = re.exec(source)) !== null) {
    sections.push(match[1]);
  }
  return sections;
}

/**
 * PHP/Laravel reserved constructs that look like function calls but are not.
 * These should be filtered out so we don't emit false-positive edges.
 */
const BLADE_BUILTIN_CALLS = new Set([
  // PHP language constructs
  'echo', 'print', 'isset', 'empty', 'unset', 'list', 'require', 'include',
  'require_once', 'include_once', 'exit', 'die', 'array',
  // Common PHP functions that are stdlib (we don't index them)
  'count', 'array_map', 'array_filter', 'array_merge', 'array_keys', 'array_values',
  'in_array', 'implode', 'explode', 'str_replace', 'strtolower', 'strtoupper',
  'substr', 'strlen', 'trim', 'json_encode', 'json_decode', 'sprintf', 'printf',
  'number_format', 'date', 'time', 'strtotime', 'htmlspecialchars', 'nl2br',
  'e', 'old', 'request', 'session', 'auth', 'config', 'env', 'trans', '__',
  'route', 'url', 'asset', 'mix', 'vite', 'csrf_token', 'method_field',
  'view', 'response', 'redirect', 'back', 'abort', 'dd', 'dump',
  'optional', 'data_get', 'data_set', 'tap', 'with', 'value', 'collect',
  'app', 'resolve', 'now', 'today', 'cache', 'storage_path', 'base_path',
  'public_path', 'resource_path', 'app_path', 'config_path', 'database_path',
  'logger', 'info', 'error', 'throw_if', 'throw_unless',
  'is_null', 'is_array', 'is_string', 'is_numeric', 'is_bool', 'is_object',
  'Str', 'Arr', 'Carbon', 'DB', 'Log', 'Cache', 'Storage', 'File',
]);

export interface BladeFunctionCall {
  name: string;
  line: number;
}

/**
 * Extract PHP function calls from Blade template expressions.
 * Scans content inside {{ }}, {!! !!}, and @directive(...) blocks.
 *
 * Only returns user-defined function names — built-in PHP and common
 * Laravel helpers are filtered out to avoid false positives.
 */
export function extractBladeFunctionCalls(source: string): BladeFunctionCall[] {
  const calls: BladeFunctionCall[] = [];
  const seen = new Set<string>(); // dedup (name:line) pairs

  // Match PHP-like expression regions in Blade:
  //   {{ ... }}
  //   {!! ... !!}
  //   @if (...), @foreach (...), @php ... @endphp, etc.
  const EXPR_REGIONS = [
    /\{\{([\s\S]*?)\}\}/g,          // {{ expr }}
    /\{!!([\s\S]*?)!!\}/g,          // {!! expr !!}
    /@php\b([\s\S]*?)@endphp/g,     // @php ... @endphp
    /@(?:if|elseif|while|for|foreach|switch|unless|isset|empty)\s*\(([\s\S]*?)\)/g,
  ];

  // Match bare function calls inside an expression.
  // Accept snake_case or camelCase identifiers followed by `(`.
  // Skip static calls (Class::method) and method calls ($obj->method).
  const CALL_RE = /(?<![:>$\w])([a-z_][a-zA-Z0-9_]*)\s*\(/g;

  for (const regionRe of EXPR_REGIONS) {
    regionRe.lastIndex = 0;
    let regionMatch: RegExpExecArray | null;
    while ((regionMatch = regionRe.exec(source)) !== null) {
      const expr = regionMatch[1];
      if (!expr) continue;

      // Compute line number of the region start
      const regionStart = regionMatch.index;
      const beforeRegion = source.substring(0, regionStart);
      const baseLine = beforeRegion.split('\n').length;

      CALL_RE.lastIndex = 0;
      let callMatch: RegExpExecArray | null;
      while ((callMatch = CALL_RE.exec(expr)) !== null) {
        const name = callMatch[1];
        if (BLADE_BUILTIN_CALLS.has(name)) continue;
        // Compute line within expression
        const exprBefore = expr.substring(0, callMatch.index);
        const lineOffset = exprBefore.split('\n').length - 1;
        const line = baseLine + lineOffset;
        const key = `${name}:${line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        calls.push({ name, line });
      }
    }
  }

  return calls;
}

export function extractBladeYields(source: string): string[] {
  const yields: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(YIELD_RE.source, 'g');
  while ((match = re.exec(source)) !== null) {
    yields.push(match[1]);
  }
  return yields;
}

/**
 * Convert a Blade dot-notation view name to a file path.
 * 'layouts.app' -> 'resources/views/layouts/app.blade.php'
 */
export function bladeNameToPath(name: string): string {
  return `resources/views/${name.replace(/\./g, '/')}.blade.php`;
}

/**
 * Convert an x-component name to possible file paths.
 * 'user-card' -> 'resources/views/components/user-card.blade.php'
 */
export function xComponentToPath(name: string): string {
  return `resources/views/components/${name}.blade.php`;
}

export class BladePlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'blade',
    version: '1.0.0',
    priority: 5,
    category: 'view',
    dependencies: ['laravel'],
  };

  detect(ctx: ProjectContext): boolean {
    // Check if resources/views/ exists with .blade.php files
    try {
      const viewsDir = path.join(ctx.rootPath, 'resources', 'views');
      const stat = fs.statSync(viewsDir);
      if (!stat.isDirectory()) return false;
      // Quick check: any .blade.php in the directory tree
      return this.hasBlade(viewsDir);
    } catch {
      return false;
    }
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'blade_extends', category: 'blade', description: '@extends directive' },
        { name: 'blade_includes', category: 'blade', description: '@include directive' },
        { name: 'blade_component', category: 'blade', description: '<x-component> or @component' },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    _language: string,
  ): TraceMcpResult<FileParseResult> {
    if (!filePath.endsWith('.blade.php')) {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const sections = extractBladeSections(source);
    const yields = extractBladeYields(source);

    const result: FileParseResult = {
      status: 'ok',
      symbols: [],
      frameworkRole: yields.length > 0 ? 'blade_layout' : 'blade_view',
    };

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];
    const allFiles = ctx.getAllFiles();

    // Build file path -> file map
    const fileMap = new Map<string, { id: number; path: string }>();
    for (const f of allFiles) {
      fileMap.set(f.path, f);
    }

    for (const file of allFiles) {
      if (!file.path.endsWith('.blade.php')) continue;

      const source = ctx.readFile(file.path);
      if (!source) continue;

      const directives = extractBladeDirectives(source);

      for (const dir of directives) {
        let targetPath: string;
        let edgeType: string;

        switch (dir.type) {
          case 'extends':
            targetPath = bladeNameToPath(dir.name);
            edgeType = 'blade_extends';
            break;
          case 'include':
            targetPath = bladeNameToPath(dir.name);
            edgeType = 'blade_includes';
            break;
          case 'component':
            targetPath = bladeNameToPath(dir.name);
            edgeType = 'blade_component';
            break;
          case 'x-component':
            targetPath = xComponentToPath(dir.name);
            edgeType = 'blade_component';
            break;
        }

        const targetFile = fileMap.get(targetPath);
        if (!targetFile) continue;

        edges.push({
          sourceNodeType: 'file',
          sourceRefId: file.id,
          targetNodeType: 'file',
          targetRefId: targetFile.id,
          edgeType,
          metadata: { directive: dir.type, name: dir.name, line: dir.line },
        });
      }

      // Function calls from Blade expressions: {{ helperFn(...) }}
      const calls = extractBladeFunctionCalls(source);
      for (const call of calls) {
        const targetSym = findPhpFunctionByName(call.name, ctx, file.path);
        if (!targetSym) continue;

        edges.push({
          sourceNodeType: 'file',
          sourceRefId: file.id,
          targetSymbolId: targetSym.symbolId,
          edgeType: 'calls',
          metadata: { callee: call.name, line: call.line, kind: 'blade_expr' },
        });
      }
    }

    return ok(edges);
  }

  private hasBlade(dir: string): boolean {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.blade.php')) return true;
        if (entry.isDirectory()) {
          if (this.hasBlade(path.join(dir, entry.name))) return true;
        }
      }
    } catch { /* ignore */ }
    return false;
  }
}
