/**
 * Emacs Lisp Language Plugin — regex-based symbol extraction.
 *
 * Extracts: defun, defmacro, defvar, defcustom, defconst, defgroup, defface,
 * define-minor-mode, define-derived-mode, provide/require edges.
 */
import { createRegexLanguagePlugin } from '../regex-base.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const _plugin = createRegexLanguagePlugin({
  name: 'elisp',
  language: 'elisp',
  extensions: ['.el', '.elc'],
  symbolPatterns: [
    // (defun name ...)
    { kind: 'function', pattern: /\(\s*defun\s+([\w*+!\-<>=/.?]+)/gm },
    // (defmacro name ...)
    { kind: 'function', pattern: /\(\s*defmacro\s+([\w*+!\-<>=/.?]+)/gm, meta: { macro: true } },
    // (defsubst name ...)
    { kind: 'function', pattern: /\(\s*defsubst\s+([\w*+!\-<>=/.?]+)/gm, meta: { inline: true } },
    // (defvar name / (defvar-local name
    { kind: 'variable', pattern: /\(\s*defvar(?:-local)?\s+([\w*+!\-<>=/.?]+)/gm },
    // (defcustom name
    { kind: 'variable', pattern: /\(\s*defcustom\s+([\w*+!\-<>=/.?]+)/gm, meta: { custom: true } },
    // (defconst name
    { kind: 'constant', pattern: /\(\s*defconst\s+([\w*+!\-<>=/.?]+)/gm },
    // (defgroup name
    { kind: 'class', pattern: /\(\s*defgroup\s+([\w*+!\-<>=/.?]+)/gm },
    // (defface name
    { kind: 'variable', pattern: /\(\s*defface\s+([\w*+!\-<>=/.?]+)/gm, meta: { face: true } },
    // (define-minor-mode name / (define-derived-mode name
    { kind: 'function', pattern: /\(\s*define-(?:minor|derived|globalized-minor)-mode\s+([\w*+!\-<>=/.?]+)/gm, meta: { mode: true } },
    // (cl-defstruct name
    { kind: 'class', pattern: /\(\s*cl-defstruct\s+([\w*+!\-<>=/.?]+)/gm },
  ],
  importPatterns: [
    // (require 'feature)
    { pattern: /\(\s*require\s+'([\w\-]+)/gm },
    // (provide 'feature)
    { pattern: /\(\s*provide\s+'([\w\-]+)/gm },
  ],
});

export const ElispLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
