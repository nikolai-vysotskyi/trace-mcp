/**
 * Apex (Salesforce) Language Plugin — multi-pass regex extraction.
 *
 * Pass 1: Containers — classes, interfaces, enums, triggers
 * Pass 2: Members — methods, properties, constants, inner classes, annotations
 *
 * Comment stripping: //, block comments
 * Scope: braces
 */
import { createMultiPassPlugin, type CommentStyle } from '../regex-base-v2.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const comments: CommentStyle = {
  line: ['//'],
  block: [['/*', '*/']],
  strings: ["'"],
};

/** Access modifiers + sharing keywords */
const ACCESS = /(?:(?:public|private|protected|global|virtual|abstract|with\s+sharing|without\s+sharing|inherited\s+sharing)\s+)*/;
const ACCESS_SRC = ACCESS.source;

const _plugin = createMultiPassPlugin({
  name: 'apex',
  language: 'apex',
  extensions: ['.cls', '.trigger', '.apex'],
  comments,
  scope: { style: 'braces' },

  containerPatterns: [
    // class declaration
    {
      kind: 'class',
      pattern: new RegExp(`^\\s*${ACCESS_SRC}class\\s+(\\w+)(?:\\s+extends\\s+\\w+)?(?:\\s+implements\\s+[\\w,\\s]+)?\\s*\\{`, 'gim'),
      memberPatterns: [
        // method: [access] [modifiers] ReturnType methodName(args) {
        { kind: 'method', pattern: new RegExp(`^\\s*(?:(?:public|private|protected|global|static|virtual|abstract|override|testMethod)\\s+)*(?:[\\w<>,\\[\\]\\s]+?)\\s+(\\w+)\\s*\\([^)]*\\)\\s*\\{`, 'gm') },
        // property: [access] Type PropertyName { get; set; }
        { kind: 'property', pattern: /^\s*(?:(?:public|private|protected|global|static|transient)\s+)*(\w+)\s+(\w+)\s*\{\s*(?:get|set)/gim, nameGroup: 2 },
        // constant: static final Type NAME = value;
        { kind: 'constant', pattern: /\bstatic\s+final\s+\w+\s+(\w+)\s*=/gim },
        // inner class
        { kind: 'class', pattern: new RegExp(`^\\s*${ACCESS_SRC}class\\s+(\\w+)`, 'gim') },
        // inner enum
        { kind: 'enum', pattern: new RegExp(`^\\s*${ACCESS_SRC}enum\\s+(\\w+)`, 'gim') },
      ],
    },
    // interface declaration
    {
      kind: 'interface',
      pattern: new RegExp(`^\\s*${ACCESS_SRC}interface\\s+(\\w+)`, 'gim'),
      memberPatterns: [
        { kind: 'method', pattern: /^\s*(?:\w+\s+)*(\w+)\s*\([^)]*\)\s*;/gm },
      ],
    },
    // enum declaration
    {
      kind: 'enum',
      pattern: new RegExp(`^\\s*${ACCESS_SRC}enum\\s+(\\w+)\\s*\\{`, 'gim'),
      memberPatterns: [
        // enum values: VALUE1, VALUE2, ...
        { kind: 'constant', pattern: /\b([A-Z_]\w*)\b/g },
      ],
    },
    // trigger declaration
    {
      kind: 'class',
      pattern: /^\s*trigger\s+(\w+)\s+on\s+\w+\s*\([^)]*\)\s*\{/gim,
      meta: { trigger: true },
    },
  ],

  symbolPatterns: [
    // Top-level annotations as metadata markers (captures for context)
    { kind: 'variable', pattern: /@(?:isTest|AuraEnabled|InvocableMethod|InvocableVariable|RemoteAction|TestSetup|TestVisible)\b/gim, nameGroup: 0, memberOnly: true },
    // Top-level constant (outside class — rare but possible)
    { kind: 'constant', pattern: /\bstatic\s+final\s+\w+\s+(\w+)\s*=/gim },
  ],

  importPatterns: [
    // Apex doesn't have explicit imports, but we can track class references
    // No standard import patterns
  ],
});

export const ApexLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
