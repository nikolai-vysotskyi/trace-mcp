/**
 * Python version feature mapping.
 * Maps AST constructs to the minimum Python version that introduced them.
 */

/** Minimum Python version required for specific AST constructs. */
const PYTHON_MIN_VERSION: Record<string, string> = {
  // Python 3.0
  'nonlocal_statement': '3.0',
  // Python 3.3
  'yield_from': '3.3',
  // Python 3.5
  'await_expression': '3.5',
  'async_function_definition': '3.5',
  // Python 3.6
  'format_string': '3.6',   // f-strings
  // Python 3.8
  'named_expression': '3.8', // walrus operator :=
  // Python 3.10
  'match_statement': '3.10',
  // Python 3.12
  'type_alias_statement': '3.12',
  'type_parameter': '3.12',
};

/**
 * Determine the minimum Python version required for a symbol based on its AST features.
 * Returns undefined if the symbol uses only pre-3.10 features.
 */
export function detectMinPythonVersion(nodeTypes: string[]): string | undefined {
  let maxVersion: string | undefined;
  for (const nt of nodeTypes) {
    const ver = PYTHON_MIN_VERSION[nt];
    if (ver && (!maxVersion || ver > maxVersion)) {
      maxVersion = ver;
    }
  }
  return maxVersion;
}
