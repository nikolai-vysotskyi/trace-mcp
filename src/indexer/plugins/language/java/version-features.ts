/**
 * Java version feature mapping.
 * Maps AST constructs to the minimum Java version that introduced them.
 */

const JAVA_MIN_VERSION: Record<string, string> = {
  // Java 8 — lambda, method reference, default methods
  lambda_expression: '8',
  method_reference: '8',

  // Java 10 — var
  local_variable_type: '10', // tree-sitter may emit this for `var`

  // Java 14 — switch expressions, records (preview)
  switch_expression: '14',

  // Java 15 — text blocks
  text_block: '15',

  // Java 16 — records (final), pattern matching instanceof (final)
  record_declaration: '16',
  instanceof_expression: '16', // pattern form

  // Java 17 — sealed classes
  permits: '17',
};

/** Source-level patterns for Java features. */
const JAVA_SOURCE_PATTERNS: [RegExp, string, string][] = [
  // Java 8
  [/->/, '8', 'lambda expression'],

  // Java 10
  [/\bvar\s+\w+\s*=/, '10', 'local variable type inference (var)'],

  // Java 14 — switch expression with arrow
  [/case\s+.*->/, '14', 'switch expression (arrow case)'],

  // Java 15 — text blocks
  [/"""/, '15', 'text block'],

  // Java 16 — records
  [/\brecord\s+\w+\s*\(/, '16', 'record class'],
  // Java 16 — pattern matching instanceof
  [/instanceof\s+\w+\s+\w+/, '16', 'pattern matching instanceof'],

  // Java 17 — sealed classes
  [/\bsealed\s+(?:class|interface)\b/, '17', 'sealed class/interface'],
  [/\bpermits\s+/, '17', 'permits clause'],

  // Java 21 — record patterns, string templates (preview), virtual threads
  [/\bcase\s+\w+\s*\(/, '21', 'record pattern in switch'],
  [/Thread\.ofVirtual/, '21', 'virtual threads'],

  // Java 22 — unnamed variables
  [/\b_\s*[=,)]/, '22', 'unnamed variable (_)'],
];

/** Detect minimum Java version from AST node types. */
function _detectMinJavaVersion(nodeTypes: string[]): string | undefined {
  let max = 0;
  let result: string | undefined;
  for (const nt of nodeTypes) {
    const ver = JAVA_MIN_VERSION[nt];
    if (ver) {
      const num = Number(ver);
      if (num > max) {
        max = num;
        result = ver;
      }
    }
  }
  return result;
}

/** Detect minimum Java version from source patterns. */
export function detectMinJavaVersionFromSource(source: string): string | undefined {
  let max = 0;
  let result: string | undefined;
  for (const [re, ver] of JAVA_SOURCE_PATTERNS) {
    if (re.test(source)) {
      const num = Number(ver);
      if (num > max) {
        max = num;
        result = ver;
      }
    }
  }
  return result;
}
