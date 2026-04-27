/**
 * JSON Language Plugin — dialect-aware symbol extraction using tree-sitter.
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
import { ok, err } from 'neverthrow';
import type {
  LanguagePlugin,
  PluginManifest,
  FileParseResult,
  RawSymbol,
  RawEdge,
  SymbolKind,
} from '../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../errors.js';
import { parseError } from '../../../../errors.js';
import { getParser, type TSNode } from '../../../../parser/tree-sitter.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function symId(filePath: string, name: string, kind: string): string {
  return `${filePath}::${name}#${kind}`;
}

/** Strip single-line // and multi-line comments for JSONC parsing. */
function stripJsonComments(source: string): string {
  let result = '';
  let i = 0;
  let inString = false;
  let inEscape = false;

  while (i < source.length) {
    const ch = source[i];

    if (inString) {
      result += ch;
      if (inEscape) {
        inEscape = false;
      } else if (ch === '\\') {
        inEscape = true;
      } else if (ch === '"') {
        inString = false;
      }
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
      // Skip to end of line, preserving newline for correct line positions
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
        // Preserve newlines for correct line positions
        if (source[i] === '\n') result += '\n';
        i++;
      }
      continue;
    }

    result += ch;
    i++;
  }

  return result;
}

// ── Tree-sitter AST helpers ──────────────────────────────────────────────

/** Get the text of a string node, stripping surrounding quotes and unescaping JSON inEscapes */
function getStringText(node: TSNode | null): string | undefined {
  if (!node || node.type !== 'string') return undefined;
  const raw = node.text; // includes surrounding quotes, e.g. "App\\"
  // Use JSON.parse to properly uninEscape JSON string inEscapes
  try {
    return JSON.parse(raw) as string;
  } catch {
    // Fallback: just strip quotes if JSON.parse fails
    return raw.slice(1, -1);
  }
}

/** Get all pairs from an object node as a Map<key, valueNode> */
function getObjectEntries(
  obj: TSNode,
): Map<string, { keyNode: TSNode; valueNode: TSNode; pairNode: TSNode }> {
  const entries = new Map<string, { keyNode: TSNode; valueNode: TSNode; pairNode: TSNode }>();
  for (const child of obj.namedChildren) {
    if (child.type === 'pair') {
      const keyNode = child.childForFieldName('key');
      const keyText = getStringText(keyNode);
      const valueNode = child.childForFieldName('value');
      if (keyText && valueNode && keyNode)
        entries.set(keyText, { keyNode, valueNode, pairNode: child });
    }
  }
  return entries;
}

