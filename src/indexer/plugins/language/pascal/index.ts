/**
 * Pascal / Delphi Language Plugin — multi-pass regex extraction.
 *
 * Pass 1: Containers — unit, program, class, record, interface
 * Pass 2: Members — methods, properties, fields, constructors inside containers
 *
 * Comment stripping: { }, (* *), //
 * Scope: begin-end (Pascal uses 'end' keyword for scope termination)
 */
import { createMultiPassPlugin, type CommentStyle, type ScopeConfig } from '../regex-base-v2.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const comments: CommentStyle = {
  line: ['//'],
  block: [['{', '}'], ['(*', '*)']],
  strings: ["'"],
};

const scope: ScopeConfig = {
  style: 'keyword-end',
  openKeywords: /\b(?:begin|record|class|interface|object|case|try|repeat)\b/gi,
  endKeywords: /\b(?:end)\b/gi,
};

const _plugin = createMultiPassPlugin({
  name: 'pascal',
  language: 'pascal',
  extensions: ['.pas', '.dpr', '.dpk', '.lpr', '.pp', '.inc'],
  comments,
  scope,

  containerPatterns: [
    // unit/program/library/package declaration (module-level scope)
    {
      kind: 'module',
      pattern: /^\s*(?:unit|program|library|package)\s+(\w[\w.]*)\s*;/gim,
    },
    // class type: TMyClass = class[(TParent)]
    {
      kind: 'class',
      pattern: /^\s*(\w+)\s*=\s*class\b(?:\s*\([^)]*\))?/gim,
      memberPatterns: [
        // procedure/function declaration (method)
        { kind: 'method', pattern: /^\s*(?:class\s+)?(?:procedure|function)\s+(\w+)/gim },
        // constructor/destructor
        { kind: 'method', pattern: /^\s*(?:constructor|destructor)\s+(\w+)/gim },
        // property Name: Type read/write
        { kind: 'property', pattern: /^\s*property\s+(\w+)/gim },
        // field: Name: Type;
        { kind: 'property', pattern: /^\s+(\w+)\s*:\s*\w/gm },
      ],
    },
    // record type: TMyRec = record
    {
      kind: 'class',
      pattern: /^\s*(\w+)\s*=\s*record\b/gim,
      meta: { record: true },
      memberPatterns: [
        // field: Name: Type;
        { kind: 'property', pattern: /^\s+(\w+)\s*:\s*\w/gm },
        // case variant
        { kind: 'property', pattern: /^\s+(\w+)\s*:\s*\(/gm },
      ],
    },
    // interface type: IMyInterface = interface
    {
      kind: 'interface',
      pattern: /^\s*(\w+)\s*=\s*interface\b(?:\s*\([^)]*\))?/gim,
      memberPatterns: [
        { kind: 'method', pattern: /^\s*(?:procedure|function)\s+(\w+)/gim },
        { kind: 'property', pattern: /^\s*property\s+(\w+)/gim },
      ],
    },
  ],

  symbolPatterns: [
    // Top-level procedure/function (not inside class)
    { kind: 'function', pattern: /^\s*(?:class\s+)?procedure\s+(?:(\w+)\.)?(\w+)/gim, nameGroup: 2 },
    { kind: 'function', pattern: /^\s*(?:class\s+)?function\s+(?:(\w+)\.)?(\w+)/gim, nameGroup: 2 },
    // Constructor/destructor at top level (implementation section)
    { kind: 'function', pattern: /^\s*constructor\s+(?:(\w+)\.)?(\w+)/gim, nameGroup: 2 },
    { kind: 'function', pattern: /^\s*destructor\s+(?:(\w+)\.)?(\w+)/gim, nameGroup: 2 },
    // Enum type: TMyEnum = (val1, val2, ...)
    { kind: 'enum', pattern: /^\s*(\w+)\s*=\s*\([^)]*\)\s*;/gim },
    // Type alias: TMyType = type SomeType
    { kind: 'type', pattern: /^\s*(\w+)\s*=\s*type\b/gim },
    // Set type: TMySet = set of SomeType
    { kind: 'type', pattern: /^\s*(\w+)\s*=\s*set\s+of\b/gim },
    // Array type: TMyArr = array[...] of ...
    { kind: 'type', pattern: /^\s*(\w+)\s*=\s*array\b/gim },
    // Pointer type: PMyType = ^SomeType
    { kind: 'type', pattern: /^\s*(\w+)\s*=\s*\^/gim },
    // const declarations
    { kind: 'constant', pattern: /^\s*(\w+)\s*=\s*(?:\d|'|\$|True|False)/gim },
    // property declarations (also at top level in implementation)
    { kind: 'property', pattern: /^\s*property\s+(\w+)/gim },
    // var declarations (resourcestring, threadvar)
    { kind: 'variable', pattern: /^\s*(\w+)\s*:\s*(?:string|integer|boolean|byte|word|cardinal|real|double|extended|pointer|TObject)\b/gim },
  ],

  importPatterns: [
    // uses Unit1, Unit2, ...;  — each unit name
    { pattern: /\buses\s+([\w,\s.]+);/gim },
    // {$I filename} or {$INCLUDE filename}
    { pattern: /\{\$(?:I|INCLUDE)\s+(\S+)\}/gim },
  ],
});

export const PascalLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
