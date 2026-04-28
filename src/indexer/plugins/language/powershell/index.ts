/**
 * PowerShell Language Plugin — multi-pass regex extraction.
 *
 * Pass 1: Containers — classes, enums, DSC configurations
 * Pass 2: Members — methods, properties inside classes; enum values
 *
 * Comment stripping: #, <# #>
 * Scope: braces
 */

import type { LanguagePlugin } from '../../../../plugin-api/types.js';
import { type CommentStyle, createMultiPassPlugin } from '../regex-base-v2.js';

const comments: CommentStyle = {
  line: ['#'],
  block: [['<#', '#>']],
  strings: ['"', "'"],
};

const _plugin = createMultiPassPlugin({
  name: 'powershell',
  language: 'powershell',
  extensions: ['.ps1', '.psm1', '.psd1'],
  comments,
  scope: { style: 'braces' },

  containerPatterns: [
    // class MyClass [: Base] {
    {
      kind: 'class',
      pattern: /^\s*class\s+(\w+)(?:\s*:\s*[\w,\s]+)?\s*\{/gim,
      memberPatterns: [
        // [returntype] MethodName(params) { — method
        { kind: 'method', pattern: /^\s*(?:(?:static|hidden)\s+)*\[[\w.[\]]+\]\s*(\w+)\s*\(/gm },
        // MethodName(params) { — untyped method
        { kind: 'method', pattern: /^\s*(?:(?:static|hidden)\s+)*(\w+)\s*\([^)]*\)\s*\{/gm },
        // [type]$PropertyName — property
        { kind: 'property', pattern: /^\s*(?:(?:static|hidden)\s+)*\[[\w.[\]]+\]\s*\$(\w+)/gm },
        // $PropertyName — untyped property
        { kind: 'property', pattern: /^\s*(?:(?:static|hidden)\s+)*\$(\w+)\s*(?:=|$)/gm },
      ],
    },
    // enum MyEnum {
    {
      kind: 'enum',
      pattern: /^\s*enum\s+(\w+)\s*\{/gim,
      memberPatterns: [
        // EnumValue [= N]
        { kind: 'constant', pattern: /^\s*(\w+)\s*(?:=\s*\d+)?$/gm },
      ],
    },
    // configuration DSCConfig {
    {
      kind: 'class',
      pattern: /^\s*configuration\s+(\w+)\s*\{/gim,
      meta: { dsc: true },
      memberPatterns: [
        // Node NodeName { — DSC node
        { kind: 'method', pattern: /^\s*Node\s+(?:["']?)([\w.$]+)/gim },
        // ResourceName ResourceLabel {
        { kind: 'property', pattern: /^\s*(\w+)\s+\w+\s*\{/gm },
      ],
    },
  ],

  symbolPatterns: [
    // function Verb-Noun {
    { kind: 'function', pattern: /^\s*function\s+([\w-]+)/gim },
    // filter Name {
    { kind: 'function', pattern: /^\s*filter\s+([\w-]+)/gim },
    // workflow Name {
    { kind: 'function', pattern: /^\s*workflow\s+([\w-]+)/gim },
    // Set-Variable / New-Variable with -Option Constant/ReadOnly
    {
      kind: 'constant',
      pattern: /(?:Set|New)-Variable\s+(?:-Name\s+)?(\w+).*-Option\s+(?:Constant|ReadOnly)/gim,
    },
    // $script:VarName or $global:VarName (module-level vars)
    { kind: 'variable', pattern: /\$(?:script|global):(\w+)\s*=/gm },
    // param() block parameter declarations: [Type]$ParamName
    { kind: 'variable', pattern: /\[Parameter[^\]]*\][^$]*\$(\w+)/gm, memberOnly: true },
  ],

  importPatterns: [
    // using module/namespace/assembly
    { pattern: /^\s*using\s+(?:module|namespace|assembly)\s+([\w.\\/-]+)/gim },
    // Import-Module ModuleName
    { pattern: /Import-Module\s+(?:-Name\s+)?([\w.\\/-]+)/gim },
    // . ./script.ps1 (dot-sourcing)
    { pattern: /^\s*\.\s+([\w.\\/-]+\.ps[m1d]*)/gim },
    // #Requires -Modules ModuleName
    { pattern: /#Requires\s+-Modules?\s+([\w.]+)/gim },
  ],
});

export const PowerShellLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