/** Get string values from an array node */
function getArrayStrings(arr: TSNode): string[] {
  const strings: string[] = [];
  for (const child of arr.namedChildren) {
    const text = getStringText(child);
    if (text !== undefined) strings.push(text);
  }
  return strings;
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
  | 'openapi'
  | 'generic';

function detectDialect(filePath: string, root?: TSNode): JsonDialect {
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

  // OpenAPI / Swagger — filename heuristics
  if (
    baseName === 'openapi.json' ||
    baseName === 'swagger.json' ||
    baseName.endsWith('.openapi.json') ||
    baseName.endsWith('-openapi.json') ||
    baseName.endsWith('.swagger.json')
  ) {
    return 'openapi';
  }

  // Content-based detection: top-level `openapi` or `swagger` key
  if (root) {
    const entries = getObjectEntries(root);
    if (entries.has('openapi') || entries.has('swagger')) return 'openapi';
  }

  return 'generic';
}

// ── Types ──────────────────────────────────────────────────────────────────

type AddFn = (name: string, kind: SymbolKind, node: TSNode, meta?: Record<string, unknown>) => void;

// ── Dialect extractors ─────────────────────────────────────────────────────

function extractPackageJson(root: TSNode, add: AddFn, edges: RawEdge[]): void {
  const entries = getObjectEntries(root);

  // Name
  const nameEntry = entries.get('name');
  if (nameEntry && nameEntry.valueNode.type === 'string') {
    add(getStringText(nameEntry.valueNode)!, 'constant', nameEntry.pairNode, {
      jsonKind: 'packageName',
    });
  }

  // Scripts
  const scriptsEntry = entries.get('scripts');
  if (scriptsEntry && scriptsEntry.valueNode.type === 'object') {
    for (const child of scriptsEntry.valueNode.namedChildren) {
      if (child.type === 'pair') {
        const key = getStringText(child.childForFieldName('key'));
        if (key) add(key, 'function', child, { jsonKind: 'script' });
      }
    }
  }

  // Dependencies → import edges
  for (const depKey of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    const depEntry = entries.get(depKey);
    if (depEntry && depEntry.valueNode.type === 'object') {
      const isDev = depKey !== 'dependencies';
      for (const child of depEntry.valueNode.namedChildren) {
        if (child.type === 'pair') {
          const pkg = getStringText(child.childForFieldName('key'));
          const ver = getStringText(child.childForFieldName('value'));
          if (pkg) {
            edges.push({
              edgeType: 'imports',
              metadata: {
                module: pkg,
                version: ver,
                depType: depKey,
                dev: isDev,
                dialect: 'package-json',
              },
            });
          }
        }
      }
    }
  }

  // Also extract top-level keys as constants for backwards compatibility
  for (const [key, entry] of entries) {
    add(key, 'constant', entry.pairNode, { jsonKind: 'topLevelKey' });
  }
}

function extractTsconfig(root: TSNode, add: AddFn, edges: RawEdge[]): void {
  const entries = getObjectEntries(root);

  // compilerOptions keys
  const coEntry = entries.get('compilerOptions');
  if (coEntry && coEntry.valueNode.type === 'object') {
    const coEntries = getObjectEntries(coEntry.valueNode);
    for (const [optKey, optEntry] of coEntries) {
      add(optKey, 'constant', optEntry.pairNode, { jsonKind: 'compilerOption' });
    }

    // paths aliases
    const pathsEntry = coEntries.get('paths');
    if (pathsEntry && pathsEntry.valueNode.type === 'object') {
      const pathEntries = getObjectEntries(pathsEntry.valueNode);
      for (const [alias, aliasEntry] of pathEntries) {
        add(alias, 'constant', aliasEntry.pairNode, { jsonKind: 'pathAlias' });
      }
    }
  }

  // extends
  const extendsEntry = entries.get('extends');
  if (extendsEntry && extendsEntry.valueNode.type === 'string') {
    const ext = getStringText(extendsEntry.valueNode);
    if (ext) edges.push({ edgeType: 'imports', metadata: { module: ext, dialect: 'tsconfig' } });
  }

  // Top-level keys
  for (const [key, entry] of entries) {
    add(key, 'constant', entry.pairNode, { jsonKind: 'topLevelKey' });
  }
}

function extractEslint(root: TSNode, add: AddFn, edges: RawEdge[]): void {
  const entries = getObjectEntries(root);

  // Rules
  const rulesEntry = entries.get('rules');
  if (rulesEntry && rulesEntry.valueNode.type === 'object') {
    for (const child of rulesEntry.valueNode.namedChildren) {
      if (child.type === 'pair') {
        const rule = getStringText(child.childForFieldName('key'));
        if (rule) add(rule, 'constant', child, { jsonKind: 'eslintRule' });
      }
    }
  }

  // Extends
  const extendsEntry = entries.get('extends');
  if (extendsEntry) {
    if (extendsEntry.valueNode.type === 'string') {
      const ext = getStringText(extendsEntry.valueNode);
      if (ext) edges.push({ edgeType: 'imports', metadata: { module: ext, dialect: 'eslint' } });
    } else if (extendsEntry.valueNode.type === 'array') {
      for (const e of getArrayStrings(extendsEntry.valueNode)) {
        edges.push({ edgeType: 'imports', metadata: { module: e, dialect: 'eslint' } });
      }
    }
  }

  // Plugins
  const pluginsEntry = entries.get('plugins');
  if (pluginsEntry && pluginsEntry.valueNode.type === 'array') {
    for (const p of getArrayStrings(pluginsEntry.valueNode)) {
      edges.push({ edgeType: 'imports', metadata: { module: p, dialect: 'eslint' } });
    }
  }
}

function extractVscodeSettings(root: TSNode, add: AddFn): void {
  const entries = getObjectEntries(root);
  for (const [key, entry] of entries) {
    add(key, 'constant', entry.pairNode, { jsonKind: 'vscodeSetting' });
  }
}

function extractVscodeLaunch(root: TSNode, add: AddFn): void {
  const entries = getObjectEntries(root);
  const configsEntry = entries.get('configurations');
  if (configsEntry && configsEntry.valueNode.type === 'array') {
    for (const child of configsEntry.valueNode.namedChildren) {
      if (child.type === 'object') {
        const configEntries = getObjectEntries(child);
        const nameEntry = configEntries.get('name');
        if (nameEntry && nameEntry.valueNode.type === 'string') {
          const name = getStringText(nameEntry.valueNode);
          if (name) add(name, 'function', child, { jsonKind: 'launchConfig' });
        }
      }
    }
  }
}

function extractLerna(root: TSNode, add: AddFn): void {
  const entries = getObjectEntries(root);

  const pkgsEntry = entries.get('packages');
  if (pkgsEntry && pkgsEntry.valueNode.type === 'array') {
    for (const child of pkgsEntry.valueNode.namedChildren) {
      const pkg = getStringText(child);
      if (pkg) add(pkg, 'constant', child, { jsonKind: 'lernaPackage' });
    }
  }

  for (const [key, entry] of entries) {
    add(key, 'constant', entry.pairNode, { jsonKind: 'topLevelKey' });
  }
}

function extractBabel(root: TSNode, _add: AddFn, edges: RawEdge[]): void {
  const entries = getObjectEntries(root);

  for (const arrayKey of ['presets', 'plugins']) {
    const arrEntry = entries.get(arrayKey);
    if (arrEntry && arrEntry.valueNode.type === 'array') {
      for (const child of arrEntry.valueNode.namedChildren) {
        let name: string | undefined;
        if (child.type === 'string') {
          name = getStringText(child);
        } else if (child.type === 'array') {
          // Array form: ["preset-name", { options }]
          name = getStringText(child.namedChildren[0]);
        }
        if (name) edges.push({ edgeType: 'imports', metadata: { module: name, dialect: 'babel' } });
      }
    }
  }
}

function extractPrettier(root: TSNode, add: AddFn): void {
  const entries = getObjectEntries(root);
  for (const [key, entry] of entries) {
    add(key, 'constant', entry.pairNode, { jsonKind: 'prettierOption' });
  }
}

function extractNestCli(root: TSNode, add: AddFn): void {
  const entries = getObjectEntries(root);

  const projectsEntry = entries.get('projects');
  if (projectsEntry && projectsEntry.valueNode.type === 'object') {
    for (const child of projectsEntry.valueNode.namedChildren) {
      if (child.type === 'pair') {
        const projName = getStringText(child.childForFieldName('key'));
        if (projName) add(projName, 'constant', child, { jsonKind: 'nestProject' });
      }
    }
  }

  for (const [key, entry] of entries) {
    add(key, 'constant', entry.pairNode, { jsonKind: 'topLevelKey' });
  }
}

function extractAngular(root: TSNode, add: AddFn): void {
  const entries = getObjectEntries(root);

  const projectsEntry = entries.get('projects');
  if (projectsEntry && projectsEntry.valueNode.type === 'object') {
    const projEntries = getObjectEntries(projectsEntry.valueNode);
    for (const [projName, projEntry] of projEntries) {
      add(projName, 'namespace', projEntry.pairNode, { jsonKind: 'angularProject' });

      if (projEntry.valueNode.type === 'object') {
        const projInnerEntries = getObjectEntries(projEntry.valueNode);
        const architectEntry = projInnerEntries.get('architect');
        if (architectEntry && architectEntry.valueNode.type === 'object') {
          for (const child of architectEntry.valueNode.namedChildren) {
            if (child.type === 'pair') {
              const target = getStringText(child.childForFieldName('key'));
              if (target)
                add(target, 'function', child, { jsonKind: 'angularTarget', project: projName });
            }
          }
        }
      }
    }
  }
}

function extractComposer(root: TSNode, add: AddFn, edges: RawEdge[]): void {
  const entries = getObjectEntries(root);

  // Name
  const nameEntry = entries.get('name');
  if (nameEntry && nameEntry.valueNode.type === 'string') {
    add(getStringText(nameEntry.valueNode)!, 'constant', nameEntry.pairNode, {
      jsonKind: 'composerName',
    });
  }

  // require / require-dev → import edges
  for (const depKey of ['require', 'require-dev']) {
    const depEntry = entries.get(depKey);
    if (depEntry && depEntry.valueNode.type === 'object') {
      const isDev = depKey === 'require-dev';
      for (const child of depEntry.valueNode.namedChildren) {
        if (child.type === 'pair') {
          const pkg = getStringText(child.childForFieldName('key'));
          const ver = getStringText(child.childForFieldName('value'));
          if (pkg) {
            edges.push({
              edgeType: 'imports',
              metadata: {
                module: pkg,
                version: ver,
                depType: depKey,
                dev: isDev,
                dialect: 'composer',
              },
            });
          }
        }
      }
    }
  }

  // Scripts
  const scriptsEntry = entries.get('scripts');
  if (scriptsEntry && scriptsEntry.valueNode.type === 'object') {
    for (const child of scriptsEntry.valueNode.namedChildren) {
      if (child.type === 'pair') {
        const scriptName = getStringText(child.childForFieldName('key'));
        if (scriptName) add(scriptName, 'function', child, { jsonKind: 'composerScript' });
      }
    }
  }

  // Autoload namespaces
  for (const autoKey of ['autoload', 'autoload-dev']) {
    const autoEntry = entries.get(autoKey);
    if (autoEntry && autoEntry.valueNode.type === 'object') {
      const autoEntries = getObjectEntries(autoEntry.valueNode);
      for (const standard of ['psr-4', 'psr-0']) {
        const mapEntry = autoEntries.get(standard);
        if (mapEntry && mapEntry.valueNode.type === 'object') {
          for (const child of mapEntry.valueNode.namedChildren) {
            if (child.type === 'pair') {
              const ns = getStringText(child.childForFieldName('key'));
              if (ns) add(ns, 'namespace', child, { jsonKind: 'autoloadNamespace', standard });
            }
          }
        }
      }
    }
  }

  // Top-level keys
  for (const [key, entry] of entries) {
    add(key, 'constant', entry.pairNode, { jsonKind: 'topLevelKey' });
  }
}

function extractOpenApiJson(root: TSNode, add: AddFn, edges: RawEdge[]): void {
  const entries = getObjectEntries(root);

  // Paths → endpoints + operationIds
  const pathsEntry = entries.get('paths');
  if (pathsEntry && pathsEntry.valueNode.type === 'object') {
    const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);
    for (const pathChild of pathsEntry.valueNode.namedChildren) {
      if (pathChild.type !== 'pair') continue;
      const pathName = getStringText(pathChild.childForFieldName('key'));
      const pathValue = pathChild.childForFieldName('value');
      if (!pathName || !pathValue || pathValue.type !== 'object') continue;

      for (const opChild of pathValue.namedChildren) {
        if (opChild.type !== 'pair') continue;
        const method = getStringText(opChild.childForFieldName('key'))?.toLowerCase();
        const opValue = opChild.childForFieldName('value');
        if (!method || !methods.has(method) || !opValue || opValue.type !== 'object') continue;

        const opEntries = getObjectEntries(opValue);
        const opIdNode = opEntries.get('operationId');
        const operationId =
          opIdNode?.valueNode.type === 'string' ? getStringText(opIdNode.valueNode) : undefined;
        const summaryNode = opEntries.get('summary');
        const summary =
          summaryNode?.valueNode.type === 'string'
            ? getStringText(summaryNode.valueNode)
            : undefined;
        const tagsNode = opEntries.get('tags');
        const tags =
          tagsNode?.valueNode.type === 'array' ? getArrayStrings(tagsNode.valueNode) : [];

        const meta: Record<string, unknown> = {
          jsonKind: 'endpoint',
          method: method.toUpperCase(),
          path: pathName,
        };
        if (operationId) meta.operationId = operationId;
        if (summary) meta.summary = summary;
        if (tags.length > 0) meta.tags = tags;

        add(`${method.toUpperCase()} ${pathName}`, 'function', opChild, meta);

        if (operationId) {
          add(operationId, 'function', opChild, {
            jsonKind: 'operationId',
            method: method.toUpperCase(),
            path: pathName,
            tags: tags.length > 0 ? tags : undefined,
          });
        }

        collectJsonRefs(opValue, edges);
      }
    }
  }

  // components.schemas / Swagger 2.0 definitions
  const componentsEntry = entries.get('components');
  if (componentsEntry && componentsEntry.valueNode.type === 'object') {
    const compEntries = getObjectEntries(componentsEntry.valueNode);
    const schemasEntry = compEntries.get('schemas');
    if (schemasEntry && schemasEntry.valueNode.type === 'object') {
      extractOpenApiSchemas(schemasEntry.valueNode, add, edges);
    }
  }
  const definitionsEntry = entries.get('definitions');
  if (definitionsEntry && definitionsEntry.valueNode.type === 'object') {
    extractOpenApiSchemas(definitionsEntry.valueNode, add, edges);
  }
}

