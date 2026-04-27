/**
 * F# Language Plugin — multi-pass regex extraction.
 *
 * Pass 1: Containers — type definitions (classes, records, DUs, interfaces),
 *         modules, namespaces
 * Pass 2: Members — methods, properties, abstract/override/static members inside types
 *
 * Comment stripping: //, (* *)
 * Scope: indent-based (F# significant whitespace)
 */
import { createMultiPassPlugin, type CommentStyle, type ScopeConfig } from '../regex-base-v2.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const comments: CommentStyle = {
  line: ['//'],
  block: [['(*', '*)']],
  strings: ['"'],
};

const scope: ScopeConfig = {
  style: 'indent',
};

const _plugin = createMultiPassPlugin({
  name: 'fsharp',
  language: 'fsharp',
  extensions: ['.fs', '.fsi', '.fsx'],
  comments,
  scope,
  docComments: { linePrefix: ['///'] },

  containerPatterns: [
    // ── Type definitions ───────────────────────────────────────────────
    // type [access] Name<'a> = (class, record, DU, interface, struct)
    {
      kind: 'type',
      pattern: /^\s*type\s+(?:private\s+|internal\s+|public\s+)?(\w+)(?:<[^>]+>)?\s*(?:\(|=)/gm,
      memberPatterns: [
        // member [access] [self.]name
        {
          kind: 'method',
          pattern: /^\s*member\s+(?:private\s+|internal\s+|public\s+)?(?:\w+\.)?(\w+)/gm,
        },
        // abstract member name : type
        {
          kind: 'method',
          pattern: /^\s*abstract\s+(?:member\s+)?(\w+)\s*:/gm,
          meta: { abstract: true },
        },
        // override [self.]name
        { kind: 'method', pattern: /^\s*override\s+(?:\w+\.)?(\w+)/gm, meta: { override: true } },
        // default [self.]name
        { kind: 'method', pattern: /^\s*default\s+(?:\w+\.)?(\w+)/gm, meta: { default: true } },
        // static member [access] [inline] name
        {
          kind: 'method',
          pattern:
            /^\s*static\s+member\s+(?:private\s+|internal\s+|public\s+)?(?:inline\s+)?(\w+)/gm,
          meta: { static: true },
        },
        // member [self.]Name with get/set (property)
        { kind: 'property', pattern: /^\s*member\s+(?:\w+\.)?(\w+)\s*with\s+(?:get|set)/gm },
        // static property
        {
          kind: 'property',
          pattern: /^\s*static\s+member\s+(?:\w+\.)?(\w+)\s*with\s+(?:get|set)/gm,
          meta: { static: true },
        },
        // val name : type (abstract val)
        { kind: 'property', pattern: /^\s*val\s+(?:mutable\s+)?(\w+)\s*:/gm },
        // DU case: | CaseName [of ...]
        { kind: 'enum_case', pattern: /^\s*\|\s+([A-Z]\w*)/gm },
        // interface IName
        { kind: 'interface', pattern: /^\s*interface\s+(\w+)/gm },
        // new(params) — constructor
        { kind: 'method', pattern: /^\s*new\s*\(/gm, meta: { constructor: true }, nameGroup: 0 },
      ],
    },
    // and Name = ... (mutual recursion type extension)
    {
      kind: 'type',
      pattern: /^\s*and\s+(\w+)(?:<[^>]+>)?\s*(?:\(|=)/gm,
      memberPatterns: [
        { kind: 'method', pattern: /^\s*member\s+(?:\w+\.)?(\w+)/gm },
        { kind: 'enum_case', pattern: /^\s*\|\s+([A-Z]\w*)/gm },
      ],
    },
    // ── Modules ────────────────────────────────────────────────────────
    {
      kind: 'module',
      pattern: /^\s*module\s+(?:rec\s+)?(?:private\s+|internal\s+|public\s+)?([\w.]+)\s*=/gm,
      memberPatterns: [
        {
          kind: 'function',
          pattern:
            /^\s*let\s+(?:private\s+|internal\s+|public\s+)?(?:rec\s+)?(?:inline\s+)?(\w+)/gm,
        },
        { kind: 'type', pattern: /^\s*type\s+(?:private\s+|internal\s+|public\s+)?(\w+)/gm },
      ],
    },
  ],

  symbolPatterns: [
    // ── Namespaces ─────────────────────────────────────────────────────
    { kind: 'namespace', pattern: /^\s*namespace\s+([\w.]+)/gm },
    // ── Top-level module (no =, just module Name) ──────────────────────
    {
      kind: 'module',
      pattern: /^\s*module\s+(?:rec\s+)?(?:private\s+|internal\s+|public\s+)?([\w.]+)\s*$/gm,
    },

    // ── Functions & Values ─────────────────────────────────────────────
    {
      kind: 'function',
      pattern:
        /^\s*let\s+(?:private\s+|internal\s+|public\s+)?(?:rec\s+)?(?:inline\s+)?(?:mutable\s+)?(\w+)(?:<[^>]+>)?\s+/gm,
    },
    {
      kind: 'variable',
      pattern:
        /^\s*let\s+(?:private\s+|internal\s+|public\s+)?(?:mutable\s+)?(\w+)\s*(?::\s*[^=]+)?\s*=/gm,
    },

    // ── Active Patterns ────────────────────────────────────────────────
    {
      kind: 'function',
      pattern: /^\s*let\s+\(\|([A-Z]\w+(?:\|[A-Z]\w+)*)\|\)\s/gm,
      meta: { activePattern: true },
    },
    {
      kind: 'function',
      pattern: /^\s*let\s+\(\|([A-Z]\w+)\|_\|\)\s/gm,
      meta: { activePattern: true, partial: true },
    },

    // ── Exceptions ─────────────────────────────────────────────────────
    { kind: 'type', pattern: /^\s*exception\s+(\w+)/gm, meta: { exception: true } },

    // ── val Signatures (.fsi) ──────────────────────────────────────────
    {
      kind: 'function',
      pattern: /^\s*val\s+(?:mutable\s+)?(\w+)\s*:/gm,
      meta: { signature: true },
    },

    // ── Literals & Measures ────────────────────────────────────────────
    { kind: 'constant', pattern: /^\s*\[<Literal>\]\s*\n\s*let\s+(\w+)/gm },
    { kind: 'type', pattern: /^\s*\[<Measure>\]\s*\n?\s*type\s+(\w+)/gm, meta: { measure: true } },

    // ── CE Builder instances ───────────────────────────────────────────
    {
      kind: 'variable',
      pattern: /^\s*let\s+(\w+)\s*=\s*(?:new\s+)?\w+Builder\s*\(/gm,
      meta: { ceBuilder: true },
    },

    // ── Standalone DU cases (at type level, not inside container) ──────
    { kind: 'enum_case', pattern: /^\s*\|\s+([A-Z]\w*)\s+(?:of\b|$)/gm },
    { kind: 'enum_case', pattern: /^\s*\|\s+([A-Z]\w*)\s*$/gm },

    // ── Standalone members (for top-level type augmentations) ──────────
    {
      kind: 'method',
      pattern: /^\s*member\s+(?:private\s+|internal\s+|public\s+)?(?:\w+\.)?(\w+)/gm,
    },
    {
      kind: 'method',
      pattern: /^\s*static\s+member\s+(?:private\s+|internal\s+|public\s+)?(?:inline\s+)?(\w+)/gm,
      meta: { static: true },
    },
  ],

  importPatterns: [
    { pattern: /^\s*open\s+([\w.]+)/gm },
    { pattern: /^\s*#r\s+"([^"]+)"/gm },
    { pattern: /^\s*#load\s+"([^"]+)"/gm },
  ],

  fqnSep: '.',
});

export const FSharpLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
