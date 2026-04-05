/**
 * Common Lisp Language Plugin — regex-based symbol extraction.
 *
 * Extracts: defun, defmacro, defgeneric, defmethod, defclass, defstruct, defpackage,
 * defvar, defparameter, defconstant, deftype, defcondition, and import edges.
 */
import { createRegexLanguagePlugin } from '../regex-base.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const _plugin = createRegexLanguagePlugin({
  name: 'common-lisp',
  language: 'commonlisp',
  extensions: ['.lisp', '.lsp', '.cl', '.asd', '.asdf'],
  symbolPatterns: [
    // (defun name ...)
    { kind: 'function', pattern: /\(\s*defun\s+([\w*+!\-<>=/.?]+)/gim },
    // (defmacro name ...)
    { kind: 'function', pattern: /\(\s*defmacro\s+([\w*+!\-<>=/.?]+)/gim, meta: { macro: true } },
    // (defgeneric name ...)
    { kind: 'function', pattern: /\(\s*defgeneric\s+([\w*+!\-<>=/.?]+)/gim },
    // (defmethod name ...)
    { kind: 'method', pattern: /\(\s*defmethod\s+([\w*+!\-<>=/.?]+)/gim },
    // (defclass name ...)
    { kind: 'class', pattern: /\(\s*defclass\s+([\w*+!\-<>=/.?]+)/gim },
    // (defstruct name ...)
    { kind: 'class', pattern: /\(\s*defstruct\s+(?:\([^)]*\)\s+)?([\w*+!\-<>=/.?]+)/gim },
    // (defpackage name / (in-package name
    { kind: 'namespace', pattern: /\(\s*(?:defpackage|in-package)\s+[:#]?([\w*+!\-<>=/.?]+)/gim },
    // (defvar *name* / (defparameter *name*
    { kind: 'variable', pattern: /\(\s*def(?:var|parameter)\s+(\*[\w*+!\-<>=/.?]+\*)/gim },
    // (defconstant +name+
    { kind: 'constant', pattern: /\(\s*defconstant\s+(\+?[\w*+!\-<>=/.?]+\+?)/gim },
    // (deftype name
    { kind: 'type', pattern: /\(\s*deftype\s+([\w*+!\-<>=/.?]+)/gim },
    // (define-condition name
    { kind: 'class', pattern: /\(\s*define-condition\s+([\w*+!\-<>=/.?]+)/gim },
  ],
  importPatterns: [
    // (:use :package-name) or (use-package :name)
    { pattern: /\(\s*(?::use|use-package)\s+[:#]?([\w.\-]+)/gim },
    // (require "module") / (require :module)
    { pattern: /\(\s*require\s+[:#]?"?([\w.\-]+)/gim },
    // (load "file")
    { pattern: /\(\s*load\s+"([^"]+)"/gim },
  ],
});

export const CommonLispLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
