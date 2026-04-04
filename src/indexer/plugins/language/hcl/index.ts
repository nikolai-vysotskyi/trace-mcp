/**
 * HCL/Terraform Language Plugin -- regex-based symbol extraction.
 *
 * Extracts: resource, data, module, variable, output, locals, provider blocks.
 */
import { createRegexLanguagePlugin } from '../regex-base.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const _plugin = createRegexLanguagePlugin({
  name: 'hcl',
  language: 'hcl',
  extensions: ['.tf', '.hcl', '.tfvars'],
  symbolPatterns: [
    // resource "type" "name" {
    {
      kind: 'class',
      pattern: /^\s*resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/gm,
      nameGroup: 2,
      meta: { hclKind: 'resource' },
    },
    // data "type" "name" {
    {
      kind: 'class',
      pattern: /^\s*data\s+"([^"]+)"\s+"([^"]+)"\s*\{/gm,
      nameGroup: 2,
      meta: { hclKind: 'data' },
    },
    // module "name" {
    {
      kind: 'namespace',
      pattern: /^\s*module\s+"([^"]+)"\s*\{/gm,
      meta: { hclKind: 'module' },
    },
    // variable "name" {
    {
      kind: 'variable',
      pattern: /^\s*variable\s+"([^"]+)"\s*\{/gm,
      meta: { hclKind: 'variable' },
    },
    // output "name" {
    {
      kind: 'variable',
      pattern: /^\s*output\s+"([^"]+)"\s*\{/gm,
      meta: { hclKind: 'output' },
    },
    // locals block: capture individual key assignments inside locals { key = ... }
    // This regex finds `key =` lines inside locals blocks (indented, not starting with `}`)
    {
      kind: 'variable',
      pattern: /^\s{2,}(\w+)\s*=/gm,
      meta: { hclKind: 'local' },
    },
    // provider "name" {
    {
      kind: 'variable',
      pattern: /^\s*provider\s+"([^"]+)"\s*\{/gm,
      meta: { hclKind: 'provider' },
    },
  ],
});

export const HclLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
