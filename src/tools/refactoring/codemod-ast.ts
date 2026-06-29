/**
 * AST-aware codemod engine backed by `@ast-grep/napi`.
 *
 * Why AST instead of regex: a regex `\bfoo\b` happily matches `foo` inside a
 * string literal or a `// foo()` comment, producing false rewrites. ast-grep
 * matches real syntax nodes only, so `foo($$$ARGS)` rewrites genuine call
 * expressions and leaves strings/comments byte-for-byte intact.
 *
 * IMPORTANT API reality (verified against @ast-grep/napi v0.44): the napi
 * binding is a *matcher*, not a YAML rewrite-DSL executor. `node.replace(text)`
 * does NOT substitute metavariables — it takes a literal string. We therefore
 * build the replacement string ourselves in JS from the captured metavars:
 *   - `$A`           → node.getMatch('A')          (single capture)
 *   - `$$$ARGS`      → node.getMultipleMatches('ARGS')  (variadic splice)
 *   - `$1` / `$2`    → positional aliases over the ordered single metavars
 *     discovered in the pattern (left-to-right)
 *
 * `commitEdits(edits)` (called on SgRoot) applies a batch of non-overlapping
 * edits and returns the rewritten source — we never hand-splice byte offsets.
 */

import { Lang, parse } from '@ast-grep/napi';
import path from 'node:path';

/** Extensions we route through the AST engine, mapped to an ast-grep Lang. */
const EXT_TO_LANG: Record<string, Lang> = {
  '.ts': Lang.TypeScript,
  '.mts': Lang.TypeScript,
  '.cts': Lang.TypeScript,
  '.tsx': Lang.Tsx,
  '.js': Lang.JavaScript,
  '.jsx': Lang.JavaScript,
  '.mjs': Lang.JavaScript,
  '.cjs': Lang.JavaScript,
};

/** True when a file path is eligible for the AST engine (bundled languages). */
export function astLangForFile(filePath: string): Lang | null {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_TO_LANG[ext] ?? null;
}

/** A single AST-engine match within a file (1-indexed line, like the regex engine). */
export interface AstCodemodMatch {
  line: number;
  original: string;
  replaced: string;
  /** Byte offset of the match start (used to dedup / sort if ever needed). */
  index: number;
}

export interface AstCodemodFileResult {
  /** Rewritten file source (only meaningful when matchCount > 0). */
  newSource: string;
  matches: AstCodemodMatch[];
  matchCount: number;
}

/**
 * Heuristic: does `pattern` look like a usable ast-grep pattern rather than a
 * raw regex? ast-grep patterns are concrete syntax with `$META` holes; raw
 * regexes lean on metacharacters (`\b`, `\d`, `[...]`, `.*`, anchors) that are
 * not valid source syntax. We use this in `engine: 'auto'` to decide whether to
 * try the AST engine at all. Conservative: when unsure, returns false so we
 * keep the safe regex path and never crash on a non-pattern.
 */
export function looksLikeAstPattern(pattern: string): boolean {
  // Regex-only constructs that are never valid ast-grep source patterns.
  // Note `$` is handled separately below — in ast-grep it introduces a
  // metavariable ($A, $$$ARGS), so it must not be treated as a regex anchor
  // when followed by a metavar char or another `$` (the `$$$` splice form).
  const regexSignals = [
    /\\[bBdDwWsSnrtfvA0]/, // \b \d \w \s escapes etc.
    /\\[.*+?(){}[\]^$|/]/, // escaped regex metacharacters
    /\[[^\]]*\]/, // character classes [a-z]
    /\.\*/, // .*
    /\.\+/, // .+
    /\(\?[:=!<]/, // (?: (?= (?! (?<
    /[*+?]\?/, // lazy quantifiers
    /\^/, // ^ anchor
    /\$(?![A-Za-z_$])/, // $ NOT introducing a metavar (or a `$$$` splice)
  ];
  for (const re of regexSignals) {
    if (re.test(pattern)) return false;
  }
  // Must contain at least one ast-grep metavariable to be worth AST matching.
  // A bare identifier with no metavar is ambiguous, so require a metavar to
  // opt into AST. Positional $1/$2 are replacement-template only, not patterns.
  return /\$\$\$[A-Za-z_]\w*|\$[A-Za-z_]\w*/.test(pattern);
}