function extractOpenApiSchemas(schemasObj: TSNode, add: AddFn, edges: RawEdge[]): void {
  for (const child of schemasObj.namedChildren) {
    if (child.type !== 'pair') continue;
    const name = getStringText(child.childForFieldName('key'));
    if (!name) continue;
    add(name, 'type', child, { jsonKind: 'schema' });
    const value = child.childForFieldName('value');
    if (value && (value.type === 'object' || value.type === 'array')) {
      collectJsonRefs(value, edges, name);
    }
  }
}

/**
 * Walk a JSON value tree collecting `$ref` strings as `imports` edges.
 * Mirrors the YAML implementation for OpenAPI JSON specs.
 */
function collectJsonRefs(node: TSNode, edges: RawEdge[], from?: string): void {
  if (node.type === 'object') {
    for (const child of node.namedChildren) {
      if (child.type !== 'pair') continue;
      const key = getStringText(child.childForFieldName('key'));
      const value = child.childForFieldName('value');
      if (!value) continue;
      if (key === '$ref' && value.type === 'string') {
        const ref = getStringText(value);
        if (ref) {
          const m = ref.match(/\/([^/]+)$/);
          const target = m ? m[1] : ref;
          const meta: Record<string, unknown> = { module: target, ref, dialect: 'openapi' };
          if (from) meta.from = from;
          edges.push({ edgeType: 'imports', metadata: meta });
        }
        continue;
      }
      if (value.type === 'object' || value.type === 'array') {
        collectJsonRefs(value, edges, from);
      }
    }
  } else if (node.type === 'array') {
    for (const child of node.namedChildren) {
      if (child.type === 'object' || child.type === 'array') {
        collectJsonRefs(child, edges, from);
      }
    }
  }
}

