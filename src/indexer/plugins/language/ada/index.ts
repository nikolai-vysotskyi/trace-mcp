/**
 * Ada Language Plugin — multi-pass regex extraction.
 *
 * Pass 1: Containers — packages, protected types, task types, tagged records
 * Pass 2: Members — procedures, functions, entries, components inside containers
 *
 * Comment stripping: --
 * Scope: begin-end / is-end
 */
import { createMultiPassPlugin, type CommentStyle, type ScopeConfig } from '../regex-base-v2.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const comments: CommentStyle = {
  line: ['--'],
  block: [],
  strings: ['"'],
};

const scope: ScopeConfig = {
  style: 'keyword-end',
  openKeywords: /\b(?:is|begin|record|loop|declare|select|do)\b/gi,
  endKeywords: /\bend\b/gi,
};

const _plugin = createMultiPassPlugin({
  name: 'ada',
  language: 'ada',
  extensions: ['.adb', '.ads', '.ada'],
  comments,
  scope,

  containerPatterns: [
    // package declaration/body
    {
      kind: 'namespace',
      pattern: /^\s*package\s+(?:body\s+)?(\w[\w.]*)\s+is\b/gim,
      memberPatterns: [
        { kind: 'function', pattern: /^\s*(?:overriding\s+)?procedure\s+(\w+)/gim },
        { kind: 'function', pattern: /^\s*(?:overriding\s+)?function\s+(\w+)/gim },
        { kind: 'type', pattern: /^\s*type\s+(\w+)/gim },
        { kind: 'type', pattern: /^\s*subtype\s+(\w+)/gim },
        { kind: 'constant', pattern: /^\s*(\w+)\s*:\s*constant\b/gim },
        { kind: 'variable', pattern: /^\s*(\w+)\s*:\s*(?!constant\b)(?:\w[\w.]*)/gim },
        { kind: 'constant', pattern: /^\s*(\w+)\s*:\s*exception\s*;/gim },
      ],
    },
    // type ... is [tagged] record
    {
      kind: 'class',
      pattern: /^\s*type\s+(\w+)\s+is\s+(?:abstract\s+)?(?:tagged\s+)?(?:limited\s+)?(?:new\s+\w[\w.]*\s+with\s+)?record\b/gim,
      memberPatterns: [
        // record components: Name : Type;
        { kind: 'property', pattern: /^\s+(\w+)\s*:\s*(?!constant\b)(?:\w[\w.]*)/gim },
      ],
    },
    // protected type
    {
      kind: 'class',
      pattern: /^\s*protected\s+(?:type\s+)?(\w+)\s+is/gim,
      meta: { protected: true },
      memberPatterns: [
        { kind: 'method', pattern: /^\s*(?:procedure|function)\s+(\w+)/gim },
        { kind: 'method', pattern: /^\s*entry\s+(\w+)/gim },
      ],
    },
    // task type
    {
      kind: 'class',
      pattern: /^\s*task\s+(?:type\s+)?(\w+)/gim,
      meta: { task: true },
      memberPatterns: [
        { kind: 'method', pattern: /^\s*entry\s+(\w+)/gim },
      ],
    },
  ],

  symbolPatterns: [
    // Top-level procedure
    { kind: 'function', pattern: /^\s*(?:overriding\s+)?procedure\s+(\w+)/gim },
    // Top-level function
    { kind: 'function', pattern: /^\s*(?:overriding\s+)?function\s+(\w+)/gim },
    // Enum type: type X is (A, B, C)
    { kind: 'enum', pattern: /^\s*type\s+(\w+)\s+is\s*\(/gim },
    // Type alias / derived type (not record, not enum)
    { kind: 'type', pattern: /^\s*type\s+(\w+)\s+is\s+(?:new\s+)?(?:access\s+)?(?:not\s+null\s+)?\w/gim },
    // Subtype
    { kind: 'type', pattern: /^\s*subtype\s+(\w+)\s+is\b/gim },
    // Constant
    { kind: 'constant', pattern: /^\s*(\w+)\s*:\s*constant\b/gim },
    // Exception
    { kind: 'constant', pattern: /^\s*(\w+)\s*:\s*exception\s*;/gim },
    // Entry
    { kind: 'method', pattern: /^\s*entry\s+(\w+)/gim },
    // Generic
    { kind: 'function', pattern: /^\s*generic\b/gim },
    // Renaming: X renames Y;
    { kind: 'variable', pattern: /^\s*(\w+)\s*:\s*\w[\w.]*\s+renames\b/gim },
  ],

  importPatterns: [
    // with Package.Name;
    { pattern: /^\s*with\s+([\w.]+)/gim },
    // use Package.Name;
    { pattern: /^\s*use\s+([\w.]+)/gim },
    // use type Package.Type;
    { pattern: /^\s*use\s+type\s+([\w.]+)/gim },
  ],
});

export const AdaLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
