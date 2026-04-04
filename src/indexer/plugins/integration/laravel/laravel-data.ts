/**
 * spatie/laravel-data extraction.
 *
 * Extracts:
 * - Data class constructor → typed field list
 * - Nested Data class properties → data_nests edges
 * - DataCollection<PostData> type hints → data_collects edges
 * - fromModel(Model $m) / ::from($model) → data_maps_from edges
 * - Inertia::render with Data objects → typed props (enriches InertiaPlugin)
 */
import type { RawEdge } from '../../../../plugin-api/types.js';

// ─── Interfaces ──────────────────────────────────────────────

export interface DataClassInfo {
  className: string;
  namespace: string;
  fqn: string;
  /** Constructor promoted properties */
  fields: DataField[];
  /** Nested Data class FQNs from typed properties */
  nestedDataClasses: string[];
  /** Element Data class FQNs from DataCollection<T> */
  collectedDataClasses: string[];
  /** Eloquent model FQNs this DTO can be created from */
  sourceModels: string[];
}

export interface DataField {
  name: string;
  type: string | null;
  nullable: boolean;
  mapFrom: string | null; // from #[MapFrom('...')]
}

export interface InertiaDataProp {
  propKey: string;
  dataClass: string; // FQN of Data class
  isCollection: boolean;
}

// ─── Detection ────────────────────────────────────────────────

const NAMESPACE_RE = /namespace\s+([\w\\]+)\s*;/;
const CLASS_NAME_RE = /class\s+(\w+)/;
const USE_STMT_RE = /use\s+([\w\\]+?)(?:\s+as\s+(\w+))?;/g;

const EXTENDS_DATA_RE = /class\s+\w+\s+extends\s+(?:[\w\\]*\\)?Data\b/;

// ─── Data class extraction ────────────────────────────────────

export function extractDataClass(
  source: string,
  _filePath: string,
): DataClassInfo | null {
  if (!EXTENDS_DATA_RE.test(source)) return null;

  const useMap = buildUseMap(source);
  const nsMatch = source.match(NAMESPACE_RE);
  const namespace = nsMatch?.[1] ?? '';
  const classMatch = source.match(CLASS_NAME_RE);
  if (!classMatch) return null;
  const className = classMatch[1];
  const fqn = namespace ? `${namespace}\\${className}` : className;

  const PRIMITIVES = new Set(['string','int','float','bool','array','object','null','mixed','void','never','callable','iterable','self','static','parent']);
  const fields = extractConstructorFields(source, useMap);
  // Qualify any short type names that weren't resolved via use map (skip primitives)
  for (const f of fields) {
    if (f.type && !f.type.includes('\\') && !PRIMITIVES.has(f.type)) {
      f.type = qualifyWithNs(f.type, namespace);
    }
  }
  const nestedDataClasses = extractNestedDataClasses(fields, source, useMap, namespace);
  const collectedDataClasses = extractCollectedDataClasses(source, useMap, namespace);
  const sourceModels = extractSourceModels(source, useMap);

  return { className, namespace, fqn, fields, nestedDataClasses, collectedDataClasses, sourceModels };
}

/**
 * Detect Inertia::render() calls that pass Data objects as props.
 * Returns a map of prop key → Data class FQN.
 */
