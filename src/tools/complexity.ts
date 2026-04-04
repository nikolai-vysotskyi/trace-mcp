/**
 * Text-based complexity metrics for code symbols.
 *
 * Computes:
 * - Cyclomatic complexity (branch keyword counting)
 * - Max nesting depth (brace/bracket counting)
 * - Parameter count (parsed from signature)
 *
 * Regex-based, no AST needed.
 */

// ── Branch keywords by language family ──────────────────────────────────

const BRANCH_KEYWORDS_DEFAULT =
  /\b(if|else\s+if|elif|for|while|do|switch|case|catch|except)\b|&&|\|\||\?\?|\?(?=\s*[^?])/g;

const BRANCH_KEYWORDS_BY_LANG: Record<string, RegExp> = {
  python: /\b(if|elif|for|while|except|and|or|assert|with)\b/g,
  ruby: /\b(if|elsif|unless|for|while|until|when|rescue|and|or)\b/g,
  go: /\b(if|for|switch|case|select|&&|\|\|)\b/g,
};

// ── String / comment stripping ──────────────────────────────────────────

/** Remove string literals and comments to avoid false positives. */
function stripStringsAndComments(source: string): string {
  // Remove block comments  /* ... */
  let s = source.replace(/\/\*[\s\S]*?\*\//g, '');
  // Remove line comments  // ...
  s = s.replace(/\/\/.*$/gm, '');
  // Remove Python-style comments  # ...
  s = s.replace(/#.*$/gm, '');
  // Remove template literals, double-quoted and single-quoted strings
  s = s.replace(/`[^`]*`/g, '""');
  s = s.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  s = s.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  return s;
}

// ── Cyclomatic complexity ───────────────────────────────────────────────

export function computeCyclomatic(source: string, language?: string): number {
  const clean = stripStringsAndComments(source);
  const pattern =
    BRANCH_KEYWORDS_BY_LANG[language ?? ''] ?? BRANCH_KEYWORDS_DEFAULT;
  // Reset regex state (global flag)
  pattern.lastIndex = 0;
  const matches = clean.match(pattern);
  return 1 + (matches?.length ?? 0);
}

// ── Max nesting depth ───────────────────────────────────────────────────

export function computeMaxNesting(source: string): number {
  const clean = stripStringsAndComments(source);
  let depth = 0;
  let max = 0;
  for (const ch of clean) {
    if (ch === '{') {
      depth++;
      if (depth > max) max = depth;
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1);
    }
  }
  return max;
}

// ── Parameter count ─────────────────────────────────────────────────────

/** Parse parameter count from a function/method signature. */
export function computeParamCount(signature: string | null | undefined): number {
  if (!signature) return 0;

  // Find the first top-level parenthesized group
  const start = signature.indexOf('(');
  if (start === -1) return 0;

  // Walk forward tracking nesting to find matching close
  let depth = 0;
  let end = -1;
  for (let i = start; i < signature.length; i++) {
    const ch = signature[i];
    if (ch === '(' || ch === '<' || ch === '[') depth++;
    else if (ch === ')' || ch === '>' || ch === ']') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return 0;

  const inner = signature.slice(start + 1, end).trim();
  if (inner === '' || inner === 'void') return 0;

  // Split by commas at depth 0, then filter out empty segments
  const segments: string[] = [];
  let current = '';
  depth = 0;
  for (const ch of inner) {
    if (ch === '(' || ch === '<' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === '>' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      segments.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  segments.push(current.trim());
  return segments.filter(Boolean).length;
}

// ── Combined metrics ────────────────────────────────────────────────────

export interface ComplexityMetrics {
  cyclomatic: number;
  max_nesting: number;
  param_count: number;
  lines: number;
}

export function computeComplexity(
  source: string,
  signature?: string | null,
  language?: string,
): ComplexityMetrics {
  return {
    cyclomatic: computeCyclomatic(source, language),
    max_nesting: computeMaxNesting(source),
    param_count: computeParamCount(signature),
    lines: source.split('\n').length,
  };
}
