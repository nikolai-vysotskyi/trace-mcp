/**
 * Blade Language Plugin — regex-based symbol extraction.
 *
 * Extracts: sections, components, extends, push, slot, include, livewire
 * directives from Laravel Blade templates.
 */

import type { LanguagePlugin } from '../../../../plugin-api/types.js';
import { createRegexLanguagePlugin } from '../regex-base.js';

const _plugin = createRegexLanguagePlugin({
  name: 'blade',
  language: 'blade',
  extensions: ['.blade.php'],
  symbolPatterns: [
    // @section('name')
    {
      kind: 'property',
      pattern: /@section\s*\(\s*'([^']+)'\s*\)/gm,
      meta: { directive: 'section' },
    },
    // @component('name')
    {
      kind: 'property',
      pattern: /@component\s*\(\s*'([^']+)'\s*\)/gm,
      meta: { directive: 'component' },
    },
    // @push('name')
    {
      kind: 'property',
      pattern: /@push\s*\(\s*'([^']+)'\s*\)/gm,
      meta: { directive: 'push' },
    },
    // @slot('name')
    {
      kind: 'property',
      pattern: /@slot\s*\(\s*'([^']+)'\s*\)/gm,
      meta: { directive: 'slot' },
    },
  ],
  importPatterns: [
    // @extends('name')
    {
      pattern: /@extends\s*\(\s*'([^']+)'\s*\)/gm,
    },
    // @include('name')
    {
      pattern: /@include\s*\(\s*'([^']+)'\s*\)/gm,
    },
    // @livewire('name')
    {
      pattern: /@livewire\s*\(\s*'([^']+)'\s*\)/gm,
    },
  ],
});

export const BladeLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