function extractGenericJson(root: TSNode, add: AddFn): void {
  const entries = getObjectEntries(root);
  for (const [key, entry] of entries) {
    add(key, 'constant', entry.pairNode, { jsonKind: 'topLevelKey' });
  }
}

// ── Main plugin ────────────────────────────────────────────────────────────

export class JsonLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'json-language',
    version: '3.0.0',
    priority: 8,
  };

  supportedExtensions = ['.json', '.jsonc', '.json5'];

  async extractSymbols(
    filePath: string,
    content: Buffer,
  ): Promise<TraceMcpResult<FileParseResult>> {
    try {
      const source = content.toString('utf-8');
      const symbols: RawSymbol[] = [];
      const edges: RawEdge[] = [];
      const seen = new Set<string>();

      // tree-sitter-json does not handle JSONC comments, so strip them first
      const cleanSource = stripJsonComments(source);

      const parser = await getParser('json');
      const tree = parser.parse(cleanSource);
      const rootNode = tree.rootNode;

      if (!rootNode || rootNode.namedChildCount === 0) {
        return ok({ language: 'json', status: 'ok', symbols: [] });
      }

      const hasError = rootNode.hasError;

      // Find the top-level object (document → object)
      let rootObject: TSNode | null = null;
      for (const child of rootNode.namedChildren) {
        if (child.type === 'object') {
          rootObject = child;
          break;
        }
      }

      // We only extract from top-level objects
      if (!rootObject) {
        return ok({ language: 'json', status: hasError ? 'partial' : 'ok', symbols: [] });
      }

      const add: AddFn = (
        name: string,
        kind: SymbolKind,
        node: TSNode,
        meta?: Record<string, unknown>,
      ) => {
        if (!name) return;
        const id = symId(filePath, name, kind);
        if (seen.has(id)) return;
        seen.add(id);
        symbols.push({
          symbolId: id,
          name,
          kind,
          fqn: name,
          byteStart: node.startIndex,
          byteEnd: node.endIndex,
          lineStart: node.startPosition.row + 1, // tree-sitter is 0-based
          lineEnd: node.endPosition.row + 1,
          metadata: meta,
        });
      };

      const dialect = detectDialect(filePath, rootObject);
      const warnings: string[] = [];

      if (hasError) {
        warnings.push('Source contains syntax errors; extraction may be incomplete');
      }

      switch (dialect) {
        case 'package-json':
          extractPackageJson(rootObject, add, edges);
          break;
        case 'tsconfig':
          extractTsconfig(rootObject, add, edges);
          break;
        case 'eslint':
          extractEslint(rootObject, add, edges);
          break;
        case 'vscode-settings':
          extractVscodeSettings(rootObject, add);
          break;
        case 'vscode-launch':
          extractVscodeLaunch(rootObject, add);
          break;
        case 'lerna':
          extractLerna(rootObject, add);
          break;
        case 'babel':
          extractBabel(rootObject, add, edges);
          break;
        case 'prettier':
          extractPrettier(rootObject, add);
          break;
        case 'nest-cli':
          extractNestCli(rootObject, add);
          break;
        case 'angular':
          extractAngular(rootObject, add);
          break;
        case 'composer':
          extractComposer(rootObject, add, edges);
          break;
        case 'openapi':
          extractOpenApiJson(rootObject, add, edges);
          break;
        default:
          extractGenericJson(rootObject, add);
          break;
      }

      return ok({
        language: 'json',
        status: hasError ? 'partial' : 'ok',
        symbols,
        edges: edges.length > 0 ? edges : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
        metadata: dialect !== 'generic' ? { jsonDialect: dialect } : undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(parseError(filePath, `JSON parse failed: ${msg}`));
    }
  }
}
