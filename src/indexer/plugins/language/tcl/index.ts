/**
 * Tcl Language Plugin — multi-pass regex extraction.
 *
 * Pass 1: Containers — TclOO classes, Itcl classes, Snit types/widgets,
 *         namespaces, oo::define blocks
 * Pass 2: Members — methods, properties, constructors, variables inside containers
 *
 * Comment stripping: #
 * Scope: braces
 */

import type { LanguagePlugin } from '../../../../plugin-api/types.js';
import { type CommentStyle, createMultiPassPlugin } from '../regex-base-v2.js';

const comments: CommentStyle = {
  line: ['#'],
  block: [],
  strings: ['"'],
};

const _plugin = createMultiPassPlugin({
  name: 'tcl',
  language: 'tcl',
  extensions: ['.tcl', '.tk', '.itcl', '.itk', '.tm'],
  comments,
  scope: { style: 'braces' },

  containerPatterns: [
    // ── TclOO Classes (8.6+) ───────────────────────────────────────────
    {
      kind: 'class',
      pattern: /^\s*oo::class\s+create\s+([\w:]+)\s*\{/gm,
      meta: { tclOO: true },
      memberPatterns: [
        { kind: 'method', pattern: /^\s*method\s+(\w+)\s*\{/gm },
        {
          kind: 'method',
          pattern: /^\s*(constructor)\s*(?:\{[^}]*\}\s*)?\{/gm,
          meta: { constructor: true },
        },
        {
          kind: 'method',
          pattern: /^\s*(destructor)\s*(?:\{[^}]*\}\s*)?\{/gm,
          meta: { destructor: true },
        },
        { kind: 'method', pattern: /^\s*forward\s+(\w+)/gm, meta: { forward: true } },
        { kind: 'variable', pattern: /^\s*variable\s+(\w+)/gm },
      ],
    },
    // ── oo::define blocks ──────────────────────────────────────────────
    {
      kind: 'class',
      pattern: /^\s*oo::define\s+([\w:]+)\s*\{/gm,
      meta: { tclOO: true },
      memberPatterns: [
        { kind: 'method', pattern: /^\s*method\s+(\w+)\s*\{/gm },
        {
          kind: 'method',
          pattern: /^\s*(constructor)\s*(?:\{[^}]*\}\s*)?\{/gm,
          meta: { constructor: true },
        },
        {
          kind: 'method',
          pattern: /^\s*(destructor)\s*(?:\{[^}]*\}\s*)?\{/gm,
          meta: { destructor: true },
        },
        { kind: 'method', pattern: /^\s*forward\s+(\w+)/gm, meta: { forward: true } },
        { kind: 'variable', pattern: /^\s*variable\s+(\w+)/gm },
        { kind: 'method', pattern: /^\s*superclass\s+([\w:]+)/gm, meta: { superclass: true } },
        { kind: 'method', pattern: /^\s*mixin\s+([\w:]+)/gm, meta: { mixin: true } },
        { kind: 'method', pattern: /^\s*export\s+(\w+)/gm, meta: { exported: true } },
        { kind: 'method', pattern: /^\s*unexport\s+(\w+)/gm, meta: { unexported: true } },
      ],
    },
    // ── Itcl Classes ───────────────────────────────────────────────────
    {
      kind: 'class',
      pattern: /^\s*(?:itcl::)?class\s+([\w:]+)\s*\{/gm,
      meta: { itcl: true },
      memberPatterns: [
        { kind: 'method', pattern: /^\s*(?:public|protected|private)\s+method\s+(\w+)/gm },
        { kind: 'method', pattern: /^\s*method\s+(\w+)/gm },
        {
          kind: 'method',
          pattern: /^\s*(constructor)\s*(?:\{[^}]*\}\s*)?\{/gm,
          meta: { constructor: true },
        },
        {
          kind: 'method',
          pattern: /^\s*(destructor)\s*(?:\{[^}]*\}\s*)?\{/gm,
          meta: { destructor: true },
        },
        { kind: 'variable', pattern: /^\s*(?:public|protected|private)\s+variable\s+(\w+)/gm },
        { kind: 'variable', pattern: /^\s*variable\s+(\w+)/gm },
        { kind: 'variable', pattern: /^\s*common\s+(\w+)/gm, meta: { static: true } },
        // inherit BaseClass
        { kind: 'type', pattern: /^\s*inherit\s+([\w:]+)/gm, meta: { inherit: true } },
      ],
    },
    // ── Snit Types ─────────────────────────────────────────────────────
    {
      kind: 'class',
      pattern: /^\s*snit::type\s+([\w:]+)\s*\{/gm,
      meta: { snit: true },
      memberPatterns: [
        { kind: 'method', pattern: /^\s*method\s+(\w+)/gm },
        { kind: 'method', pattern: /^\s*typemethod\s+(\w+)/gm, meta: { static: true } },
        {
          kind: 'method',
          pattern: /^\s*(constructor)\s*(?:\{[^}]*\}\s*)?\{/gm,
          meta: { constructor: true },
        },
        {
          kind: 'method',
          pattern: /^\s*(destructor)\s*(?:\{[^}]*\}\s*)?\{/gm,
          meta: { destructor: true },
        },
        { kind: 'variable', pattern: /^\s*variable\s+(\w+)/gm },
        { kind: 'variable', pattern: /^\s*typevariable\s+(\w+)/gm, meta: { static: true } },
        { kind: 'property', pattern: /^\s*option\s+(-\w+)/gm },
        { kind: 'method', pattern: /^\s*delegate\s+method\s+(\w+)/gm, meta: { delegate: true } },
        { kind: 'method', pattern: /^\s*delegate\s+option\s+(-\w+)/gm, meta: { delegate: true } },
        { kind: 'method', pattern: /^\s*onconfigure\s+(-\w+)/gm, meta: { hook: true } },
        { kind: 'method', pattern: /^\s*oncget\s+(-\w+)/gm, meta: { hook: true } },
      ],
    },
    // ── Snit Widgets ───────────────────────────────────────────────────
    {
      kind: 'class',
      pattern: /^\s*snit::widget\s+([\w:]+)\s*\{/gm,
      meta: { snit: true, widget: true },
      memberPatterns: [
        { kind: 'method', pattern: /^\s*method\s+(\w+)/gm },
        { kind: 'method', pattern: /^\s*typemethod\s+(\w+)/gm, meta: { static: true } },
        { kind: 'variable', pattern: /^\s*variable\s+(\w+)/gm },
        { kind: 'variable', pattern: /^\s*typevariable\s+(\w+)/gm, meta: { static: true } },
        { kind: 'property', pattern: /^\s*option\s+(-\w+)/gm },
        { kind: 'method', pattern: /^\s*delegate\s+method\s+(\w+)/gm, meta: { delegate: true } },
        { kind: 'method', pattern: /^\s*delegate\s+option\s+(-\w+)/gm, meta: { delegate: true } },
      ],
    },
    // ── Snit Widget Adaptors ───────────────────────────────────────────
    {
      kind: 'class',
      pattern: /^\s*snit::widgetadaptor\s+([\w:]+)\s*\{/gm,
      meta: { snit: true, adaptor: true },
      memberPatterns: [
        { kind: 'method', pattern: /^\s*method\s+(\w+)/gm },
        { kind: 'method', pattern: /^\s*typemethod\s+(\w+)/gm, meta: { static: true } },
        { kind: 'method', pattern: /^\s*delegate\s+method\s+(\w+)/gm, meta: { delegate: true } },
      ],
    },
    // ── Namespaces ─────────────────────────────────────────────────────
    {
      kind: 'namespace',
      pattern: /^\s*namespace\s+eval\s+([\w:]+)\s*\{/gm,
      memberPatterns: [
        { kind: 'function', pattern: /^\s*proc\s+([\w:]+)\s*\{/gm },
        { kind: 'variable', pattern: /^\s*variable\s+(\w+)/gm },
      ],
    },
  ],

  symbolPatterns: [
    // ── Top-level procs ────────────────────────────────────────────────
    { kind: 'function', pattern: /^\s*proc\s+([\w:]+)\s*\{/gm },
    // proc with bare-word args
    { kind: 'function', pattern: /^\s*proc\s+([\w:]+)\s+\w/gm },

    // ── Namespace exports ──────────────────────────────────────────────
    { kind: 'function', pattern: /^\s*namespace\s+export\s+([\w:*]+)/gm, meta: { exported: true } },

    // ── Ensemble creation ──────────────────────────────────────────────
    {
      kind: 'function',
      pattern: /^\s*namespace\s+ensemble\s+create\s+-command\s+([\w:]+)/gm,
      meta: { ensemble: true },
    },

    // ── Coroutines (8.6+) ──────────────────────────────────────────────
    { kind: 'function', pattern: /^\s*coroutine\s+(\w+)/gm, meta: { coroutine: true } },

    // ── Itcl body (standalone method implementation) ────────────────────
    { kind: 'method', pattern: /^\s*(?:itcl::)?body\s+([\w:]+)/gm, meta: { itcl: true } },

    // ── Package provide ────────────────────────────────────────────────
    { kind: 'namespace', pattern: /^\s*package\s+provide\s+([\w:]+)/gm },

    // ── Global variables ───────────────────────────────────────────────
    { kind: 'variable', pattern: /^\s*variable\s+(\w+)/gm },
    { kind: 'variable', pattern: /^\s*global\s+(\w+)/gm, meta: { global: true } },
  ],

  importPatterns: [
    // package require [-exact] name [version]
    { pattern: /^\s*package\s+require\s+(?:-exact\s+)?([\w:]+)/gm },
    // source path/to/file.tcl
    { pattern: /^\s*source\s+(\S+)/gm },
    // package ifneeded name version [script]
    { pattern: /^\s*package\s+ifneeded\s+([\w:]+)/gm },
  ],

  fqnSep: '::',
});

export const TclLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
