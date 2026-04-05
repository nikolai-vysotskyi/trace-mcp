/**
 * Vim Script Language Plugin — regex-based symbol extraction.
 *
 * Extracts: functions, commands, autocommands, variables, mappings, and source edges.
 */
import { createRegexLanguagePlugin } from '../regex-base.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const _plugin = createRegexLanguagePlugin({
  name: 'vimscript',
  language: 'vimscript',
  extensions: ['.vim', '.vimrc'],
  symbolPatterns: [
    // function[!] Name(...) or function[!] s:name(...)
    { kind: 'function', pattern: /^\s*fun(?:ction)?!?\s+([\w:#]+)\s*\(/gm },
    // command[!] [-flags] Name
    { kind: 'function', pattern: /^\s*com(?:mand)?!?\s+(?:-\w+\s+)*(\w+)/gm, meta: { command: true } },
    // let g:name / let s:name / let b:name / let name
    { kind: 'variable', pattern: /^\s*let\s+([gsbwtl]:\w+|\w+)\s*=/gm },
    // augroup Name
    { kind: 'class', pattern: /^\s*augroup\s+(\w+)/gm },
  ],
  importPatterns: [
    // source path/to/file.vim
    { pattern: /^\s*(?:so(?:urce)?|runtime)\s+(\S+)/gm },
  ],
});

export const VimScriptLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
