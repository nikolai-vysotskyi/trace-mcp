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

import { Lang, parse } from '@ast-grep/napi';
import { astLangForFile } from './codemod-ast.js';

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
    return {
      error:
        'extract_function currently supports TypeScript/JavaScript files only ' +
        '(.ts/.tsx/.js/.jsx/.mjs/.cjs). For other languages use plan_refactoring to preview manually.',
    };
  }

  const lines = source.split('\n');
  const sliceStart0 = startLine - 1;
  const sliceEnd0 = endLine - 1;

  const root = parse(lang, source).root();

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
  let returnValue: string | undefined;
  for (const id of idents) {
    if (id.line <= sliceEnd0 || id.line > fnRange.end.line) continue;
    if (id.isDeclaration || id.isMemberProperty) continue;
    if (declaredInSlice.has(id.name)) {
      returnValue = id.name;
      break;
    }
  }

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

  // Confidence: high when the slice is fully within the function body and we
  // resolved at least the declared-before set; low for empty-scope heuristics.
  const confidence: 'high' | 'low' =
    declaredBeforeSliceInFn.size > 0 || params.length === 0 ? 'high' : 'low';

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

      out.push({ name, line: range.start.line, isDeclaration, isMemberProperty });
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

export { Lang as ExtractLang };
