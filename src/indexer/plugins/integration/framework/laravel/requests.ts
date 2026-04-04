/**
 * Laravel FormRequest detection and rule extraction.
 * Detects classes extending FormRequest and extracts validation rules.
 */

export interface FormRequestInfo {
  className: string;
  namespace: string | undefined;
  fqn: string;
  rules: Record<string, string>;
}

/**
 * Check if a PHP source file contains a FormRequest class.
 * Returns the form request info if found, null otherwise.
 */
export function extractFormRequest(source: string): FormRequestInfo | null {
  // Check for FormRequest extends
  const classMatch = source.match(
    /class\s+(\w+)\s+extends\s+(?:\\?(?:Illuminate\\Foundation\\Http\\)?)?FormRequest\b/,
  );
  if (!classMatch) return null;

  const className = classMatch[1];
  const namespace = extractNamespace(source);
  const fqn = namespace ? `${namespace}\\${className}` : className;

  return {
    className,
    namespace,
    fqn,
    rules: extractRules(source),
  };
}

/** Extract namespace from source. */
function extractNamespace(source: string): string | undefined {
  const match = source.match(/namespace\s+([\w\\]+)\s*;/);
  return match ? match[1] : undefined;
}

/** Extract the rules() method return array. */
function extractRules(source: string): Record<string, string> {
  const rules: Record<string, string> = {};

  // Match rules() method body
  const methodMatch = source.match(
    /function\s+rules\s*\(\s*\)(?:\s*:\s*array)?\s*\{([\s\S]*?)\breturn\s*\[([\s\S]*?)\]\s*;/,
  );
  if (!methodMatch) return rules;

  const body = methodMatch[2];
  const regex = /['"]([^'"]+)['"]\s*=>\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(body)) !== null) {
    rules[match[1]] = match[2];
  }

  return rules;
}

/**
 * Detect FormRequest type-hints in controller method parameters.
 * Returns an array of { methodName, requestFqn } pairs.
 */
export function detectFormRequestUsage(
  source: string,
): { methodName: string; requestClass: string }[] {
  const results: { methodName: string; requestClass: string }[] = [];
  const useMap = buildUseMap(source);

  // Match: public function store(StoreUserRequest $request)
  const regex = /public\s+function\s+(\w+)\s*\(\s*(\w+)\s+\$\w+/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    const methodName = match[1];
    const typeHint = match[2];

    // Resolve to FQN if it's in use map
    const fqn = useMap.get(typeHint) ?? typeHint;

    // Only include if it looks like a Request class
    if (typeHint.endsWith('Request') || fqn.includes('Request')) {
      results.push({ methodName, requestClass: fqn });
    }
  }

  return results;
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
