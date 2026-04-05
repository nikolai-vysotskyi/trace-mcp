/**
 * JSON Language Plugin — dialect-aware symbol extraction.
 *
 * Detects JSON dialect from filename, then applies specialised extraction
 * rules for:
 *   - package.json (npm/yarn)
 *   - tsconfig*.json
 *   - .eslintrc.json / .eslintrc
 *   - .vscode/settings.json
 *   - .vscode/launch.json / launch.json
 *   - lerna.json
 *   - .babelrc / babel.config.json
 *   - .prettierrc / .prettierrc.json
 *   - nest-cli.json
 *   - angular.json
 *   - composer.json
 *   - Generic JSON (first-level keys as constants)
 */
import { ok } from 'neverthrow';
import type { LanguagePlugin, PluginManifest, FileParseResult, RawSymbol, RawEdge, SymbolKind } from '../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../errors.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function symId(filePath: string, name: string, kind: string): string {
  return `${filePath}::${name}#${kind}`;
}

/** Strip single-line // and multi-line comments for JSONC parsing. */
function stripJsonComments(source: string): string {
  let result = '';
  let i = 0;
  let inString = false;
  let escape = false;

  while (i < source.length) {
    const ch = source[i];

    if (inString) {
      result += ch;
      if (escape) { escape = false; }
      else if (ch === '\\') { escape = true; }
      else if (ch === '"') { inString = false; }
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      result += ch;
      i++;
      continue;
    }

    // Single-line comment
    if (ch === '/' && i + 1 < source.length && source[i + 1] === '/') {
      // Skip to end of line
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }

    // Multi-line comment
    if (ch === '/' && i + 1 < source.length && source[i + 1] === '*') {
      i += 2;
      while (i < source.length) {
        if (source[i] === '*' && i + 1 < source.length && source[i + 1] === '/') {
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }

    result += ch;
    i++;
  }

  return result;
}

// ── Dialect detection ──────────────────────────────────────────────────────

type JsonDialect =
  | 'package-json'
  | 'tsconfig'
  | 'eslint'
  | 'vscode-settings'
  | 'vscode-launch'
  | 'lerna'
  | 'babel'
  | 'prettier'
  | 'nest-cli'
  | 'angular'
  | 'composer'
  | 'generic';

function detectDialect(filePath: string): JsonDialect {
  const fn = filePath.toLowerCase().replace(/\\/g, '/');
  const baseName = fn.split('/').pop() ?? '';

  if (baseName === 'package.json') return 'package-json';
  if (baseName.startsWith('tsconfig') && baseName.endsWith('.json')) return 'tsconfig';
  if (baseName === '.eslintrc.json' || baseName === '.eslintrc') return 'eslint';
  if (fn.includes('.vscode/') && baseName === 'settings.json') return 'vscode-settings';
  if (fn.includes('.vscode/') && baseName === 'launch.json') return 'vscode-launch';
  if (baseName === 'launch.json') return 'vscode-launch';
  if (baseName === 'lerna.json') return 'lerna';
  if (baseName === '.babelrc' || baseName === 'babel.config.json') return 'babel';
  if (baseName === '.prettierrc' || baseName === '.prettierrc.json') return 'prettier';
  if (baseName === 'nest-cli.json') return 'nest-cli';
  if (baseName === 'angular.json') return 'angular';
  if (baseName === 'composer.json') return 'composer';

  return 'generic';
}

// ── Types ──────────────────────────────────────────────────────────────────

type AddFn = (name: string, kind: SymbolKind, meta?: Record<string, unknown>) => void;

// ── Dialect extractors ─────────────────────────────────────────────────────

function extractPackageJson(obj: Record<string, unknown>, add: AddFn, edges: RawEdge[]): void {
  // Name
  if (typeof obj.name === 'string') add(obj.name, 'constant', { jsonKind: 'packageName' });

  // Scripts
  if (obj.scripts && typeof obj.scripts === 'object') {
    for (const scriptName of Object.keys(obj.scripts as Record<string, unknown>)) {
      add(scriptName, 'function', { jsonKind: 'script' });
    }
  }

  // Dependencies → import edges
  for (const depKey of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = obj[depKey];
    if (deps && typeof deps === 'object') {
      const isDev = depKey !== 'dependencies';
      for (const [pkg, ver] of Object.entries(deps as Record<string, unknown>)) {
        edges.push({
          edgeType: 'imports',
          metadata: { module: pkg, version: ver, depType: depKey, dev: isDev, dialect: 'package-json' },
        });
      }
    }
  }

  // Also extract top-level keys as constants for backwards compatibility
  for (const key of Object.keys(obj)) {
    add(key, 'constant', { jsonKind: 'topLevelKey' });
  }
}

function extractTsconfig(obj: Record<string, unknown>, add: AddFn, edges: RawEdge[]): void {
  // compilerOptions keys
  if (obj.compilerOptions && typeof obj.compilerOptions === 'object') {
    for (const optKey of Object.keys(obj.compilerOptions as Record<string, unknown>)) {
      add(optKey, 'constant', { jsonKind: 'compilerOption' });
    }

    // paths aliases
    const co = obj.compilerOptions as Record<string, unknown>;
    if (co.paths && typeof co.paths === 'object') {
      for (const alias of Object.keys(co.paths as Record<string, unknown>)) {
        add(alias, 'constant', { jsonKind: 'pathAlias' });
      }
    }
  }

  // extends
  if (typeof obj.extends === 'string') {
    edges.push({ edgeType: 'imports', metadata: { module: obj.extends, dialect: 'tsconfig' } });
  }

  // Top-level keys
  for (const key of Object.keys(obj)) {
    add(key, 'constant', { jsonKind: 'topLevelKey' });
  }
}

function extractEslint(obj: Record<string, unknown>, add: AddFn, edges: RawEdge[]): void {
  // Rules
  if (obj.rules && typeof obj.rules === 'object') {
    for (const rule of Object.keys(obj.rules as Record<string, unknown>)) {
      add(rule, 'constant', { jsonKind: 'eslintRule' });
    }
  }

  // Extends
  const ext = obj.extends;
  if (typeof ext === 'string') {
    edges.push({ edgeType: 'imports', metadata: { module: ext, dialect: 'eslint' } });
  } else if (Array.isArray(ext)) {
    for (const e of ext) {
      if (typeof e === 'string') edges.push({ edgeType: 'imports', metadata: { module: e, dialect: 'eslint' } });
    }
  }

  // Plugins
  if (Array.isArray(obj.plugins)) {
    for (const p of obj.plugins) {
      if (typeof p === 'string') edges.push({ edgeType: 'imports', metadata: { module: p, dialect: 'eslint' } });
    }
  }
}

function extractVscodeSettings(obj: Record<string, unknown>, add: AddFn): void {
  for (const key of Object.keys(obj)) {
    add(key, 'constant', { jsonKind: 'vscodeSetting' });
  }
}

function extractVscodeLaunch(obj: Record<string, unknown>, add: AddFn): void {
  if (Array.isArray(obj.configurations)) {
    for (const config of obj.configurations) {
      if (config && typeof config === 'object' && typeof (config as Record<string, unknown>).name === 'string') {
        add((config as Record<string, unknown>).name as string, 'function', { jsonKind: 'launchConfig' });
      }
    }
  }
}

function extractLerna(obj: Record<string, unknown>, add: AddFn): void {
  if (Array.isArray(obj.packages)) {
    for (const pkg of obj.packages) {
      if (typeof pkg === 'string') add(pkg, 'constant', { jsonKind: 'lernaPackage' });
    }
  }
  for (const key of Object.keys(obj)) {
    add(key, 'constant', { jsonKind: 'topLevelKey' });
  }
}

function extractBabel(obj: Record<string, unknown>, add: AddFn, edges: RawEdge[]): void {
  if (Array.isArray(obj.presets)) {
    for (const p of obj.presets) {
      const name = typeof p === 'string' ? p : (Array.isArray(p) && typeof p[0] === 'string' ? p[0] : null);
      if (name) edges.push({ edgeType: 'imports', metadata: { module: name, dialect: 'babel' } });
    }
  }
  if (Array.isArray(obj.plugins)) {
    for (const p of obj.plugins) {
      const name = typeof p === 'string' ? p : (Array.isArray(p) && typeof p[0] === 'string' ? p[0] : null);
      if (name) edges.push({ edgeType: 'imports', metadata: { module: name, dialect: 'babel' } });
    }
  }
}

function extractPrettier(obj: Record<string, unknown>, add: AddFn): void {
  for (const key of Object.keys(obj)) {
    add(key, 'constant', { jsonKind: 'prettierOption' });
  }
}

function extractNestCli(obj: Record<string, unknown>, add: AddFn): void {
  if (obj.projects && typeof obj.projects === 'object') {
    for (const projName of Object.keys(obj.projects as Record<string, unknown>)) {
      add(projName, 'constant', { jsonKind: 'nestProject' });
    }
  }
  for (const key of Object.keys(obj)) {
    add(key, 'constant', { jsonKind: 'topLevelKey' });
  }
}

function extractAngular(obj: Record<string, unknown>, add: AddFn): void {
  if (obj.projects && typeof obj.projects === 'object') {
    const projects = obj.projects as Record<string, unknown>;
    for (const projName of Object.keys(projects)) {
      add(projName, 'namespace', { jsonKind: 'angularProject' });
      const proj = projects[projName];
      if (proj && typeof proj === 'object') {
        const architect = (proj as Record<string, unknown>).architect;
        if (architect && typeof architect === 'object') {
          for (const target of Object.keys(architect as Record<string, unknown>)) {
            add(target, 'function', { jsonKind: 'angularTarget', project: projName });
          }
        }
      }
    }
  }
}

function extractComposer(obj: Record<string, unknown>, add: AddFn, edges: RawEdge[]): void {
  // Name
  if (typeof obj.name === 'string') add(obj.name, 'constant', { jsonKind: 'composerName' });

  // require / require-dev → import edges
  for (const depKey of ['require', 'require-dev']) {
    const deps = obj[depKey];
    if (deps && typeof deps === 'object') {
      const isDev = depKey === 'require-dev';
      for (const [pkg, ver] of Object.entries(deps as Record<string, unknown>)) {
        edges.push({
          edgeType: 'imports',
          metadata: { module: pkg, version: ver, depType: depKey, dev: isDev, dialect: 'composer' },
        });
      }
    }
  }

  // Scripts
  if (obj.scripts && typeof obj.scripts === 'object') {
    for (const scriptName of Object.keys(obj.scripts as Record<string, unknown>)) {
      add(scriptName, 'function', { jsonKind: 'composerScript' });
    }
  }

  // Autoload namespaces
  for (const autoKey of ['autoload', 'autoload-dev']) {
    const autoload = obj[autoKey];
    if (autoload && typeof autoload === 'object') {
      for (const standard of ['psr-4', 'psr-0']) {
        const map = (autoload as Record<string, unknown>)[standard];
        if (map && typeof map === 'object') {
          for (const ns of Object.keys(map as Record<string, unknown>)) {
            add(ns, 'namespace', { jsonKind: 'autoloadNamespace', standard });
          }
        }
      }
    }
  }

  // Top-level keys
  for (const key of Object.keys(obj)) {
    add(key, 'constant', { jsonKind: 'topLevelKey' });
  }
}

function extractGenericJson(obj: Record<string, unknown>, add: AddFn): void {
  for (const key of Object.keys(obj)) {
    add(key, 'constant', { jsonKind: 'topLevelKey' });
  }
}

// ── Main plugin ────────────────────────────────────────────────────────────

export class JsonLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'json-language',
    version: '2.0.0',
    priority: 8,
  };

  supportedExtensions = ['.json', '.jsonc', '.json5'];

  extractSymbols(filePath: string, content: Buffer): TraceMcpResult<FileParseResult> {
    try {
      const source = content.toString('utf-8');
      const symbols: RawSymbol[] = [];
      const edges: RawEdge[] = [];
      const seen = new Set<string>();

      // Try parse — strip comments for JSONC
      let obj: unknown;
      try {
        obj = JSON.parse(source);
      } catch {
        try {
          obj = JSON.parse(stripJsonComments(source));
        } catch {
          // Unparseable — return empty
          return ok({ language: 'json', status: 'ok', symbols: [] });
        }
      }

      // We only extract from top-level objects
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        return ok({ language: 'json', status: 'ok', symbols: [] });
      }

      const record = obj as Record<string, unknown>;

      // Approximate line numbers from key positions in source
      const keyLines = new Map<string, number>();
      let lineNum = 1;
      let inStr = false;
      let escape = false;
      let keyBuf = '';
      let collectingKey = false;
      let braceDepth = 0;

      for (let i = 0; i < source.length; i++) {
        const ch = source[i];
        if (ch === '\n') { lineNum++; continue; }

        if (inStr) {
          if (escape) { escape = false; if (collectingKey) keyBuf += ch; continue; }
          if (ch === '\\') { escape = true; if (collectingKey) keyBuf += ch; continue; }
          if (ch === '"') {
            inStr = false;
            if (collectingKey) {
              // Check if next non-ws char is ':'
              let j = i + 1;
              while (j < source.length && (source[j] === ' ' || source[j] === '\t' || source[j] === '\r' || source[j] === '\n')) j++;
              if (j < source.length && source[j] === ':') {
                keyLines.set(`${braceDepth}:${keyBuf}`, lineNum);
              }
              keyBuf = '';
              collectingKey = false;
            }
          } else if (collectingKey) {
            keyBuf += ch;
          }
          continue;
        }

        if (ch === '{') { braceDepth++; continue; }
        if (ch === '}') { braceDepth--; continue; }
        if (ch === '[' || ch === ']') continue;
        if (ch === '"') {
          inStr = true;
          collectingKey = true;
          keyBuf = '';
          continue;
        }
      }

      const add: AddFn = (name: string, kind: SymbolKind, meta?: Record<string, unknown>) => {
        if (!name) return;
        const id = symId(filePath, name, kind);
        if (seen.has(id)) return;
        seen.add(id);
        // Try to find line number — check depth 1 first (top-level key), then any depth
        const ln = keyLines.get(`1:${name}`) ?? keyLines.get(`2:${name}`) ?? 1;
        symbols.push({
          symbolId: id, name, kind, fqn: name,
          byteStart: 0, byteEnd: name.length,
          lineStart: ln, lineEnd: ln,
          metadata: meta,
        });
      };

      const dialect = detectDialect(filePath);

      switch (dialect) {
        case 'package-json':
          extractPackageJson(record, add, edges);
          break;
        case 'tsconfig':
          extractTsconfig(record, add, edges);
          break;
        case 'eslint':
          extractEslint(record, add, edges);
          break;
        case 'vscode-settings':
          extractVscodeSettings(record, add);
          break;
        case 'vscode-launch':
          extractVscodeLaunch(record, add);
          break;
        case 'lerna':
          extractLerna(record, add);
          break;
        case 'babel':
          extractBabel(record, add, edges);
          break;
        case 'prettier':
          extractPrettier(record, add);
          break;
        case 'nest-cli':
          extractNestCli(record, add);
          break;
        case 'angular':
          extractAngular(record, add);
          break;
        case 'composer':
          extractComposer(record, add, edges);
          break;
        case 'generic':
        default:
          extractGenericJson(record, add);
          break;
      }

      return ok({
        language: 'json',
        status: 'ok',
        symbols,
        edges: edges.length > 0 ? edges : undefined,
        metadata: dialect !== 'generic' ? { jsonDialect: dialect } : undefined,
      });
    } catch {
      return ok({ language: 'json', status: 'ok', symbols: [] });
    }
  }
}
