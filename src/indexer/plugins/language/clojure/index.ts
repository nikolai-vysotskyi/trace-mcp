/**
 * Clojure Language Plugin — regex-based symbol extraction.
 *
 * Extracts: defn, def, defmacro, defprotocol, defrecord, deftype, defmulti, ns declarations, and import edges.
 */
import { createRegexLanguagePlugin } from '../regex-base.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const _plugin = createRegexLanguagePlugin({
  name: 'clojure',
  language: 'clojure',
  extensions: ['.clj', '.cljs', '.cljc', '.edn'],
  symbolPatterns: [
    // (defn name / (defn- name
    { kind: 'function', pattern: /\(\s*defn-?\s+([\w*+!\-'?<>=/.]+)/gm },
    // (defmacro name
    { kind: 'function', pattern: /\(\s*defmacro\s+([\w*+!\-'?<>=/.]+)/gm, meta: { macro: true } },
    // (defmulti name
    { kind: 'function', pattern: /\(\s*defmulti\s+([\w*+!\-'?<>=/.]+)/gm },
    // (defmethod name
    { kind: 'method', pattern: /\(\s*defmethod\s+([\w*+!\-'?<>=/.]+)/gm },
    // (def name
    { kind: 'variable', pattern: /\(\s*def\s+([\w*+!\-'?<>=/.]+)/gm },
    // (defprotocol Name
    { kind: 'interface', pattern: /\(\s*defprotocol\s+([\w*+!\-'?<>=/.]+)/gm },
    // (defrecord Name / (deftype Name
    { kind: 'class', pattern: /\(\s*def(?:record|type)\s+([\w*+!\-'?<>=/.]+)/gm },
    // (ns name.space
    { kind: 'namespace', pattern: /\(\s*ns\s+([\w.\-]+)/gm },
  ],
  importPatterns: [
    // (:require [lib.name ...])
    { pattern: /\(:require\s+\[?([\w.\-]+)/gm },
    // (:import [package Class])
    { pattern: /\(:import\s+\[?([\w.\-]+)/gm },
  ],
});

export const ClojureLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
