/**
 * Svelte Language Plugin — regex-based symbol extraction.
 *
 * Extracts: script-level exports, component props ($props), reactive declarations,
 * stores, event dispatchers, actions, and import edges.
 */
import { createRegexLanguagePlugin } from '../regex-base.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const _plugin = createRegexLanguagePlugin({
  name: 'svelte',
  language: 'svelte',
  extensions: ['.svelte'],
  symbolPatterns: [
    // export let name (Svelte 4 props)
    { kind: 'property', pattern: /^\s*export\s+let\s+(\w+)/gm, meta: { prop: true } },
    // export const name
    { kind: 'constant', pattern: /^\s*export\s+const\s+(\w+)/gm },
    // export function name
    { kind: 'function', pattern: /^\s*export\s+(?:async\s+)?function\s+(\w+)/gm },
    // let { ... } = $props() — Svelte 5 runes
    { kind: 'property', pattern: /\$props\(\)/gm },
    // $: name = (reactive declarations - Svelte 4)
    { kind: 'variable', pattern: /^\s*\$:\s+(\w+)\s*=/gm, meta: { reactive: true } },
    // $derived / $state / $effect (Svelte 5 runes)
    {
      kind: 'variable',
      pattern: /^\s*(?:let|const)\s+(\w+)\s*=\s*\$(?:state|derived|effect)/gm,
      meta: { rune: true },
    },
    // function name (non-exported)
    { kind: 'function', pattern: /^\s*(?:async\s+)?function\s+(\w+)/gm },
    // const name = (non-exported)
    { kind: 'variable', pattern: /^\s*(?:const|let)\s+(\w+)\s*=/gm },
    // {#each}, {#if}, {#await} — template blocks (named via expression)
    { kind: 'variable', pattern: /\{#snippet\s+(\w+)/gm, meta: { snippet: true } },
  ],
  importPatterns: [
    // import ... from 'module'
    { pattern: /import\s+.*?\s+from\s+['"]([^'"]+)['"]/gm },
    // import 'module'
    { pattern: /import\s+['"]([^'"]+)['"]/gm },
  ],
});

export const SvelteLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
