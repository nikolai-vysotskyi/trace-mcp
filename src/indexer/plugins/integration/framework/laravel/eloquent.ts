/**
 * Eloquent model extraction — relationships, fillable, casts, scopes.
 * Uses regex on PHP source to detect relationship method calls and properties.
 */
import type { RawEdge } from '../../../../../plugin-api/types.js';

/** Relationship types we detect and their corresponding edge types. */
const RELATIONSHIP_MAP: Record<string, string> = {
  hasMany: 'has_many',
  belongsTo: 'belongs_to',
  belongsToMany: 'belongs_to_many',
  hasOne: 'has_one',
  morphTo: 'morphs_to',
  morphMany: 'has_many',
  morphOne: 'has_one',
  hasOneThrough: 'has_one',
  hasManyThrough: 'has_many',
};

interface EloquentRelationship {
  methodName: string;
  type: string; // e.g. 'hasMany'
  relatedClass: string; // FQN of related model
  edgeType: string; // e.g. 'has_many'
}

interface EloquentModelInfo {
  className: string;
  namespace: string | undefined;
  fqn: string;
  extendsModel: boolean;
  fillable: string[];
  casts: Record<string, string>;
  scopes: string[];
  relationships: EloquentRelationship[];
}

/**
 * Check if a PHP source file contains an Eloquent model class.
 * Returns the model info if found, null otherwise.
 */
export function extractEloquentModel(source: string, filePath: string): EloquentModelInfo | null {
  // Check for Model extends
  const classMatch = source.match(
    /class\s+(\w+)\s+extends\s+(?:\\?(?:Illuminate\\Database\\Eloquent\\)?)?Model\b/,
  );
  if (!classMatch) return null;

  const className = classMatch[1];
  const namespace = extractNamespaceFromSource(source);
  const fqn = namespace ? `${namespace}\\${className}` : className;
  const useMap = buildUseMap(source);

  return {
    className,
    namespace,
    fqn,
    extendsModel: true,
    fillable: extractFillable(source),
    casts: extractCasts(source),
    scopes: extractScopes(source),
    relationships: extractRelationships(source, useMap, namespace),
  };
}

/** Extract namespace from source. */
function extractNamespaceFromSource(source: string): string | undefined {
  const match = source.match(/namespace\s+([\w\\]+)\s*;/);
  return match ? match[1] : undefined;
}

/** Build a map of short class name -> FQN from use statements. */
function buildUseMap(source: string): Map<string, string> {
  const map = new Map<string, string>();
  const regex = /use\s+([\w\\]+?)(?:\s+as\s+(\w+))?;/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    const fqn = match[1];
    const alias = match[2] ?? fqn.split('\\').pop()!;
    map.set(alias, fqn);
  }
  return map;
}

/** Extract $fillable property values. */
function extractFillable(source: string): string[] {
  const match = source.match(/\$fillable\s*=\s*\[([\s\S]*?)\]/);
  if (!match) return [];

  const items: string[] = [];
  const regex = /['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(match[1])) !== null) {
    items.push(m[1]);
  }
  return items;
}

/** Extract $casts property. */
function extractCasts(source: string): Record<string, string> {
  const match = source.match(/\$casts\s*=\s*\[([\s\S]*?)\]/);
  if (!match) return {};

  const casts: Record<string, string> = {};
  const regex = /['"]([^'"]+)['"]\s*=>\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(match[1])) !== null) {
    casts[m[1]] = m[2];
  }
  return casts;
}

/** Extract scope method names (e.g. scopeActive -> active). */
function extractScopes(source: string): string[] {
  const scopes: string[] = [];
  const regex = /public\s+function\s+scope(\w+)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    // Convert first char to lowercase: scopeActive -> active
    const name = match[1].charAt(0).toLowerCase() + match[1].slice(1);
    scopes.push(name);
  }
  return scopes;
}

/** Extract Eloquent relationship method calls. */
function extractRelationships(
  source: string,
  useMap: Map<string, string>,
  namespace: string | undefined,
): EloquentRelationship[] {
  const relationships: EloquentRelationship[] = [];
  const relTypes = Object.keys(RELATIONSHIP_MAP).join('|');

  // Match: public function posts(): HasMany { return $this->hasMany(Post::class); }
  const regex = new RegExp(
    `public\\s+function\\s+(\\w+)\\s*\\([^)]*\\)(?:\\s*:\\s*\\w+)?\\s*\\{[^}]*\\$this->(${relTypes})\\s*\\(\\s*([\\w\\\\]+::class)`,
    'g',
  );

  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    const methodName = match[1];
    const relType = match[2];
    const classRef = match[3];
    const edgeType = RELATIONSHIP_MAP[relType];

    // Resolve the related class
    const relatedClass = resolveClassRef(classRef, useMap, namespace);

    relationships.push({
      methodName,
      type: relType,
      relatedClass,
      edgeType,
    });
  }

  return relationships;
}

/** Resolve a ::class reference to a FQN. */
function resolveClassRef(
  ref: string,
  useMap: Map<string, string>,
  namespace: string | undefined,
): string {
  // Fully qualified: \App\Models\Post::class
  const fqnMatch = ref.match(/^\\?([\w\\]+)::class$/);
  if (fqnMatch && fqnMatch[1].includes('\\')) return fqnMatch[1];

  // Short name: Post::class
  const shortMatch = ref.match(/^(\w+)::class$/);
  if (shortMatch) {
    const short = shortMatch[1];
    if (useMap.has(short)) return useMap.get(short)!;
    // Assume same namespace
    if (namespace) return `${namespace}\\${short}`;
    return short;
  }

  return ref;
}

/**
 * Build edges from an extracted model's relationships.
 * Maps model FQN -> related model FQN via edge type.
 */
function buildRelationshipEdges(modelInfo: EloquentModelInfo): RawEdge[] {
  return modelInfo.relationships.map((rel) => ({
    sourceSymbolId: undefined,
    targetSymbolId: undefined,
    edgeType: rel.edgeType,
    metadata: {
      sourceFqn: modelInfo.fqn,
      targetFqn: rel.relatedClass,
      method: rel.methodName,
      relationType: rel.type,
    },
  }));
}
