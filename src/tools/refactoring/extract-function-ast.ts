/**
 * AST-aware `extract_function` core.
 *
 * The legacy regex implementation misclassified outer-scope identifiers as
 * parameters and spliced enclosing function headers into the extracted body.
 * This rewrite parses the file with `@ast-grep/napi` and performs free-variable
 * analysis on the selected line range:
 *
 *   - parameters  = identifiers READ in the slice that are DECLARED outside it
 *                   (enclosing function params + bindings before the slice +
 *                   outer scopes) — this is exactly what a closure must capture
 *   - return value = a binding DECLARED inside the slice that is USED after it
 *
 * Only the languages bundled with @ast-grep/napi (TypeScript/TSX/JS/JSX) are
 * supported; other extensions return a structured "unsupported" error so the
 * caller can fall back gracefully. The analysis is scope-approximate (it keys
 * on identifier text + declaration position, not full binding resolution), so
 * results are reported with `confidence: 'high'` only when the slice sits
 * cleanly inside a single function.
 */

import type { Lang, parse } from '@ast-grep/napi';
import { astLangForFile, isAstEngineAvailable, loadAstGrep } from './codemod-ast.js';

/** Identifier parent kinds that introduce a binding (the name position). */
const DECLARATION_PARENTS = new Set([
  'variable_declarator',
  'required_parameter',
  'optional_parameter',
  'function_declaration',
  'function_signature',
  'rest_pattern',
  'catch_clause',
]);

/**
 * Well-known globals that look like free variables but must NOT become params.
 * Conservative list — anything not here that is genuinely global will simply be
 * passed as a param, which is safe (the helper still compiles), just verbose.
 */
const GLOBALS = new Set([
  'console',
  'Math',
  'JSON',
  'Object',
  'Array',
  'String',
  'Number',
  'Boolean',
  'Date',
  'RegExp',
  'Promise',
  'Map',
  'Set',
  'Symbol',
  'Error',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'undefined',
  'null',
  'true',
  'false',
  'this',
  'super',
  'window',
  'document',
  'globalThis',
  'process',
  'require',
  'module',
  'exports',
]);

export interface ExtractPlan {
  /** Source of the new helper function. */
  helperSource: string;
  /** Replacement text for the extracted slice (the call site). */
  callSite: string;
  /** Free variables that became parameters, in first-seen order. */
  params: string[];
  /** Variable returned by the helper (used after the slice), if any. */
  returnValue?: string;
  /** 0-based line where the enclosing function ends (helper inserted after it). */
  enclosingEndLine: number;
  /** Indentation (whitespace prefix) of the slice's first line. */
  indent: string;
  confidence: 'high' | 'low';
}

export interface ExtractError {
  error: string;
}

export type ExtractResult = ExtractPlan | ExtractError;

export function isExtractError(r: ExtractResult): r is ExtractError {
  return (r as ExtractError).error !== undefined;
}

interface IdentInfo {
  name: string;
  line: number; // 0-based
  isDeclaration: boolean;
  isMemberProperty: boolean;
  /**
   * 0-based end line of the nearest enclosing block (`statement_block` or,
   * absent one, the enclosing function body) for THIS identifier occurrence.
   * Used to detect shadowing: a declaration is only "still in scope" at a
   * later line if that line falls within `[declLine, declBlockEndLine]`.
   */
  blockEndLine: number;
}

/**
 * Compute an extraction plan for [startLine, endLine] (1-based, inclusive) of
 * `source`. Returns either a plan or a structured error.
 */
