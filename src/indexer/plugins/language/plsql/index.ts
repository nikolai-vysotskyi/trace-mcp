/**
 * PL/SQL Language Plugin — multi-pass regex extraction.
 *
 * Pass 1: Containers — packages, package bodies, type bodies
 * Pass 2: Members — procedures, functions, cursors, exceptions inside packages
 *
 * Comment stripping: --, block comments
 * Scope: begin-end
 */
import { createMultiPassPlugin, type CommentStyle, type ScopeConfig } from '../regex-base-v2.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const comments: CommentStyle = {
  line: ['--'],
  block: [['/*', '*/']],
  strings: ["'"],
};

const scope: ScopeConfig = {
  style: 'keyword-end',
  openKeywords: /\b(?:BEGIN|IS|AS|LOOP|IF|CASE|DECLARE)\b/gi,
  endKeywords: /\bEND\b/gi,
};

const _plugin = createMultiPassPlugin({
  name: 'plsql',
  language: 'plsql',
  extensions: ['.pls', '.plb', '.pck', '.pkb', '.pks', '.plsql', '.prc', '.fnc', '.trg', '.typ'],
  comments,
  scope,

  containerPatterns: [
    // CREATE [OR REPLACE] PACKAGE [BODY] name AS/IS
    {
      kind: 'namespace',
      pattern: /CREATE\s+(?:OR\s+REPLACE\s+)?PACKAGE\s+(?:BODY\s+)?(?:\w+\.)?(\w+)\s+(?:AS|IS)\b/gim,
      memberPatterns: [
        // PROCEDURE name inside package
        { kind: 'function', pattern: /^\s*PROCEDURE\s+(\w+)/gim },
        // FUNCTION name inside package
        { kind: 'function', pattern: /^\s*FUNCTION\s+(\w+)/gim },
        // CURSOR name IS
        { kind: 'variable', pattern: /^\s*CURSOR\s+(\w+)\s+IS/gim },
        // name EXCEPTION;
        { kind: 'constant', pattern: /^\s*(\w+)\s+EXCEPTION\s*;/gim },
        // name CONSTANT type := value;
        { kind: 'constant', pattern: /^\s*(\w+)\s+CONSTANT\b/gim },
        // TYPE name IS
        { kind: 'type', pattern: /^\s*TYPE\s+(\w+)\s+IS\b/gim },
        // SUBTYPE name IS
        { kind: 'type', pattern: /^\s*SUBTYPE\s+(\w+)\s+IS\b/gim },
        // variable declarations: name type [:= value];
        { kind: 'variable', pattern: /^\s*(\w+)\s+(?:VARCHAR2|NUMBER|INTEGER|BOOLEAN|DATE|TIMESTAMP|CLOB|BLOB|PLS_INTEGER|BINARY_INTEGER)\b/gim },
      ],
    },
    // CREATE [OR REPLACE] TYPE [BODY] name AS/IS OBJECT
    {
      kind: 'class',
      pattern: /CREATE\s+(?:OR\s+REPLACE\s+)?TYPE\s+(?:BODY\s+)?(?:\w+\.)?(\w+)\s+(?:AS|IS)\s+(?:OBJECT|TABLE|VARRAY)/gim,
      memberPatterns: [
        { kind: 'method', pattern: /^\s*(?:MEMBER|STATIC|CONSTRUCTOR)\s+(?:PROCEDURE|FUNCTION)\s+(\w+)/gim },
        { kind: 'property', pattern: /^\s+(\w+)\s+(?:VARCHAR2|NUMBER|INTEGER|DATE|TIMESTAMP|REF|\w+_t)\b/gim },
      ],
    },
  ],

  symbolPatterns: [
    // CREATE [OR REPLACE] PROCEDURE name
    { kind: 'function', pattern: /CREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE\s+(?:\w+\.)?(\w+)/gim },
    // CREATE [OR REPLACE] FUNCTION name
    { kind: 'function', pattern: /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:\w+\.)?(\w+)/gim },
    // CREATE [OR REPLACE] TRIGGER name
    { kind: 'function', pattern: /CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+(?:\w+\.)?(\w+)/gim, meta: { trigger: true } },
    // CREATE TABLE name
    { kind: 'class', pattern: /CREATE\s+(?:GLOBAL\s+TEMPORARY\s+)?TABLE\s+(?:\w+\.)?(\w+)/gim },
    // CREATE [OR REPLACE] [MATERIALIZED] VIEW name
    { kind: 'class', pattern: /CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:\w+\.)?(\w+)/gim },
    // CREATE [UNIQUE] INDEX name
    { kind: 'variable', pattern: /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:\w+\.)?(\w+)/gim },
    // CREATE SEQUENCE name
    { kind: 'variable', pattern: /CREATE\s+SEQUENCE\s+(?:\w+\.)?(\w+)/gim },
    // Standalone CURSOR
    { kind: 'variable', pattern: /^\s*CURSOR\s+(\w+)\s+IS/gim },
    // Standalone exception
    { kind: 'constant', pattern: /^\s*(\w+)\s+EXCEPTION\s*;/gim },
    // Standalone constant
    { kind: 'constant', pattern: /^\s*(\w+)\s+CONSTANT\b/gim },
  ],

  importPatterns: [
    // No standard import syntax in PL/SQL, but we can track references
    // EXECUTE IMMEDIATE dynamic SQL is hard to track
  ],
});

export const PlsqlLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