export function extractInertiaDataProps(source: string): InertiaDataProp[] {
  const results: InertiaDataProp[] = [];
  const useMap = buildUseMap(source);

  // Match Inertia::render('Page', [...]) or inertia('Page', [...])
  const renderRe = /(?:Inertia::render|inertia)\(\s*['"][\w/.-]+['"]\s*,\s*\[([\s\S]*?)\]\s*\)/g;
  let rMatch: RegExpExecArray | null;
  while ((rMatch = renderRe.exec(source)) !== null) {
    const propsBlock = rMatch[1];

    // Look for: 'key' => DataClass::from(...) or DataClass::collect(...)
    const propRe = /['"](\w+)['"]\s*=>\s*([\w\\]+)::(from|collect)\s*\(/g;
    let pMatch: RegExpExecArray | null;
    while ((pMatch = propRe.exec(propsBlock)) !== null) {
      results.push({
        propKey: pMatch[1],
        dataClass: resolveClass(pMatch[2], useMap),
        isCollection: pMatch[3] === 'collect',
      });
    }
  }

  return results;
}

// ─── Edge builders ────────────────────────────────────────────

export function buildDataClassEdges(info: DataClassInfo): RawEdge[] {
  const edges: RawEdge[] = [];

  for (const nestedFqn of info.nestedDataClasses) {
    edges.push({
      edgeType: 'data_nests',
      metadata: { sourceFqn: info.fqn, targetFqn: nestedFqn },
    });
  }

  for (const collectedFqn of info.collectedDataClasses) {
    edges.push({
      edgeType: 'data_collects',
      metadata: { sourceFqn: info.fqn, targetFqn: collectedFqn },
    });
  }

  for (const modelFqn of info.sourceModels) {
    edges.push({
      edgeType: 'data_maps_from',
      metadata: { sourceFqn: info.fqn, targetFqn: modelFqn },
    });
  }

  return edges;
}

// ─── Internal helpers ─────────────────────────────────────────

function buildUseMap(source: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = new RegExp(USE_STMT_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const fqn = match[1];
    const alias = match[2] ?? fqn.split('\\').pop()!;
    map.set(alias, fqn);
  }
  return map;
}

function resolveClass(ref: string, useMap: Map<string, string>): string {
  const clean = ref.startsWith('\\') ? ref.slice(1) : ref;
  if (clean.includes('\\')) return clean;
  return useMap.get(clean) ?? clean;
}

/**
 * Extract promoted constructor properties (PHP 8 constructor promotion).
 * Handles: public string $name, public ?string $avatar = null,
 * #[MapFrom('created_at')] public CarbonImmutable $memberSince
 */
function extractConstructorFields(
  source: string,
  useMap: Map<string, string>,
): DataField[] {
  const fields: DataField[] = [];

  // Find constructor body
  const ctorMatch = source.match(
    /function\s+__construct\s*\(([\s\S]*?)\)\s*(?::\s*[\w\\|]+\s*)?\{/,
  );
  if (!ctorMatch) return fields;

  const body = ctorMatch[1];

  // Match each promoted property (may have attributes above)
  // Pattern: optional #[...attrs...] then public [readonly] [?]Type $name [= default]
  const propRe = /(?:#\[MapFrom\(\s*['"]([^'"]+)['"]\s*\)\]\s*)?public\s+(?:readonly\s+)?(\??\s*[\w\\|]+)\s+\$(\w+)/g;
  let match: RegExpExecArray | null;
  while ((match = propRe.exec(body)) !== null) {
    const mapFrom = match[1] ?? null;
    const typeRaw = match[2].trim();
    const name = match[3];
    const nullable = typeRaw.startsWith('?');
    const type = nullable ? typeRaw.slice(1).trim() : typeRaw;

    fields.push({
      name,
      type: resolveClass(type, useMap),
      nullable,
      mapFrom,
    });
  }

  return fields;
}

/**
 * Find typed properties that are themselves Data subclasses.
 * Uses heuristic: type is imported from a namespace containing 'Data'
 * OR type name ends with 'Data'.
 */
function extractNestedDataClasses(
  fields: DataField[],
  source: string,
  _useMap: Map<string, string>,
  namespace: string,
): string[] {
  const results: string[] = [];

  for (const field of fields) {
    if (!field.type) continue;
    // Skip primitives
    if (/^(string|int|float|bool|array|object|null|mixed|void|never)$/.test(field.type)) continue;
    // Skip DataCollection itself
    if (field.type.includes('DataCollection') || field.type.includes('Collection')) continue;
    // Heuristic: type name (short or FQN) ends with 'Data'
    const shortName = field.type.split('\\').pop() ?? '';
    if (shortName.endsWith('Data')) {
      results.push(field.type);
    }
  }

  // Also check class body for typed properties (non-constructor style)
  const useMap = buildUseMap(source);
  const propRe = /public\s+(?:readonly\s+)?([\w\\]+Data)\s+\$\w+/g;
  let match: RegExpExecArray | null;
  while ((match = propRe.exec(source)) !== null) {
    let resolved = resolveClass(match[1], useMap);
    if (!resolved.includes('\\')) resolved = qualifyWithNs(resolved, namespace);
    if (!results.includes(resolved)) results.push(resolved);
  }

  return [...new Set(results)];
}

/**
 * Extract DataCollection<ElementType> type hints.
 * Looks for: DataCollection $posts (with @var DataCollection<PostData>)
 * or: DataCollection<PostData> in docblocks.
 */
function extractCollectedDataClasses(
  source: string,
  useMap: Map<string, string>,
  namespace: string,
): string[] {
  const results: string[] = [];

  const qualify = (ref: string) => {
    let resolved = resolveClass(ref, useMap);
    if (!resolved.includes('\\')) resolved = qualifyWithNs(resolved, namespace);
    return resolved;
  };

  // DataCollection<PostData> anywhere in source
  const docRe = /DataCollection<([\w\\]+)>/g;
  let match: RegExpExecArray | null;
  while ((match = docRe.exec(source)) !== null) {
    results.push(qualify(match[1]));
  }

  // @var DataCollection<PostData>
  const varRe = /@var\s+DataCollection<([\w\\]+)>/g;
  while ((match = varRe.exec(source)) !== null) {
    results.push(qualify(match[1]));
  }

  return [...new Set(results)];
}

/**
 * Detect Eloquent models this Data class can be constructed from.
 * Patterns:
 * - public static function fromModel(User $user): static
 * - ::from($model) where $model is typed as an Eloquent model
 * - Constructor with param typed as Eloquent model
 */
function extractSourceModels(
  source: string,
  useMap: Map<string, string>,
): string[] {
  const results: string[] = [];

  // Pattern 1: explicit fromModel(ModelType $param)
  const fromModelRe = /function\s+from\w*\(\s*([\w\\]+)\s+\$\w+/g;
  let match: RegExpExecArray | null;
  while ((match = fromModelRe.exec(source)) !== null) {
    const type = resolveClass(match[1], useMap);
    if (isEloquentLike(type, useMap)) {
      results.push(type);
    }
  }

  // Pattern 2: constructor promoted property typed as Eloquent model
  // Data::from($model) is convention-based — look for Model types in constructor
  const ctorMatch = source.match(/function\s+__construct\s*\(([\s\S]*?)\)\s*(?::\s*\w+\s*)?\{/);
  if (ctorMatch) {
    const ctorBody = ctorMatch[1];
    const paramRe = /public\s+(?:readonly\s+)?(\??\s*[\w\\]+)\s+\$\w+/g;
    while ((match = paramRe.exec(ctorBody)) !== null) {
      const typeRaw = match[1].replace(/^\?\s*/, '').trim();
      const resolved = resolveClass(typeRaw, useMap);
      if (isEloquentLike(resolved, useMap)) {
        results.push(resolved);
      }
    }
  }

  return [...new Set(results)];
}

function isEloquentLike(fqn: string, _useMap: Map<string, string>): boolean {
  return /\\Models\\/.test(fqn) || /^App\\Models\\/.test(fqn);
}

/** Qualify a short unresolved name with the current namespace */
function qualifyWithNs(shortName: string, namespace: string): string {
  if (!shortName || shortName.includes('\\')) return shortName;
  if (!namespace) return shortName;
  return `${namespace}\\${shortName}`;
}