export function planExtractFunction(
  filePath: string,
  source: string,
  startLine: number,
  endLine: number,
  functionName: string,
): ExtractResult {
  const lang = astLangForFile(filePath);
  if (lang === null) {
    // Two distinct null causes: unsupported language vs. missing native binding.
    if (!isAstEngineAvailable()) {
      return {
        error:
          'extract_function is unavailable: the @ast-grep/napi native binding failed to load ' +
          '(commonly an npm optional-dependency install issue — npm/cli#4828). Reinstall ' +
          'dependencies (remove node_modules + lockfile, reinstall) to restore it. Use ' +
          'plan_refactoring to preview the extraction manually in the meantime.',
      };
    }
    return {
      error:
        'extract_function currently supports TypeScript/JavaScript files only ' +
        '(.ts/.tsx/.js/.jsx/.mjs/.cjs). For other languages use plan_refactoring to preview manually.',
    };
  }

  const lines = source.split('\n');
  const sliceStart0 = startLine - 1;
  const sliceEnd0 = endLine - 1;

  // Binding is guaranteed available here (astLangForFile returned non-null).
  const astGrep = loadAstGrep();
  if (astGrep === null) {
    return {
      error: 'extract_function is unavailable: the @ast-grep/napi native binding failed to load.',
    };
  }
  const root = astGrep.parse(lang, source).root();

  // 1. Find the innermost function whose body contains the whole slice.
  const enclosing = findEnclosingFunction(root, sliceStart0, sliceEnd0);
  if (!enclosing) {
    return {
      error:
        'Cannot extract: the selected range is not inside a function body. ' +
        'extract_function lifts a statement slice out of an enclosing function.',
    };
  }
  const fnRange = enclosing.range();

  // 2. Gather all identifiers with classification.
  const idents = collectIdentifiers(root);

  // 3. Build scope sets keyed on identifier text.
  const declaredInSlice = new Set<string>();
  const declaredBeforeSliceInFn = new Set<string>();

  for (const id of idents) {
    if (!id.isDeclaration) continue;
    if (id.line >= sliceStart0 && id.line <= sliceEnd0) {
      declaredInSlice.add(id.name);
    } else if (id.line >= fnRange.start.line && id.line < sliceStart0) {
      declaredBeforeSliceInFn.add(id.name);
    } else if (id.line < fnRange.start.line) {
      // Declared in an outer scope (module-level / outer function) before the fn.
      declaredBeforeSliceInFn.add(id.name);
    }
  }

  // 4. Free variables: read in the slice, declared outside it, not a global.
  const params: string[] = [];
  const seenParams = new Set<string>();
  for (const id of idents) {
    if (id.line < sliceStart0 || id.line > sliceEnd0) continue;
    if (id.isDeclaration || id.isMemberProperty) continue;
    const name = id.name;
    if (declaredInSlice.has(name)) continue; // local to the slice
    if (GLOBALS.has(name)) continue;
    if (!declaredBeforeSliceInFn.has(name)) continue; // not a known in-scope binding
    if (seenParams.has(name)) continue;
    seenParams.add(name);
    params.push(name);
  }

  // 5. Return value: a binding declared in the slice used after it (in the fn).
  //
  // Two adversarial cases this must handle correctly rather than silently:
  //
  //   a) SHADOWING — a name declared in the slice may be shadowed by (or itself
  //      shadow) a same-named binding in a DIFFERENT block. Naively matching by
  //      name alone (`declaredInSlice.has(id.name)`) picks up post-slice uses of
  //      an OUTER same-named variable that the slice's inner declaration never
  //      touches, generating a `return x;` that references an out-of-scope
  //      (or wrong-value) binding. Guard: a slice-declared identifier only
  //      "reaches" a later usage line if that line falls within the
  //      declaration's own enclosing block (`blockEndLine`) — i.e. the
  //      declaration's block hasn't already closed by the time of the later
  //      reference. Usages in a block that already closed refer to some OTHER
  //      (outer) binding, not the slice's — so they must not be treated as the
  //      return-candidate's continued lifetime.
  //
  //   b) MULTIPLE RETURN-RELEVANT BINDINGS — if two or more distinct slice-local
  //      names are genuinely used after the slice, this tool only supports a
  //      single return value. Silently picking the first candidate (previous
  //      behavior) drops the second one, generating code with a dangling
  //      reference (ReferenceError at runtime). We instead collect ALL distinct
  //      candidates and reject the extraction when there is more than one,
  //      rather than emit code that silently loses data.
  const sliceDeclarations = idents.filter(
    (id) => id.isDeclaration && id.line >= sliceStart0 && id.line <= sliceEnd0,
  );
  const returnCandidates = new Set<string>();
  // Names where a slice declaration exists but was excluded as a return
  // candidate because its enclosing block already closed by the usage line —
  // i.e. a shadowing situation was detected and conservatively suppressed.
  // Surfaced via `confidence: 'low'` so callers can tell "resolved cleanly"
  // apart from "resolved by suppressing an ambiguous shadow".
  let shadowSuppressed = false;
  for (const id of idents) {
    if (id.line <= sliceEnd0 || id.line > fnRange.end.line) continue;
    if (id.isDeclaration || id.isMemberProperty) continue;
    const sameNameDecls = sliceDeclarations.filter((d) => d.name === id.name);
    if (sameNameDecls.length === 0) continue;
    // A slice declaration of this name "reaches" this usage only if the usage
    // line is still within that declaration's enclosing block.
    const reachingDecl = sameNameDecls.find((d) => id.line <= d.blockEndLine);
    if (reachingDecl) {
      returnCandidates.add(id.name);
    } else {
      // Same name was declared in the slice, but every such declaration's
      // block had already closed by this usage — the usage refers to some
      // OTHER (outer) binding with the same name. Not a return candidate.
      shadowSuppressed = true;
    }
  }

  if (returnCandidates.size > 1) {
    return {
      error:
        `Cannot extract: the selected range would need to return multiple values ` +
        `(${[...returnCandidates].join(', ')}), but extract_function supports a single ` +
        'return value only. Split the extraction or restructure to return one value ' +
        '(e.g. an object literal) and apply this refactor manually.',
    };
  }
  const returnValue: string | undefined =
    returnCandidates.size === 1 ? [...returnCandidates][0] : undefined;

  // 6. Build helper + call site text.
  const indent = (lines[sliceStart0].match(/^\s*/)?.[0] ?? '') || '';
  const sliceLines = lines.slice(sliceStart0, sliceEnd0 + 1);
  // Re-indent slice body by one level inside the helper; keep relative indent.
  const bodyIndent = '  ';
  const body = sliceLines
    .map((l) => (l.length > 0 ? bodyIndent + stripCommonIndent(l, indent) : l))
    .join('\n');

  const isArrowContext = false; // emit a standalone function declaration
  void isArrowContext;

  const paramList = params.join(', ');
  const returnLine = returnValue ? `\n${bodyIndent}return ${returnValue};` : '';
  const helperSource = `function ${functionName}(${paramList}) {\n${body}${returnLine}\n}`;

  const callArgs = params.join(', ');
  const callExpr = `${functionName}(${callArgs})`;
  const callSite = returnValue
    ? `${indent}const ${returnValue} = ${callExpr};`
    : `${indent}${callExpr};`;

  // Confidence: 'low' when we had to conservatively suppress a shadowed
  // return-value candidate (the analysis is scope-approximate, so a
  // shadowing situation is a real signal the result may be incomplete —
  // e.g. a variable the caller expected back was silently dropped rather
  // than misattributed). Otherwise 'high' when the slice is fully within the
  // function body and we resolved at least the declared-before set; 'low'
  // for the empty-scope heuristic fallback.
  const confidence: 'high' | 'low' = shadowSuppressed
    ? 'low'
    : declaredBeforeSliceInFn.size > 0 || params.length === 0
      ? 'high'
      : 'low';

  return {
    helperSource,
    callSite,
    params,
    returnValue,
    enclosingEndLine: fnRange.end.line,
    indent,
    confidence,
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

type SgNode = ReturnType<ReturnType<typeof parse>['root']>;

const FUNCTION_KINDS = [
  'function_declaration',
  'function_expression',
  'arrow_function',
  'method_definition',
  'generator_function_declaration',
  'generator_function',
];

/**
 * Build a kind-matcher rule for findAll. ast-grep's TS types brand node kinds
 * as `Kinds<TypesMap>`; we drive findAll with dynamic string kinds, so cast the
 * rule object through `never` to satisfy the matcher overload without `any`.
 */
function kindRule(kind: string): never {
  return { rule: { kind } } as unknown as never;
}

/** Innermost function node whose line range fully contains the slice. */
function findEnclosingFunction(
  root: SgNode,
  sliceStart0: number,
  sliceEnd0: number,
): SgNode | null {
  let best: SgNode | null = null;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (const kind of FUNCTION_KINDS) {
    for (const node of root.findAll(kindRule(kind))) {
      const r = node.range();
      // The slice must sit strictly inside the function body, not on its header.
      if (r.start.line < sliceStart0 && r.end.line >= sliceEnd0) {
        const span = r.end.line - r.start.line;
        if (span < bestSpan) {
          bestSpan = span;
          best = node;
        }
      }
    }
  }
  return best;
}

/** Node kinds that introduce a new lexical block scope for our purposes. */
const BLOCK_KINDS = new Set(['statement_block', 'program']);

/**
 * Walk up from `node` to the nearest enclosing block (`statement_block`, or
 * `program` for module-level code) and return its 0-based end line. This is
 * the scope-shadowing guard: a `const`/`let` declared inside a nested block is
 * out of scope once that block's line range ends, even if the SAME NAME is
 * declared again in an outer block. Falls back to the node's own end line if
 * no block ancestor is found (should not happen for well-formed programs).
 */
function nearestBlockEndLine(node: SgNode): number {
  let n: SgNode | null = node;
  while (n) {
    const kind = String(n.kind());
    if (BLOCK_KINDS.has(kind)) return n.range().end.line;
    n = n.parent();
  }
  return node.range().end.line;
}

function collectIdentifiers(root: SgNode): IdentInfo[] {
  const out: IdentInfo[] = [];
  for (const kind of ['identifier', 'shorthand_property_identifier']) {
    for (const id of root.findAll(kindRule(kind))) {
      const parent = id.parent();
      // ast-grep types kind() as a branded Kinds<TypesMap>; coerce to a plain
      // string so it can be tested against our Set<string> of parent kinds.
      const parentKind = String(parent?.kind() ?? '');
      const name = id.text();
      const range = id.range();

      // member_expression property: `foo.bar` → `bar` is not a free variable.
      let isMemberProperty = false;
      if (parentKind === 'member_expression') {
        // The property child is the one that is NOT the object. ast-grep exposes
        // fields; fall back to "not first child" when the field API is absent.
        const propField = parent?.field?.('property');
        if (propField && propField.text() === name) {
          // Only the property position counts as a member property.
          const propRange = propField.range();
          isMemberProperty = propRange.start.index === range.start.index;
        }
      }

      const isDeclaration = DECLARATION_PARENTS.has(parentKind) && isNamePosition(parent, name);

      out.push({
        name,
        line: range.start.line,
        isDeclaration,
        isMemberProperty,
        blockEndLine: nearestBlockEndLine(id),
      });
    }
  }
  // Sort by source position so first-seen order is deterministic.
  out.sort((a, b) => a.line - b.line);
  return out;
}

/**
 * Whether an identifier is in the "name" position of its declaring parent
 * (e.g. the `x` in `const x = ...`, not the initializer). For variable_declarator
 * the name is the `name` field; we accept it when the field matches or when the
 * field API is unavailable (best-effort).
 */
function isNamePosition(parent: SgNode | null | undefined, name: string): boolean {
  if (!parent) return false;
  const nameField = parent.field?.('name');
  if (nameField) return nameField.text() === name;
  // Field unavailable — assume the first identifier child is the name.
  return true;
}

/**
 * Remove the slice's common leading indentation from a line so it can be
 * re-indented uniformly inside the helper. Keeps deeper relative indentation.
 */
function stripCommonIndent(line: string, commonIndent: string): string {
  if (commonIndent.length > 0 && line.startsWith(commonIndent)) {
    return line.slice(commonIndent.length);
  }
  return line.replace(/^\s+/, '');
}

export type { Lang as ExtractLang };
