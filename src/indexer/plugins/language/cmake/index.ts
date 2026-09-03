/**
 * CMake Language Plugin — regex-based symbol extraction.
 *
 * Extracts: functions, macros, targets (executables, libraries), options, variables, and include edges.
 */

import type { LanguagePlugin } from '../../../../plugin-api/types.js';
import { createRegexLanguagePlugin } from '../regex-base.js';

const _plugin = createRegexLanguagePlugin({
  name: 'cmake',
  language: 'cmake',
  extensions: ['.cmake', 'CMakeLists.txt'],
  symbolPatterns: [
    // function(name ...)
    { kind: 'function', pattern: /^\s*function\s*\(\s*(\w+)/gim },
    // macro(name ...)
    { kind: 'function', pattern: /^\s*macro\s*\(\s*(\w+)/gim, meta: { macro: true } },
    // project(name ...)
    { kind: 'module', pattern: /^\s*project\s*\(\s*(\w+)/gim },
    // add_executable(name ...). Target names commonly use hyphens
    // (my-tool); the lookahead skips ALIAS/generator-expression targets
    // (fmt::${target}) instead of truncating them into a wrong name.
    {
      kind: 'function',
      pattern: /^\s*add_executable\s*\(\s*([\w-]+)(?=[\s)])/gim,
      meta: { target: 'executable' },
    },
    // add_library(name ...). Same hyphenated-name / alias-skip reasoning
    // as add_executable above.
    {
      kind: 'function',
      pattern: /^\s*add_library\s*\(\s*([\w-]+)(?=[\s)])/gim,
      meta: { target: 'library' },
    },
    // add_custom_target(name ...). Custom target names are hyphenated even
    // more often than library/executable ones (format-check, run-tests).
    {
      kind: 'function',
      pattern: /^\s*add_custom_target\s*\(\s*([\w-]+)(?=[\s)])/gim,
      meta: { target: 'custom' },
    },
    // set(NAME value)
    { kind: 'variable', pattern: /^\s*set\s*\(\s*(\w+)/gim },
    // option(NAME "description" DEFAULT)
    { kind: 'variable', pattern: /^\s*option\s*\(\s*(\w+)/gim, meta: { option: true } },
  ],
  importPatterns: [
    // include(module) or include(path/to/file.cmake) — `\w+` alone stops at
    // the first `/` or `.`, truncating the common `dir/File.cmake` shape.
    { pattern: /^\s*include\s*\(\s*"?([^\s()"]+)/gim },
    // find_package(Name ...)
    { pattern: /^\s*find_package\s*\(\s*"?([^\s()"]+)/gim },
    // add_subdirectory(dir) — vendored deps are routinely a path
    // (`add_subdirectory(third_party/fmt)`), same truncation risk as include.
    { pattern: /^\s*add_subdirectory\s*\(\s*"?([^\s()"]+)/gim },
  ],
});

export const CMakeLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
