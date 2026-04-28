/**
 * Emacs Lisp Language Plugin — tree-sitter-based symbol extraction.
 *
 * Extracts: defun, defmacro, defsubst (functions), defvar/defvar-local (variables),
 * defcustom (custom vars), defconst (constants), defgroup/cl-defstruct (classes),
 * defface (face vars), define-minor-mode/define-derived-mode/define-globalized-minor-mode
 * (mode functions), require/provide edges.
 *
 * tree-sitter-elisp (Wilfred) AST node types:
 *   - function_definition: defun, defsubst — name is 1st named child (symbol)
 *   - macro_definition:    defmacro       — name is 1st named child (symbol)
 *   - special_form:        defvar, defconst — name is 1st named child (symbol)
 *   - list:                everything else (defvar-local, defcustom, defgroup,
 *                          defface, define-*-mode, cl-defstruct, require, provide)
 *                          — 1st named child is form keyword symbol, 2nd is name
 */
import { err, ok } from 'neverthrow';
import type { TraceMcpResult } from '../../../../errors.js';
import { parseError } from '../../../../errors.js';
import { getParser, type TSNode } from '../../../../parser/tree-sitter.js';
import type {
  FileParseResult,
  LanguagePlugin,
  PluginManifest,
  RawEdge,
  RawSymbol,
  SymbolKind,
} from '../../../../plugin-api/types.js';

function makeSymbolId(filePath: string, name: string, kind: string): string {
  return `${filePath}::${name}#${kind}`;
}

function extractSignature(node: TSNode): string {
  return node.text.split('\n')[0].trim().slice(0, 120);
}

// ---------------------------------------------------------------------------
// List-form dispatch tables
// ---------------------------------------------------------------------------

/** Forms handled as generic `list` nodes where 1st symbol child is the keyword. */
const LIST_FORM_MAP: Record<string, { kind: SymbolKind; meta?: Record<string, unknown> }> = {
  // Variables
  'defvar-local': { kind: 'variable' },
  defcustom: { kind: 'variable', meta: { custom: true } },
  defface: { kind: 'variable', meta: { face: true } },
  'defvar-keymap': { kind: 'variable', meta: { keymap: true } },
  // Structures & Groups
  defgroup: { kind: 'class' },
  'cl-defstruct': { kind: 'class', meta: { struct: true } },
  'cl-deftype': { kind: 'type' },
  // Modes
  'define-minor-mode': { kind: 'function', meta: { mode: true } },
  'define-derived-mode': { kind: 'function', meta: { mode: true } },
  'define-globalized-minor-mode': { kind: 'function', meta: { mode: true } },
  'define-generic-mode': { kind: 'function', meta: { mode: true } },
  'define-compilation-mode': { kind: 'function', meta: { mode: true } },
  // EIEIO OOP
  defclass: { kind: 'class', meta: { eieio: true } },
  defgeneric: { kind: 'method', meta: { generic: true } },
  defmethod: { kind: 'method' },
  'cl-defgeneric': { kind: 'method', meta: { generic: true } },
  'cl-defmethod': { kind: 'method' },
  // Advice
  defadvice: { kind: 'function', meta: { advice: true } },
  'define-advice': { kind: 'function', meta: { advice: true } },
  // Inline functions & aliases
  'defsubst-maybe': { kind: 'function', meta: { inline: true } },
  defalias: { kind: 'function', meta: { alias: true } },
  'cl-defun': { kind: 'function', meta: { clLib: true } },
  'cl-defmacro': { kind: 'function', meta: { macro: true, clLib: true } },
  'cl-defsubst': { kind: 'function', meta: { inline: true, clLib: true } },
  // Package management
  'use-package': { kind: 'variable', meta: { package: true } },
  // Error/condition types
  'define-error': { kind: 'type', meta: { error: true } },
  // Widget types
  'define-widget': { kind: 'type', meta: { widget: true } },
};

/** Forms that produce import/provide edges instead of symbols. */
const EDGE_FORMS = new Set(['require', 'provide', 'require-macros']);

/** Wrapper forms that may contain nested definitions. */
const WRAPPER_FORMS = new Set([
  'progn',
  'eval-when-compile',
  'eval-and-compile',
  'when',
  'unless',
  'with-eval-after-load',
  'condition-case',
  'save-excursion',
  'cl-eval-when',
  'with-no-warnings',
  'with-suppressed-warnings',
  'if',
  'let',
  'let*',
  'cl-flet',
  'cl-labels',
  'cl-letf',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the first named child that is a `symbol` node.
 */
function firstSymbol(node: TSNode): string | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'symbol') return child.text;
  }
  return null;
}

/**
 * Get the second named `symbol` child (skipping the form keyword in `list` nodes).
 */
function secondSymbol(node: TSNode): string | null {
  let count = 0;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'symbol') {
      count++;
      if (count === 2) return child.text;
    }
  }
  return null;
}

/**
 * Extract the quoted symbol from require/provide: (require 'feature).
 * The quote node wraps a symbol node.
 */
