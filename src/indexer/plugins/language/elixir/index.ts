/**
 * Elixir Language Plugin — regex-based symbol extraction.
 *
 * Extracts: modules (defmodule), protocols, implementations, public/private
 * functions, macros, guards, type specs, callbacks, and import edges
 * (import, alias, use, require).
 */
import { createRegexLanguagePlugin } from '../regex-base.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const _plugin = createRegexLanguagePlugin({
  name: 'elixir',
  language: 'elixir',
  extensions: ['.ex', '.exs'],
  versions: ['1.12', '1.13', '1.14', '1.15', '1.16', '1.17'],
  symbolPatterns: [
    // defmodule — anchored to line start
    { kind: 'class', pattern: /^\s*defmodule\s+([\w.]+)/gm, meta: { module: true } },
    // defprotocol
    { kind: 'interface', pattern: /^\s*defprotocol\s+([\w.]+)/gm },
    // defimpl
    { kind: 'class', pattern: /^\s*defimpl\s+([\w.]+)/gm, meta: { impl: true } },
    // defdelegate
    { kind: 'function', pattern: /^\s*defdelegate\s+(\w+[?!]?)/gm, meta: { delegate: true } },
    // defstruct (name comes from enclosing module, capture defstruct keyword for now)
    { kind: 'type', pattern: /^\s*(defstruct)\b/gm, meta: { struct: true } },
    // def (public function)
    { kind: 'function', pattern: /^\s*def\s+(\w+[?!]?)\s*[\(,]/gm },
    // defp (private function)
    { kind: 'function', pattern: /^\s*defp\s+(\w+[?!]?)\s*[\(,]/gm, meta: { private: true } },
    // defmacro
    { kind: 'function', pattern: /^\s*defmacro\s+(\w+[?!]?)/gm, meta: { macro: true } },
    // defmacrop
    { kind: 'function', pattern: /^\s*defmacrop\s+(\w+[?!]?)/gm, meta: { macro: true, private: true } },
    // defguard
    { kind: 'function', pattern: /^\s*defguard\s+(\w+[?!]?)/gm, meta: { guard: true } },
    // defguardp
    { kind: 'function', pattern: /^\s*defguardp\s+(\w+[?!]?)/gm, meta: { guard: true, private: true } },
    // @type
    { kind: 'type', pattern: /^\s*@type\s+(\w+)/gm },
    // @typep
    { kind: 'type', pattern: /^\s*@typep\s+(\w+)/gm, meta: { private: true } },
    // @opaque
    { kind: 'type', pattern: /^\s*@opaque\s+(\w+)/gm, meta: { opaque: true } },
    // @callback
    { kind: 'function', pattern: /^\s*@callback\s+(\w+)/gm, meta: { callback: true } },
  ],
  importPatterns: [
    { pattern: /^\s*import\s+([\w.]+)/gm },
    { pattern: /^\s*alias\s+([\w.]+)/gm },
    { pattern: /^\s*use\s+([\w.]+)/gm },
    { pattern: /^\s*require\s+([\w.]+)/gm },
  ],
  fqnSep: '.',
});

export const ElixirLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
