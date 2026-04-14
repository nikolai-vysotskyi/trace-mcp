/**
 * Nim Language Plugin — regex-based symbol extraction with scope tracking.
 *
 * Extracts: procs, funcs, methods, templates, macros, iterators, converters,
 *           types (objects, enums, concepts, distinct, tuples), generics,
 *           constants, variables, pragmas, and import/include/from edges.
 *
 * Nim visibility: `name*` (with asterisk) means exported/public.
 * Uses doc-comment capture for `##` doc-comments.
 *
 * Note: Nim is indent-based, not brace-based. Scope tracking uses
 * indent-level analysis for parent-child relationships.
 */
import { createRegexLanguagePlugin } from '../regex-base.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const _plugin = createRegexLanguagePlugin({
  name: 'nim',
  language: 'nim',
  extensions: ['.nim', '.nims', '.nimble'],
  docComments: { linePrefix: ['##'] },
  scopeTracking: true,
  multiLineSignatures: true,
  symbolPatterns: [
    // ─── Callable Declarations ─────────────────────────────────────────
    // proc name*[T](params): RetType {.pragmas.} =
    { kind: 'function', pattern: /^\s*proc\s+(`[^`]+`|\w+)\*\s*(?:\[|[\({:]|=)/gm, meta: { public: true } },
    { kind: 'function', pattern: /^\s*proc\s+(`[^`]+`|\w+)\s*(?:\[|[\({:]|=)/gm },
    // func (pure, no side effects)
    { kind: 'function', pattern: /^\s*func\s+(`[^`]+`|\w+)\*\s*(?:\[|[\({:]|=)/gm, meta: { public: true, pure: true } },
    { kind: 'function', pattern: /^\s*func\s+(`[^`]+`|\w+)\s*(?:\[|[\({:]|=)/gm, meta: { pure: true } },
    // method (dynamic dispatch)
    { kind: 'method', pattern: /^\s*method\s+(`[^`]+`|\w+)\*\s*(?:\[|[\({:]|=)/gm, meta: { public: true } },
    { kind: 'method', pattern: /^\s*method\s+(`[^`]+`|\w+)\s*(?:\[|[\({:]|=)/gm },
    // template (compile-time code generation)
    { kind: 'function', pattern: /^\s*template\s+(`[^`]+`|\w+)\*\s*(?:\[|[\({:]|=)/gm, meta: { public: true, template: true } },
    { kind: 'function', pattern: /^\s*template\s+(`[^`]+`|\w+)\s*(?:\[|[\({:]|=)/gm, meta: { template: true } },
    // macro (AST-level metaprogramming)
    { kind: 'function', pattern: /^\s*macro\s+(`[^`]+`|\w+)\*\s*(?:\[|[\({:]|=)/gm, meta: { public: true, macro: true } },
    { kind: 'function', pattern: /^\s*macro\s+(`[^`]+`|\w+)\s*(?:\[|[\({:]|=)/gm, meta: { macro: true } },
    // iterator (yield-based)
    { kind: 'function', pattern: /^\s*iterator\s+(`[^`]+`|\w+)\*\s*(?:\[|[\({:]|=)/gm, meta: { public: true, iterator: true } },
    { kind: 'function', pattern: /^\s*iterator\s+(`[^`]+`|\w+)\s*(?:\[|[\({:]|=)/gm, meta: { iterator: true } },
    // converter (implicit type conversion)
    { kind: 'function', pattern: /^\s*converter\s+(`[^`]+`|\w+)\*\s*(?:\[|[\({:]|=)/gm, meta: { public: true, converter: true } },
    { kind: 'function', pattern: /^\s*converter\s+(`[^`]+`|\w+)\s*(?:\[|[\({:]|=)/gm, meta: { converter: true } },

    // ─── Type Section Entries ──────────────────────────────────────────
    // Object types: Name*[T] = object [of Base]
    { kind: 'class', pattern: /^\s{2,}(\w+)\*?\s*(?:\[.*?\])?\s*=\s*(?:ref\s+)?object\b/gm, isScope: true },
    // Enum types: Name* = enum
    { kind: 'type', pattern: /^\s{2,}(\w+)\*?\s*=\s*enum\b/gm, meta: { enum: true }, isScope: true },
    // Concept types: Name* = concept
    { kind: 'interface', pattern: /^\s{2,}(\w+)\*?\s*=\s*concept\b/gm, meta: { concept: true }, isScope: true },
    // Distinct types: Name* = distinct BaseType
    { kind: 'type', pattern: /^\s{2,}(\w+)\*?\s*=\s*distinct\b/gm, meta: { distinct: true } },
    // Tuple types: Name* = tuple[...]
    { kind: 'type', pattern: /^\s{2,}(\w+)\*?\s*=\s*tuple\b/gm, meta: { tuple: true } },
    // Type aliases: Name* = existing_type
    { kind: 'type', pattern: /^\s{2,}(\w+)\*?\s*=\s*(?!object|enum|concept|distinct|tuple|ref\s)\w/gm },
    // Standalone top-level type: type Name* = ...
    { kind: 'type', pattern: /^\s*type\s+(\w+)\*?\s*(?:\[.*?\])?\s*=/gm },

    // ─── Enum members (indented inside enum body) ──────────────────────
    { kind: 'enum_case', pattern: /^\s{4,}(\w+)\s*(?:=|,?\s*$)/gm },

    // ─── Object fields (indented inside object body) ───────────────────
    { kind: 'property', pattern: /^\s{4,}(\w+)\*?\s*(?:,\s*\w+\*?\s*)*:\s*\w/gm },

    // ─── Constants & Variables ─────────────────────────────────────────
    { kind: 'constant', pattern: /^\s*const\s+(\w+)\*?\s*(?::\s*\w[^\n]*)?\s*=/gm },
    { kind: 'variable', pattern: /^\s*let\s+(\w+)\*?\s*(?::\s*\w[^\n]*)?\s*=/gm },
    { kind: 'variable', pattern: /^\s*var\s+(\w+)\*?\s*(?::\s*\w[^\n]*)?\s*=/gm },
    // Const section entries (indented)
    { kind: 'constant', pattern: /^\s{2,}(\w+)\*?\s*(?::\s*\w[^\n]*)?\s*=\s*(?!object|enum|concept|distinct|tuple|ref\s)/gm },
  ],
  importPatterns: [
    // import module [, module2] [except name]
    { pattern: /^\s*import\s+([\w/]+)/gm },
    // from module import name [, name2]
    { pattern: /^\s*from\s+([\w/]+)\s+import/gm },
    // include module
    { pattern: /^\s*include\s+([\w/]+)/gm },
    // export module (re-export)
    { pattern: /^\s*export\s+([\w/]+)/gm },
  ],
  fqnSep: '/',
});

export const NimLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