function getQuotedSymbol(listNode: TSNode): string | null {
  for (let i = 0; i < listNode.namedChildCount; i++) {
    const child = listNode.namedChild(i);
    if (child?.type === 'quote') {
      for (let j = 0; j < child.namedChildCount; j++) {
        const inner = child.namedChild(j);
        if (inner?.type === 'symbol') return inner.text;
      }
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export class ElispLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'elisp-language',
    version: '2.0.0',
    priority: 5,
  };

  supportedExtensions = ['.el', '.elc'];

  async extractSymbols(
    filePath: string,
    content: Buffer,
  ): Promise<TraceMcpResult<FileParseResult>> {
    try {
      const parser = await getParser('elisp');
      const sourceCode = content.toString('utf-8');
      const tree = parser.parse(sourceCode);
      const root: TSNode = tree.rootNode;

      const hasError = root.hasError;
      const symbols: RawSymbol[] = [];
      const edges: RawEdge[] = [];
      const warnings: string[] = [];
      const seen = new Set<string>();

      if (hasError) {
        warnings.push('Source contains syntax errors; extraction may be incomplete');
      }

      this.walkNodes(root, filePath, symbols, edges, seen);

      return ok({
        language: 'elisp',
        status: hasError ? 'partial' : 'ok',
        symbols,
        edges: edges.length > 0 ? edges : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(parseError(filePath, `Elisp parse failed: ${msg}`));
    }
  }

  /**
   * Walk named children of a node, dispatching by node type.
   * Handles top-level source_file as well as wrapper form bodies.
   */
  private walkNodes(
    node: TSNode,
    filePath: string,
    symbols: RawSymbol[],
    edges: RawEdge[],
    seen: Set<string>,
  ): void {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;

      switch (child.type) {
        case 'function_definition':
          this.processStructuredDef(child, filePath, 'function', symbols, seen);
          break;
        case 'macro_definition':
          this.processStructuredDef(child, filePath, 'function', symbols, seen, { macro: true });
          break;
        case 'special_form':
          this.processSpecialForm(child, filePath, symbols, seen);
          break;
        case 'list':
          this.processList(child, filePath, symbols, edges, seen);
          break;
        default:
          break;
      }
    }
  }

  /**
   * Handle `function_definition` and `macro_definition` nodes.
   * Grammar structure: (defun NAME (ARGS) BODY...) or (defsubst NAME (ARGS) BODY...)
   *   → node type `function_definition`, 1st named child = symbol with NAME
   * Grammar structure: (defmacro NAME (ARGS) BODY...)
   *   → node type `macro_definition`, 1st named child = symbol with NAME
   */
  private processStructuredDef(
    node: TSNode,
    filePath: string,
    kind: SymbolKind,
    symbols: RawSymbol[],
    seen: Set<string>,
    meta?: Record<string, unknown>,
  ): void {
    // The grammar may parse defsubst as function_definition; detect via text
    const nodeText = node.text;
    let effectiveMeta = meta;
    if (!effectiveMeta && nodeText.startsWith('(defsubst')) {
      effectiveMeta = { inline: true };
    }

    const name = firstSymbol(node);
    if (!name) return;

    const symbolId = makeSymbolId(filePath, name, kind);
    if (seen.has(symbolId)) return;
    seen.add(symbolId);

    const symbol: RawSymbol = {
      symbolId,
      name,
      kind,
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
    };
    if (effectiveMeta) symbol.metadata = { ...effectiveMeta };
    symbols.push(symbol);
  }

  /**
   * Handle `special_form` nodes — defvar and defconst.
   * Grammar: (defvar NAME VALUE) or (defconst NAME VALUE)
   *   → node type `special_form`, 1st named child = symbol with NAME
   * We distinguish defvar vs defconst by inspecting the raw text.
   */
  private processSpecialForm(
    node: TSNode,
    filePath: string,
    symbols: RawSymbol[],
    seen: Set<string>,
  ): void {
    const nodeText = node.text;
    let kind: SymbolKind;
    if (nodeText.startsWith('(defconst')) {
      kind = 'constant';
    } else if (nodeText.startsWith('(defvar')) {
      kind = 'variable';
    } else {
      // Other special forms (let, if, etc.) — skip
      return;
    }

    const name = firstSymbol(node);
    if (!name) return;

    const symbolId = makeSymbolId(filePath, name, kind);
    if (seen.has(symbolId)) return;
    seen.add(symbolId);

    symbols.push({
      symbolId,
      name,
      kind,
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
    });
  }

  /**
   * Handle generic `list` nodes — covers forms the grammar doesn't give
   * dedicated node types: defvar-local, defcustom, defgroup, defface,
   * define-*-mode, cl-defstruct, require, provide, and wrapper forms.
   */
  private processList(
    listNode: TSNode,
    filePath: string,
    symbols: RawSymbol[],
    edges: RawEdge[],
    seen: Set<string>,
  ): void {
    const formName = firstSymbol(listNode);
    if (!formName) return;

    // --- Symbol-defining forms ---
    const formDef = LIST_FORM_MAP[formName];
    if (formDef) {
      const name = secondSymbol(listNode);
      if (!name) return;

      const symbolId = makeSymbolId(filePath, name, formDef.kind);
      if (seen.has(symbolId)) return;
      seen.add(symbolId);

      const symbol: RawSymbol = {
        symbolId,
        name,
        kind: formDef.kind,
        signature: extractSignature(listNode),
        byteStart: listNode.startIndex,
        byteEnd: listNode.endIndex,
        lineStart: listNode.startPosition.row + 1,
        lineEnd: listNode.endPosition.row + 1,
      };
      if (formDef.meta) symbol.metadata = { ...formDef.meta };
      symbols.push(symbol);
      return;
    }

    // --- require / provide edges ---
    if (EDGE_FORMS.has(formName)) {
      const target = getQuotedSymbol(listNode);
      if (!target) return;

      edges.push({
        edgeType: formName === 'require' ? 'imports' : 'exports',
        sourceSymbolId: filePath,
        targetSymbolId: target,
        metadata: { kind: formName },
      });
      return;
    }

    // --- Wrapper forms: recurse to find nested definitions ---
    if (WRAPPER_FORMS.has(formName)) {
      this.walkNodes(listNode, filePath, symbols, edges, seen);
    }
  }
}
