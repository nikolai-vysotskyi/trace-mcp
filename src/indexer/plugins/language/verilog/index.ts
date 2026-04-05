/**
 * Verilog / SystemVerilog Language Plugin — regex-based symbol extraction.
 *
 * Extracts: modules, interfaces, packages, classes, functions, tasks, parameters, and import edges.
 */
import { createRegexLanguagePlugin } from '../regex-base.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const _plugin = createRegexLanguagePlugin({
  name: 'verilog',
  language: 'verilog',
  extensions: ['.v', '.sv', '.svh', '.vh'],
  symbolPatterns: [
    // module name
    { kind: 'module', pattern: /^\s*module\s+(\w+)/gm },
    // interface name
    { kind: 'interface', pattern: /^\s*interface\s+(\w+)/gm },
    // package name
    { kind: 'namespace', pattern: /^\s*package\s+(\w+)/gm },
    // class name (SystemVerilog)
    { kind: 'class', pattern: /^\s*(?:virtual\s+)?class\s+(\w+)/gm },
    // function [type] name
    { kind: 'function', pattern: /^\s*(?:virtual\s+)?function\s+(?:\w+\s+)?(\w+)/gm },
    // task name
    { kind: 'function', pattern: /^\s*(?:virtual\s+)?task\s+(\w+)/gm, meta: { task: true } },
    // parameter / localparam NAME
    { kind: 'constant', pattern: /^\s*(?:local)?parameter\s+(?:[\w\[\]:]+\s+)?(\w+)/gm },
    // `define NAME
    { kind: 'constant', pattern: /^\s*`define\s+(\w+)/gm },
    // typedef ... name
    { kind: 'type', pattern: /^\s*typedef\s+(?:enum|struct|union)?\s*(?:\{[^}]*\}\s*)?(\w+)\s*;/gm },
  ],
  importPatterns: [
    // import pkg::*; or import pkg::name;
    { pattern: /^\s*import\s+([\w]+)::/gm },
    // `include "file"
    { pattern: /^\s*`include\s+"([^"]+)"/gm },
  ],
});

export const VerilogLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
