/**
 * Clojure Language Plugin — regex-based symbol extraction.
 *
 * Extracts: defn/defn-, def, defonce, defmacro, defmethod, defmulti,
 *           defprotocol, definterface, defrecord, deftype, defstruct,
 *           extend-type, extend-protocol, ns, spec definitions (s/def, s/fdef),
 *           and import/require edges (including nested vectors).
 */
import { createRegexLanguagePlugin } from '../regex-base.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const _plugin = createRegexLanguagePlugin({
  name: 'clojure',
  language: 'clojure',
  extensions: ['.clj', '.cljs', '.cljc', '.edn'],
  docComments: { linePrefix: [';;'] },
  symbolPatterns: [
    // ─── Namespaces ────────────────────────────────────────────────────
    { kind: 'namespace', pattern: /\(\s*ns\s+([\w.\-]+)/gm },
    { kind: 'namespace', pattern: /\(\s*in-ns\s+'([\w.\-]+)/gm },

    // ─── Functions ─────────────────────────────────────────────────────
    { kind: 'function', pattern: /\(\s*defn\s+([\w*+!\-'?<>=/.]+)/gm, meta: { public: true } },
    { kind: 'function', pattern: /\(\s*defn-\s+([\w*+!\-'?<>=/.]+)/gm, meta: { private: true } },
    { kind: 'function', pattern: /\(\s*defmacro\s+([\w*+!\-'?<>=/.]+)/gm, meta: { macro: true } },
    {
      kind: 'function',
      pattern: /\(\s*defmulti\s+([\w*+!\-'?<>=/.]+)/gm,
      meta: { multimethod: true },
    },
    { kind: 'method', pattern: /\(\s*defmethod\s+([\w*+!\-'?<>=/.]+)/gm },

    // ─── Variables & Constants ─────────────────────────────────────────
    { kind: 'variable', pattern: /\(\s*def\s+([\w*+!\-'?<>=/.]+)/gm },
    { kind: 'variable', pattern: /\(\s*defonce\s+([\w*+!\-'?<>=/.]+)/gm, meta: { once: true } },
    { kind: 'constant', pattern: /\(\s*def\s+\^:const\s+([\w*+!\-'?<>=/.]+)/gm },
    {
      kind: 'variable',
      pattern: /\(\s*def\s+\^:dynamic\s+([\w*+!\-'?<>=/.]+)/gm,
      meta: { dynamic: true },
    },
    {
      kind: 'variable',
      pattern: /\(\s*def\s+\^:private\s+([\w*+!\-'?<>=/.]+)/gm,
      meta: { private: true },
    },

    // ─── Protocols & Interfaces ────────────────────────────────────────
    { kind: 'interface', pattern: /\(\s*defprotocol\s+([\w*+!\-'?<>=/.]+)/gm },
    {
      kind: 'interface',
      pattern: /\(\s*definterface\s+([\w*+!\-'?<>=/.]+)/gm,
      meta: { java: true },
    },

    // ─── Types & Records ───────────────────────────────────────────────
    { kind: 'class', pattern: /\(\s*defrecord\s+([\w*+!\-'?<>=/.]+)/gm, meta: { record: true } },
    { kind: 'class', pattern: /\(\s*deftype\s+([\w*+!\-'?<>=/.]+)/gm },
    {
      kind: 'class',
      pattern: /\(\s*defstruct\s+([\w*+!\-'?<>=/.]+)/gm,
      meta: { struct: true, legacy: true },
    },

    // ─── Protocol Extensions ───────────────────────────────────────────
    {
      kind: 'class',
      pattern: /\(\s*extend-type\s+([\w*+!\-'?<>=/.]+)/gm,
      meta: { extension: true },
    },
    {
      kind: 'interface',
      pattern: /\(\s*extend-protocol\s+([\w*+!\-'?<>=/.]+)/gm,
      meta: { extension: true },
    },

    // ─── Specs (clojure.spec.alpha) ────────────────────────────────────
    {
      kind: 'type',
      pattern: /\(\s*(?:s|spec(?:\.alpha)?)\/def\s+::([\w*+!\-'?<>=/.]+)/gm,
      meta: { spec: true },
    },
    {
      kind: 'type',
      pattern: /\(\s*(?:s|spec(?:\.alpha)?)\/fdef\s+([\w*+!\-'?<>=/.]+)/gm,
      meta: { fspec: true },
    },

    // ─── ClojureScript specifics ───────────────────────────────────────
    { kind: 'class', pattern: /\(\s*defui\s+([\w*+!\-'?<>=/.]+)/gm, meta: { component: true } },
    {
      kind: 'class',
      pattern: /\(\s*defcomponent\s+([\w*+!\-'?<>=/.]+)/gm,
      meta: { component: true },
    },

    // ─── Test definitions ──────────────────────────────────────────────
    { kind: 'function', pattern: /\(\s*deftest\s+([\w*+!\-'?<>=/.]+)/gm, meta: { test: true } },
    {
      kind: 'function',
      pattern: /\(\s*defspec\s+([\w*+!\-'?<>=/.]+)/gm,
      meta: { test: true, generative: true },
    },
  ],
  importPatterns: [
    { pattern: /\(:require\s+\[?([\w.\-]+)/gm },
    { pattern: /\[\s*([\w.\-]+)\s+:as\b/gm },
    { pattern: /\[\s*([\w.\-]+)\s+:refer\b/gm },
    { pattern: /\(:import\s+\[?([\w.\-]+)/gm },
    { pattern: /\(\s*require\s+'([\w.\-]+)/gm },
    { pattern: /\(\s*use\s+'([\w.\-]+)/gm },
    { pattern: /\(:require-macros\s+\[?([\w.\-]+)/gm },
  ],
  fqnSep: '/',
});

export const ClojureLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
