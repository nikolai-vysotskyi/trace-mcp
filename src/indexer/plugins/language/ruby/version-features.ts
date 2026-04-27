/**
 * Ruby version feature mapping.
 * Maps AST constructs and source patterns to the minimum Ruby version.
 */

const RUBY_MIN_VERSION: Record<string, string> = {
  // Ruby 2.0 — keyword arguments, lazy enumerator
  keyword_parameter: '2.0',

  // Ruby 2.3 — frozen string literal, safe navigation (&.)
  safe_navigation: '2.3',

  // Ruby 2.6 — endless range
  endless_range: '2.6',

  // Ruby 2.7 — pattern matching (experimental), numbered block params
  case_match: '2.7',
  in_clause: '2.7',

  // Ruby 3.0 — pattern matching (stable), ractor, one-line method
  find_pattern: '3.0',
};

/** Source-level patterns for Ruby features. */
const RUBY_SOURCE_PATTERNS: [RegExp, string, string][] = [
  // Ruby 2.0 — keyword arguments
  [/def\s+\w+\s*\(\s*\w+:/, '2.0', 'keyword arguments'],

  // Ruby 2.3 — safe navigation operator
  [/&\./, '2.3', 'safe navigation operator (&.)'],
  // Ruby 2.3 — frozen string literal pragma
  [/#\s*frozen_string_literal:\s*true/, '2.3', 'frozen_string_literal pragma'],

  // Ruby 2.5 — rescue/else/ensure in do/end blocks
  [/\brescue\b.*\bensure\b/, '2.5', 'rescue in do/end'],

  // Ruby 2.6 — endless range
  [/\d+\.\.(?!\d)/, '2.6', 'endless range (1..)'],

  // Ruby 2.7 — pattern matching, numbered block params
  [/\bin\s+\[/, '2.7', 'array pattern matching'],
  [/_1\b/, '2.7', 'numbered block parameter (_1)'],
  [/\.\.\.\s*\)/, '2.7', 'argument forwarding (...)'],

  // Ruby 3.0 — one-line pattern matching (=>, in)
  [/=>\s*\w+/, '3.0', 'one-line pattern matching (=>)'],
  // Ruby 3.0 — ractor
  [/Ractor\.new/, '3.0', 'Ractor'],

  // Ruby 3.1 — hash shorthand, pin operator in pattern matching
  [/\bpin\b/, '3.1', 'pin operator in pattern matching'],

  // Ruby 3.2 — Data.define
  [/Data\.define/, '3.2', 'Data.define'],
  // Ruby 3.2 — anonymous rest/keyword rest forwarding (*, **)
  [/def\s+\w+\s*\(\s*\*\s*\)/, '3.2', 'anonymous rest forwarding'],

  // Ruby 3.3 — it block parameter (experimental)
  [/\bit\b/, '3.3', 'it block parameter'],
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

/** Detect minimum Ruby version from AST node types. */
function detectMinRubyVersion(nodeTypes: string[]): string | undefined {
  let max = '0';
  for (const nt of nodeTypes) {
    const ver = RUBY_MIN_VERSION[nt];
    if (ver && semverGt(ver, max)) max = ver;
  }
  return max !== '0' ? max : undefined;
}

/** Detect minimum Ruby version from source patterns. */
export function detectMinRubyVersionFromSource(source: string): string | undefined {
  let max = '0';
  for (const [re, ver] of RUBY_SOURCE_PATTERNS) {
    if (re.test(source)) {
      if (semverGt(ver, max)) max = ver;
    }
  }
  return max !== '0' ? max : undefined;
}
