/**
 * D Language Plugin — multi-pass regex extraction.
 *
 * Pass 1: Containers — classes, structs, interfaces, enums, unions, templates
 * Pass 2: Members — methods, properties, fields, constructors inside containers
 *
 * Comment stripping: //, /* *​/, /+ +/
 * Scope: braces
 */
import { createMultiPassPlugin, type CommentStyle } from '../regex-base-v2.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const comments: CommentStyle = {
  line: ['//'],
  block: [
    ['/*', '*/'],
    ['/+', '+/'],
  ],
  strings: ['"', "'", '`'],
};

const _plugin = createMultiPassPlugin({
  name: 'd',
  language: 'd',
  extensions: ['.d', '.di'],
  comments,
  scope: { style: 'braces' },
  docComments: { linePrefix: ['///', '/**'] },

  containerPatterns: [
    // ── Classes ────────────────────────────────────────────────────────
    {
      kind: 'class',
      pattern:
        /^\s*(?:(?:public|private|package|protected|export)\s+)?(?:(?:static|final|abstract|synchronized)\s+)*class\s+(\w+)/gm,
      memberPatterns: [
        // Method: ReturnType name(params)
        {
          kind: 'method',
          pattern:
            /^\s*(?:(?:public|private|package|protected|export|static|final|override|abstract|pure|nothrow|@\w+)\s+)*(?:auto|void|bool|int|uint|long|ulong|float|double|real|char|string|size_t|\w+(?:\.\w+)*(?:\s*[*[\]!]+)?)\s+(\w+)\s*\(/gm,
        },
        // Property: @property RetType name()
        { kind: 'property', pattern: /^\s*@property\s+(?:\w+\s+)?(\w+)\s*\(/gm },
        // Constructor: this(params)
        { kind: 'method', pattern: /^\s*(this)\s*\(/gm, meta: { constructor: true } },
        // Destructor: ~this()
        { kind: 'method', pattern: /^\s*(~this)\s*\(/gm, meta: { destructor: true } },
        // Alias: alias name = ...
        { kind: 'type', pattern: /^\s*alias\s+(\w+)\s*=/gm, meta: { alias: true } },
        // Invariant: invariant()
        { kind: 'method', pattern: /^\s*(invariant)\s*\(/gm, meta: { contract: true } },
      ],
    },
    // ── Structs ────────────────────────────────────────────────────────
    {
      kind: 'class',
      pattern:
        /^\s*(?:(?:public|private|package|protected|export)\s+)?(?:static\s+)?struct\s+(\w+)/gm,
      meta: { struct: true },
      memberPatterns: [
        {
          kind: 'method',
          pattern:
            /^\s*(?:(?:public|private|package|protected|export|static|final|override|pure|nothrow|@\w+)\s+)*(?:auto|void|bool|int|uint|long|ulong|float|double|real|char|string|size_t|\w+(?:\.\w+)*(?:\s*[*[\]!]+)?)\s+(\w+)\s*\(/gm,
        },
        { kind: 'property', pattern: /^\s*@property\s+(?:\w+\s+)?(\w+)\s*\(/gm },
        { kind: 'method', pattern: /^\s*(this)\s*\(/gm, meta: { constructor: true } },
        { kind: 'method', pattern: /^\s*(~this)\s*\(/gm, meta: { destructor: true } },
        { kind: 'type', pattern: /^\s*alias\s+(\w+)\s*=/gm, meta: { alias: true } },
        { kind: 'method', pattern: /^\s*(invariant)\s*\(/gm, meta: { contract: true } },
      ],
    },
    // ── Interfaces ─────────────────────────────────────────────────────
    {
      kind: 'interface',
      pattern: /^\s*(?:(?:public|private|package|protected|export)\s+)?interface\s+(\w+)/gm,
      memberPatterns: [
        {
          kind: 'method',
          pattern:
            /^\s*(?:(?:static|final|pure|nothrow|@\w+)\s+)*(?:auto|void|bool|int|uint|long|ulong|float|double|real|char|string|size_t|\w+(?:\.\w+)*)\s+(\w+)\s*\(/gm,
        },
        { kind: 'property', pattern: /^\s*@property\s+(?:\w+\s+)?(\w+)\s*\(/gm },
      ],
    },
    // ── Enums (named) ──────────────────────────────────────────────────
    {
      kind: 'enum',
      pattern:
        /^\s*(?:(?:public|private|package|protected|export)\s+)?enum\s+(\w+)\s*(?::\s*\w+)?\s*\{/gm,
      memberPatterns: [
        // Enum members: name [= value]
        { kind: 'constant', pattern: /^\s*(\w+)\s*(?:=|,\s*$)/gm },
      ],
    },
    // ── Unions ──────────────────────────────────────────────────────────
    {
      kind: 'type',
      pattern: /^\s*(?:(?:public|private|package|protected|export)\s+)?union\s+(\w+)/gm,
      meta: { union: true },
      memberPatterns: [
        { kind: 'property', pattern: /^\s*(?:\w+(?:\.\w+)*(?:\s*[*[\]!]+)?)\s+(\w+)\s*;/gm },
      ],
    },
    // ── Templates ──────────────────────────────────────────────────────
    {
      kind: 'type',
      pattern: /^\s*(?:(?:public|private|package|protected|export)\s+)?template\s+(\w+)\s*\(/gm,
      meta: { template: true },
      memberPatterns: [
        {
          kind: 'function',
          pattern:
            /^\s*(?:auto|void|bool|int|uint|long|ulong|float|double|real|char|string|\w+)\s+(\w+)\s*\(/gm,
        },
        { kind: 'class', pattern: /^\s*(?:class|struct)\s+(\w+)/gm },
        { kind: 'type', pattern: /^\s*alias\s+(\w+)\s*=/gm },
      ],
    },
    // ── Mixin Templates ────────────────────────────────────────────────
    {
      kind: 'type',
      pattern: /^\s*mixin\s+template\s+(\w+)\s*\(/gm,
      meta: { mixin: true, template: true },
      memberPatterns: [{ kind: 'function', pattern: /^\s*(?:auto|void|bool|\w+)\s+(\w+)\s*\(/gm }],
    },
  ],

  symbolPatterns: [
    // ── Module ─────────────────────────────────────────────────────────
    { kind: 'namespace', pattern: /^\s*module\s+([\w.]+)\s*;/gm },

    // ── Top-level functions ────────────────────────────────────────────
    {
      kind: 'function',
      pattern:
        /^\s*(?:(?:public|private|package|protected|export)\s+)?(?:(?:static|final|override|abstract|pure|nothrow|@\w+)\s+)*(?:auto|void|bool|int|uint|long|ulong|float|double|real|char|wchar|dchar|string|wstring|dstring|size_t|\w+(?:\.\w+)*(?:\s*[*[\]!]+)?)\s+(\w+)\s*\(/gm,
    },

    // ── Aliases (top-level) ────────────────────────────────────────────
    { kind: 'type', pattern: /^\s*alias\s+(\w+)\s*=/gm, meta: { alias: true } },
    // alias this
    { kind: 'type', pattern: /^\s*alias\s+(\w+)\s+this\s*;/gm, meta: { aliasThis: true } },

    // ── Manifest constants: enum name = value; ─────────────────────────
    { kind: 'constant', pattern: /^\s*enum\s+(\w+)\s*=\s*[^{]/gm },
    // immutable name = ...
    { kind: 'constant', pattern: /^\s*immutable\s+(?:auto\s+)?(\w+)\s*=/gm },

    // ── Constructors / destructors (top-level: module ctor/dtor) ───────
    { kind: 'function', pattern: /^\s*static\s+(this)\s*\(/gm, meta: { moduleConstructor: true } },
    { kind: 'function', pattern: /^\s*static\s+(~this)\s*\(/gm, meta: { moduleDestructor: true } },
    {
      kind: 'function',
      pattern: /^\s*shared\s+static\s+(this)\s*\(/gm,
      meta: { sharedConstructor: true },
    },
    {
      kind: 'function',
      pattern: /^\s*shared\s+static\s+(~this)\s*\(/gm,
      meta: { sharedDestructor: true },
    },

    // ── Unittest ───────────────────────────────────────────────────────
    { kind: 'function', pattern: /^\s*(unittest)\s*\{/gm, meta: { test: true } },

    // ── Version / debug conditionals ───────────────────────────────────
    {
      kind: 'variable',
      pattern: /^\s*version\s*\(\s*(\w+)\s*\)/gm,
      meta: { conditional: true, conditionKind: 'version' },
    },
    {
      kind: 'variable',
      pattern: /^\s*debug\s*\(\s*(\w+)\s*\)/gm,
      meta: { conditional: true, conditionKind: 'debug' },
    },
  ],

  importPatterns: [
    // import std.module;
    { pattern: /^\s*import\s+([\w.]+)\s*[;:]/gm },
    // static import
    { pattern: /^\s*static\s+import\s+([\w.]+)\s*[;:]/gm },
    // public import
    { pattern: /^\s*public\s+import\s+([\w.]+)\s*[;:]/gm },
  ],

  fqnSep: '.',
});

export const DLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
