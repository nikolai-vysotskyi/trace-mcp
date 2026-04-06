/**
 * Go version feature mapping.
 * Maps AST constructs to the minimum Go version that introduced them.
 */

const GO_MIN_VERSION: Record<string, string> = {
  // Go 1.18 — generics
  'type_parameter_list': '1.18',
  'type_constraint': '1.18',

  // Go 1.21 — min/max/clear builtins, log/slog
  // (API only, no AST signal)

  // Go 1.22 — range over integers, loop variable semantics change
  'range_over_int': '1.22',
};

/** Source-level patterns for Go features. */
const GO_SOURCE_PATTERNS: [RegExp, string, string][] = [
  // Go 1.13 — binary literals, digit separators
  [/0b[01]/, '1.13', 'binary literal'],
  [/\d_\d/, '1.13', 'digit separator'],

  // Go 1.16 — embed directive
  [/\/\/go:embed\b/, '1.16', '//go:embed'],

  // Go 1.18 — generics (~constraint, any)
  [/\bany\b/, '1.18', 'any type'],
  [/~\w+/, '1.18', 'type constraint (~)'],
  [/\[T\s/, '1.18', 'generic type parameter'],

  // Go 1.21 — builtins
  [/\bmin\s*\(/, '1.21', 'min() builtin'],
  [/\bmax\s*\(/, '1.21', 'max() builtin'],
  [/\bclear\s*\(/, '1.21', 'clear() builtin'],
  [/\blog\/slog\b/, '1.21', 'log/slog package'],

  // Go 1.22 — range over int
  [/range\s+\d/, '1.22', 'range over integer'],

  // Go 1.23 — iterators (range over func)
  [/range\s+\w+\s*\(/, '1.23', 'range over function (iterators)'],
];

function semverGt(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return true;
    if (na < nb) return false;
  }
  return false;
}

/** Detect minimum Go version from AST node types. */
function detectMinGoVersion(nodeTypes: string[]): string | undefined {
  let max = '0';
  for (const nt of nodeTypes) {
    const ver = GO_MIN_VERSION[nt];
    if (ver && semverGt(ver, max)) max = ver;
  }
  return max !== '0' ? max : undefined;
}

/** Detect minimum Go version from source patterns. */
export function detectMinGoVersionFromSource(source: string): string | undefined {
  let max = '0';
  for (const [re, ver] of GO_SOURCE_PATTERNS) {
    if (re.test(source)) {
      if (semverGt(ver, max)) max = ver;
    }
  }
  return max !== '0' ? max : undefined;
}
