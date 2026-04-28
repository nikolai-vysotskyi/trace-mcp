/**
 * SQL Language Plugin -- regex-based symbol extraction.
 *
 * Extracts: CREATE TABLE/VIEW/FUNCTION/PROCEDURE/INDEX/SCHEMA/TRIGGER/TYPE,
 * CTEs (WITH ... AS), with support for OR REPLACE, IF NOT EXISTS, and
 * schema-qualified names.
 */

import type { LanguagePlugin } from '../../../../plugin-api/types.js';
import { createRegexLanguagePlugin } from '../regex-base.js';

const _plugin = createRegexLanguagePlugin({
  name: 'sql',
  language: 'sql',
  extensions: ['.sql'],
  symbolPatterns: [
    // CREATE [OR REPLACE] TABLE [IF NOT EXISTS] [schema.]name
    {
      kind: 'class',
      pattern:
        /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[a-zA-Z_]\w*\.)?([a-zA-Z_]\w*)/gim,
      meta: { sqlKind: 'table' },
    },
    // CREATE [OR REPLACE] VIEW [IF NOT EXISTS] [schema.]name
    {
      kind: 'class',
      pattern:
        /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[a-zA-Z_]\w*\.)?([a-zA-Z_]\w*)/gim,
      meta: { sqlKind: 'view' },
    },
    // CREATE [OR REPLACE] FUNCTION [IF NOT EXISTS] [schema.]name
    {
      kind: 'function',
      pattern:
        /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[a-zA-Z_]\w*\.)?([a-zA-Z_]\w*)/gim,
      meta: { sqlKind: 'function' },
    },
    // CREATE [OR REPLACE] PROCEDURE [IF NOT EXISTS] [schema.]name
    {
      kind: 'function',
      pattern:
        /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[a-zA-Z_]\w*\.)?([a-zA-Z_]\w*)/gim,
      meta: { sqlKind: 'procedure' },
    },
    // CREATE [UNIQUE] INDEX [IF NOT EXISTS] name
    {
      kind: 'variable',
      pattern:
        /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:CONCURRENTLY\s+)?([a-zA-Z_]\w*)/gim,
      meta: { sqlKind: 'index' },
    },
    // CREATE SCHEMA [IF NOT EXISTS] name
    {
      kind: 'namespace',
      pattern: /^\s*CREATE\s+SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_]\w*)/gim,
      meta: { sqlKind: 'schema' },
    },
    // CREATE [OR REPLACE] TRIGGER name
    {
      kind: 'function',
      pattern:
        /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_]\w*)/gim,
      meta: { sqlKind: 'trigger' },
    },
    // CREATE [OR REPLACE] TYPE [schema.]name
    {
      kind: 'type',
      pattern:
        /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?TYPE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[a-zA-Z_]\w*\.)?([a-zA-Z_]\w*)/gim,
      meta: { sqlKind: 'type' },
    },
    // CTE: WITH [RECURSIVE] name AS (
    {
      kind: 'variable',
      pattern: /\bWITH\s+(?:RECURSIVE\s+)?([a-zA-Z_]\w*)\s+AS\s*\(/gim,
      meta: { sqlKind: 'cte' },
    },
    // CREATE [TEMPORARY|TEMP] TABLE
    {
      kind: 'class',
      pattern:
        /^\s*CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[a-zA-Z_]\w*\.)?([a-zA-Z_]\w*)/gim,
      meta: { sqlKind: 'temp_table' },
    },
  ],
});

export const SqlLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