interface MetavarPlan {
  /** Ordered single-metavar names as they appear left-to-right in the pattern. */
  singles: string[];
  /** Variadic metavar names (`$$$NAME`). */
  variadics: string[];
}

/** Parse the metavariable names referenced by a pattern, in source order. */
function planMetavars(pattern: string): MetavarPlan {
  const singles: string[] = [];
  const variadics: string[] = [];
  const re = /\$\$\$([A-Za-z_]\w*)|\$([A-Za-z_]\w*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pattern)) !== null) {
    if (m[1] !== undefined) {
      if (!variadics.includes(m[1])) variadics.push(m[1]);
    } else if (m[2] !== undefined) {
      if (!singles.includes(m[2])) singles.push(m[2]);
    }
  }
  return { singles, variadics };
}

/**
 * Build the concrete replacement text for one match by substituting captured
 * metavariables into the user's `replacement` template.
 *
 * Supports both named (`$A`, `$$$ARGS`) and positional (`$1`, `$2`) forms.
 * Positional `$N` resolves against the ordered single metavars of the *pattern*
 * (so `pair($1, $2)` → `pair($2, $1)` swaps the two captures).
 */
function buildReplacement(
  template: string,
  match: ReturnType<ReturnType<typeof parse>['root']>,
  plan: MetavarPlan,
): string {
  const singleText = (name: string): string => match.getMatch(name)?.text() ?? '';
  const variadicText = (name: string): string =>
    match
      .getMultipleMatches(name)
      .filter((n) => n.text() !== ',')
      .map((n) => n.text())
      .join(', ');

  // Replace longest tokens first so `$$$ARGS` is handled before `$A`/`$1`.
  // Order: variadic ($$$NAME) → named single ($NAME) → positional ($N).
  let out = template;

  for (const name of plan.variadics) {
    out = out.split(`$$$${name}`).join(variadicText(name));
  }

  // Named singles. Use a guarded replace so `$AB` isn't clobbered by `$A`.
  out = out.replace(/\$([A-Za-z_]\w*)/g, (whole, name: string) => {
    if (plan.singles.includes(name)) return singleText(name);
    return whole; // unknown named metavar — leave verbatim
  });

  // Positional $1..$N → ordered single metavars of the pattern.
  out = out.replace(/\$([1-9]\d*)/g, (whole, digits: string) => {
    const idx = Number.parseInt(digits, 10) - 1;
    const name = plan.singles[idx];
    return name !== undefined ? singleText(name) : whole;
  });

  return out;
}

/**
 * Apply an ast-grep pattern → replacement over a single file's source.
 * Returns the rewritten source plus per-match preview info. Pure: does no IO.
 *
 * Throws if the pattern fails to parse — callers in `engine: 'auto'` mode treat
 * a throw as "not an AST pattern, fall back to regex".
 */
export function runAstCodemodOnSource(
  lang: Lang,
  source: string,
  pattern: string,
  replacement: string,
): AstCodemodFileResult {
  const root = parse(lang, source).root();
  const nodes = root.findAll(pattern);

  if (nodes.length === 0) {
    return { newSource: source, matches: [], matchCount: 0 };
  }

  const plan = planMetavars(pattern);
  const edits = [];
  const matches: AstCodemodMatch[] = [];

  for (const node of nodes) {
    const replaced = buildReplacement(replacement, node, plan);
    const range = node.range();
    edits.push(node.replace(replaced));
    matches.push({
      line: range.start.line + 1, // ast-grep lines are 0-based; the regex engine is 1-based
      original: node.text(),
      replaced,
      index: range.start.index,
    });
  }

  const newSource = root.commitEdits(edits);
  return { newSource, matches, matchCount: nodes.length };
}
