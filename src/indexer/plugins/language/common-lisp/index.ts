/**
 * Common Lisp Language Plugin — multi-pass regex extraction.
 *
 * Pass 1: Containers — defpackage, defclass, defsystem
 * Pass 2: Members — slot definitions inside defclass, functions inside package scope
 *
 * Comment stripping: ;, #| |#
 * Scope: indent-based (Lisp uses parens)
 */
import { createMultiPassPlugin, type CommentStyle, type ScopeConfig } from '../regex-base-v2.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

/** Common Lisp symbol name chars */
const SYM = '[\\w*+!\\-<>=/.?@]';
const SYM_RE = `${SYM}+`;

const comments: CommentStyle = {
  line: [';'],
  block: [['#|', '|#']],
  // Don't strip strings — Lisp string literals appear in defsystem/quickload patterns
  strings: [],
};

const scope: ScopeConfig = {
  style: 'indent',
};

const _plugin = createMultiPassPlugin({
  name: 'common-lisp',
  language: 'commonlisp',
  extensions: ['.lisp', '.lsp', '.cl', '.asd', '.asdf'],
  comments,
  scope,

  containerPatterns: [
    // (defpackage :name ...)
    {
      kind: 'namespace',
      pattern: new RegExp(`\\(\\s*defpackage\\s+[:#]?(${SYM_RE})`, 'gim'),
      memberPatterns: [
        {
          kind: 'function',
          pattern: /(?::export[^)]*?)[:#](\w[\w*+!\-<>=/.?]*)/gim,
          meta: { exported: true },
        },
      ],
    },
    // (defclass name (supers) ((slot ...) ...))
    {
      kind: 'class',
      pattern: new RegExp(`\\(\\s*defclass\\s+(${SYM_RE})`, 'gim'),
      memberPatterns: [
        {
          kind: 'property',
          pattern: new RegExp(
            `\\(\\s*:?(${SYM_RE})\\s+:(?:accessor|reader|writer|initarg|initform|type|allocation|documentation)`,
            'gim',
          ),
          meta: { slot: true },
        },
        { kind: 'property', pattern: new RegExp(`\\(\\s*(${SYM_RE})\\s*\\)`, 'gim') },
      ],
    },
    // (defstruct name ...)
    {
      kind: 'class',
      pattern: new RegExp(`\\(\\s*defstruct\\s+(?:\\([^)]*\\)\\s+)?(${SYM_RE})`, 'gim'),
      memberPatterns: [{ kind: 'property', pattern: new RegExp(`\\(\\s*(${SYM_RE})\\s`, 'gim') }],
    },
    // (defsystem "name" ...) — ASDF
    {
      kind: 'module',
      pattern: new RegExp(`\\(\\s*(?:asdf:)?defsystem\\s+[:#]?"?(${SYM_RE})"?`, 'gim'),
      meta: { asdf: true },
    },
  ],

  symbolPatterns: [
    { kind: 'function', pattern: new RegExp(`\\(\\s*defun\\s+(${SYM_RE})`, 'gim') },
    {
      kind: 'function',
      pattern: new RegExp(`\\(\\s*defmacro\\s+(${SYM_RE})`, 'gim'),
      meta: { macro: true },
    },
    {
      kind: 'function',
      pattern: new RegExp(`\\(\\s*define-compiler-macro\\s+(${SYM_RE})`, 'gim'),
      meta: { compilerMacro: true },
    },
    { kind: 'function', pattern: new RegExp(`\\(\\s*defgeneric\\s+(${SYM_RE})`, 'gim') },
    { kind: 'method', pattern: new RegExp(`\\(\\s*defmethod\\s+(${SYM_RE})`, 'gim') },
    { kind: 'namespace', pattern: new RegExp(`\\(\\s*in-package\\s+[:#]?(${SYM_RE})`, 'gim') },
    {
      kind: 'variable',
      pattern: new RegExp(`\\(\\s*def(?:var|parameter)\\s+(\\*${SYM_RE}\\*)`, 'gim'),
    },
    { kind: 'constant', pattern: new RegExp(`\\(\\s*defconstant\\s+(\\+?${SYM_RE}\\+?)`, 'gim') },
    { kind: 'type', pattern: new RegExp(`\\(\\s*deftype\\s+(${SYM_RE})`, 'gim') },
    { kind: 'class', pattern: new RegExp(`\\(\\s*define-condition\\s+(${SYM_RE})`, 'gim') },
    {
      kind: 'function',
      pattern: new RegExp(`\\(\\s*define-setf-expander\\s+(${SYM_RE})`, 'gim'),
      meta: { setf: true },
    },
    {
      kind: 'function',
      pattern: new RegExp(`\\(\\s*define-method-combination\\s+(${SYM_RE})`, 'gim'),
    },
    {
      kind: 'variable',
      pattern: new RegExp(`\\(\\s*define-symbol-macro\\s+(${SYM_RE})`, 'gim'),
      meta: { symbolMacro: true },
    },
    {
      kind: 'function',
      pattern: new RegExp(`\\(\\s*(?:flet|labels)\\s+\\(\\s*\\(\\s*(${SYM_RE})`, 'gim'),
      meta: { local: true },
    },
  ],

  importPatterns: [
    { pattern: new RegExp(`\\(\\s*(?::use|use-package)\\s+[:#]?(${SYM_RE})`, 'gim') },
    { pattern: new RegExp(`\\(\\s*require\\s+[:#]?"?(${SYM_RE})`, 'gim') },
    { pattern: /\(\s*load\s+"([^"]+)"/gim },
    { pattern: new RegExp(`\\(\\s*ql:quickload\\s+[:"](${SYM_RE})`, 'gim') },
    { pattern: /:depends-on\s+[("#]+([\w.-]+)/gim },
  ],
});

export const CommonLispLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
