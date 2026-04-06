/**
 * Kotlin version feature mapping.
 * Maps source-level patterns to the minimum Kotlin version that introduced them.
 *
 * Note: Kotlin plugin uses regex-based parsing (no tree-sitter), so
 * detection is source-pattern only.
 */

const KOTLIN_SOURCE_PATTERNS: [RegExp, string, string][] = [
  // Kotlin 1.1 — coroutines (experimental), type aliases
  [/\btypealias\s+/, '1.1', 'type alias'],

  // Kotlin 1.3 — coroutines stable, inline classes (experimental)
  [/\bsuspend\s+fun\b/, '1.3', 'suspend function (coroutines stable)'],
  [/\binline\s+class\b/, '1.3', 'inline class (experimental)'],

  // Kotlin 1.4 — SAM conversions, trailing commas
  [/\bfun\s+interface\b/, '1.4', 'functional (SAM) interface'],

  // Kotlin 1.5 — value classes (stable), sealed interfaces
  [/@JvmInline\s+value\s+class/, '1.5', 'value class'],
  [/\bsealed\s+interface\b/, '1.5', 'sealed interface'],

  // Kotlin 1.6 — exhaustive when, suspend conversion
  // (hard to detect from source alone)

  // Kotlin 1.7 — definitely non-nullable types (T & Any), builder inference
  [/\w+\s*&\s*Any/, '1.7', 'definitely non-nullable type (T & Any)'],

  // Kotlin 1.8 — java synthetic property references, stdlib improvements
  [/\.javaClass\b/, '1.8', '.javaClass reference'],

  // Kotlin 1.9 — enum entries, data objects, ..rangeUntil
  [/\bdata\s+object\b/, '1.9', 'data object'],
  [/\.\.</, '1.9', 'rangeUntil operator (..<)'],
  [/\.entries\b/, '1.9', 'enum entries property'],

  // Kotlin 2.0 — K2 compiler, context parameters (experimental), smart cast improvements
  [/\bcontext\s*\(/, '2.0', 'context parameters (K2)'],

  // Kotlin 2.1 — guard conditions in when, non-local break/continue
  [/\bif\s+.*->/, '2.1', 'guard condition in when'],
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

/** Detect minimum Kotlin version from source patterns. */
export function detectMinKotlinVersion(source: string): string | undefined {
  let max = '0';
  for (const [re, ver] of KOTLIN_SOURCE_PATTERNS) {
    if (re.test(source)) {
      if (semverGt(ver, max)) max = ver;
    }
  }
  return max !== '0' ? max : undefined;
}
