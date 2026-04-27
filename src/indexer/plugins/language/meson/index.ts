/**
 * Meson Build Language Plugin — regex-based symbol extraction.
 *
 * Extracts: project declarations, executables, libraries, dependencies, custom targets,
 * subdir calls, and variables.
 */

import type { LanguagePlugin } from '../../../../plugin-api/types.js';
import { createRegexLanguagePlugin } from '../regex-base.js';

const _plugin = createRegexLanguagePlugin({
  name: 'meson',
  language: 'meson',
  extensions: ['meson.build', 'meson_options.txt'],
  symbolPatterns: [
    // project('name', ...)
    { kind: 'module', pattern: /^\s*project\s*\(\s*'([^']+)'/gm },
    // name = executable('target_name', ...)
    {
      kind: 'function',
      pattern: /^\s*\w+\s*=\s*executable\s*\(\s*'([^']+)'/gm,
      meta: { target: 'executable' },
    },
    // name = shared_library / static_library / library / both_libraries
    {
      kind: 'function',
      pattern: /^\s*\w+\s*=\s*(?:shared_|static_|both_)?library\s*\(\s*'([^']+)'/gm,
      meta: { target: 'library' },
    },
    // name = custom_target('target_name', ...)
    {
      kind: 'function',
      pattern: /^\s*\w+\s*=\s*custom_target\s*\(\s*'([^']+)'/gm,
      meta: { target: 'custom' },
    },
    // name = dependency('dep_name')
    { kind: 'variable', pattern: /^\s*(\w+)\s*=\s*dependency\s*\(/gm, meta: { dependency: true } },
    // variable assignments: name = ...
    { kind: 'variable', pattern: /^\s*(\w+)\s*=/gm },
    // subdir('path')
    { kind: 'module', pattern: /^\s*subdir\s*\(\s*'([^']+)'/gm, meta: { subdir: true } },
  ],
});

export const MesonLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
