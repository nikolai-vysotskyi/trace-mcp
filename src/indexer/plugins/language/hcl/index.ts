/**
 * HCL/Terraform Language Plugin — line-by-line brace-depth-aware extraction.
 *
 * Extracts: resource, data, module, variable, output, locals, provider,
 * terraform required_providers, and moved blocks.
 *
 * Fixes the bug where `locals` extraction captured all indented `key =` lines
 * globally. Now only extracts keys inside locals blocks using brace depth tracking.
 */
import { ok } from 'neverthrow';
import type {
  LanguagePlugin,
  PluginManifest,
  FileParseResult,
  RawSymbol,
  RawEdge,
  SymbolKind,
} from '../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../errors.js';

function makeSymbolId(filePath: string, name: string, kind: SymbolKind, parent?: string): string {
  if (parent) return `${filePath}::${parent}::${name}#${kind}`;
  return `${filePath}::${name}#${kind}`;
}

type BlockKind =
  | 'resource'
  | 'data'
  | 'module'
  | 'variable'
  | 'output'
  | 'locals'
  | 'provider'
  | 'terraform'
  | 'moved'
  | 'other';

interface BlockState {
  kind: BlockKind;
  name: string;
  startLine: number;
  braceDepth: number; // brace depth at which this block was opened
  resourceType?: string;
  meta: Record<string, unknown>;
}

export class HclLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'hcl-language',
    version: '2.0.0',
    priority: 6,
  };

  supportedExtensions = ['.tf', '.hcl', '.tfvars'];

  extractSymbols(filePath: string, content: Buffer): TraceMcpResult<FileParseResult> {
    const source = content.toString('utf-8');
    const symbols: RawSymbol[] = [];
    const edges: RawEdge[] = [];
    const seen = new Set<string>();
    const lines = source.split('\n');

    let braceDepth = 0;
    const blockStack: BlockState[] = [];
    let byteOffset = 0;

    // Whether we are inside a terraform > required_providers sub-block
    let insideRequiredProviders = false;
    let requiredProvidersDepth = 0;

    function addSymbol(
      name: string,
      kind: SymbolKind,
      lineNum: number,
      offset: number,
      meta?: Record<string, unknown>,
    ): void {
      const sid = makeSymbolId(filePath, name, kind);
      if (seen.has(sid)) return;
      seen.add(sid);
      symbols.push({
        symbolId: sid,
        name,
        kind,
        fqn: name,
        byteStart: offset,
        byteEnd: offset + name.length,
        lineStart: lineNum,
        lineEnd: lineNum,
        metadata: meta,
      });
    }

    function addEdge(module: string): void {
      edges.push({ edgeType: 'imports', metadata: { module } });
    }

    function currentBlock(): BlockState | undefined {
      return blockStack.length > 0 ? blockStack[blockStack.length - 1] : undefined;
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;
      const lineOffset = byteOffset;
      const trimmed = line.trim();

      // Skip comments and blank lines
      if (trimmed.startsWith('#') || trimmed.startsWith('//') || trimmed === '') {
        byteOffset += line.length + 1;
        continue;
      }

      // Check for top-level block starts (only when braceDepth === 0)
      if (braceDepth === 0) {
        // resource "type" "name" {
        const resourceMatch = trimmed.match(/^resource\s+"([^"]+)"\s+"([^"]+)"\s*\{?\s*$/);
        if (resourceMatch) {
          addSymbol(resourceMatch[2], 'class', lineNum, lineOffset, {
            hclKind: 'resource',
            resourceType: resourceMatch[1],
          });
          if (trimmed.includes('{')) {
            braceDepth++;
            blockStack.push({
              kind: 'resource',
              name: resourceMatch[2],
              startLine: lineNum,
              braceDepth,
              resourceType: resourceMatch[1],
              meta: { hclKind: 'resource' },
            });
          }
          byteOffset += line.length + 1;
          continue;
        }

        // data "type" "name" {
        const dataMatch = trimmed.match(/^data\s+"([^"]+)"\s+"([^"]+)"\s*\{?\s*$/);
        if (dataMatch) {
          addSymbol(dataMatch[2], 'class', lineNum, lineOffset, {
            hclKind: 'data',
            resourceType: dataMatch[1],
          });
          if (trimmed.includes('{')) {
            braceDepth++;
            blockStack.push({
              kind: 'data',
              name: dataMatch[2],
              startLine: lineNum,
              braceDepth,
              resourceType: dataMatch[1],
              meta: { hclKind: 'data' },
            });
          }
          byteOffset += line.length + 1;
          continue;
        }

        // module "name" {
        const moduleMatch = trimmed.match(/^module\s+"([^"]+)"\s*\{?\s*$/);
        if (moduleMatch) {
          addSymbol(moduleMatch[1], 'namespace', lineNum, lineOffset, { hclKind: 'module' });
          if (trimmed.includes('{')) {
            braceDepth++;
            blockStack.push({
              kind: 'module',
              name: moduleMatch[1],
              startLine: lineNum,
              braceDepth,
              meta: { hclKind: 'module' },
            });
          }
          byteOffset += line.length + 1;
          continue;
        }

        // variable "name" {
        const variableMatch = trimmed.match(/^variable\s+"([^"]+)"\s*\{?\s*$/);
        if (variableMatch) {
          addSymbol(variableMatch[1], 'variable', lineNum, lineOffset, { hclKind: 'variable' });
          if (trimmed.includes('{')) {
            braceDepth++;
            blockStack.push({
              kind: 'variable',
              name: variableMatch[1],
              startLine: lineNum,
              braceDepth,
              meta: { hclKind: 'variable' },
            });
          }
          byteOffset += line.length + 1;
          continue;
        }

        // output "name" {
        const outputMatch = trimmed.match(/^output\s+"([^"]+)"\s*\{?\s*$/);
        if (outputMatch) {
          addSymbol(outputMatch[1], 'variable', lineNum, lineOffset, { hclKind: 'output' });
          if (trimmed.includes('{')) {
            braceDepth++;
            blockStack.push({
              kind: 'output',
              name: outputMatch[1],
              startLine: lineNum,
              braceDepth,
              meta: { hclKind: 'output' },
            });
          }
          byteOffset += line.length + 1;
          continue;
        }

        // locals {
        const localsMatch = trimmed.match(/^locals\s*\{?\s*$/);
        if (localsMatch) {
          if (trimmed.includes('{')) {
            braceDepth++;
            blockStack.push({
              kind: 'locals',
              name: 'locals',
              startLine: lineNum,
              braceDepth,
              meta: { hclKind: 'locals' },
            });
          }
          byteOffset += line.length + 1;
          continue;
        }

        // provider "name" {
        const providerMatch = trimmed.match(/^provider\s+"([^"]+)"\s*\{?\s*$/);
        if (providerMatch) {
          addSymbol(providerMatch[1], 'variable', lineNum, lineOffset, { hclKind: 'provider' });
          if (trimmed.includes('{')) {
            braceDepth++;
            blockStack.push({
              kind: 'provider',
              name: providerMatch[1],
              startLine: lineNum,
              braceDepth,
              meta: { hclKind: 'provider' },
            });
          }
          byteOffset += line.length + 1;
          continue;
        }

        // terraform {
        const terraformMatch = trimmed.match(/^terraform\s*\{?\s*$/);
        if (terraformMatch) {
          if (trimmed.includes('{')) {
            braceDepth++;
            blockStack.push({
              kind: 'terraform',
              name: 'terraform',
              startLine: lineNum,
              braceDepth,
              meta: { hclKind: 'terraform' },
            });
          }
          byteOffset += line.length + 1;
          continue;
        }

        // moved {
        const movedMatch = trimmed.match(/^moved\s*\{?\s*$/);
        if (movedMatch) {
          if (trimmed.includes('{')) {
            braceDepth++;
            blockStack.push({
              kind: 'moved',
              name: 'moved',
              startLine: lineNum,
              braceDepth,
              meta: { hclKind: 'moved' },
            });
          }
          byteOffset += line.length + 1;
          continue;
        }
      }

      // Track brace depth changes and handle content inside blocks
      const block = currentBlock();

      // Count braces on this line (outside of strings, simplified)
      let lineDepthChange = 0;
      let inString = false;
      let stringChar = '';
      for (let c = 0; c < line.length; c++) {
        const ch = line[c];
        if (inString) {
          if (ch === '\\') {
            c++;
            continue;
          }
          if (ch === stringChar) inString = false;
        } else {
          if (ch === '"') {
            inString = true;
            stringChar = '"';
          } else if (ch === '{') lineDepthChange++;
          else if (ch === '}') lineDepthChange--;
        }
      }

      // Before updating brace depth, extract content from inside blocks
      if (block) {
        const depthInsideBlock = braceDepth - block.braceDepth;

        // locals block: extract key = at depth 0 inside the block (i.e. braceDepth === block.braceDepth)
        if (block.kind === 'locals' && depthInsideBlock === 0) {
          const localKv = trimmed.match(/^(\w+)\s*=/);
          if (localKv) {
            addSymbol(localKv[1], 'variable', lineNum, lineOffset, { hclKind: 'local' });
          }
        }

        // module block: extract source = "..."
        if (block.kind === 'module' && depthInsideBlock === 0) {
          const sourceMatch = trimmed.match(/^source\s*=\s*"([^"]+)"/);
          if (sourceMatch) {
            addEdge(sourceMatch[1]);
          }
        }

        // variable block: extract type, default, description into meta
        if (block.kind === 'variable' && depthInsideBlock === 0) {
          const typeMatch = trimmed.match(/^type\s*=\s*(.*)/);
          if (typeMatch) {
            // Update existing symbol metadata
            const sym = symbols.find(
              (s) => s.name === block.name && s.metadata?.hclKind === 'variable',
            );
            if (sym) {
              sym.metadata = { ...sym.metadata, type: typeMatch[1].trim() };
            }
          }
          const defaultMatch = trimmed.match(/^default\s*=\s*(.*)/);
          if (defaultMatch) {
            const sym = symbols.find(
              (s) => s.name === block.name && s.metadata?.hclKind === 'variable',
            );
            if (sym) {
              sym.metadata = { ...sym.metadata, default: defaultMatch[1].trim() };
            }
          }
          const descMatch = trimmed.match(/^description\s*=\s*"([^"]*)"/);
          if (descMatch) {
            const sym = symbols.find(
              (s) => s.name === block.name && s.metadata?.hclKind === 'variable',
            );
            if (sym) {
              sym.metadata = { ...sym.metadata, description: descMatch[1] };
            }
          }
        }

        // output block: extract value expression reference
        if (block.kind === 'output' && depthInsideBlock === 0) {
          const valueMatch = trimmed.match(/^value\s*=\s*(.*)/);
          if (valueMatch) {
            const sym = symbols.find(
              (s) => s.name === block.name && s.metadata?.hclKind === 'output',
            );
            if (sym) {
              sym.metadata = { ...sym.metadata, value: valueMatch[1].trim() };
            }
          }
        }

        // terraform block: required_providers
        if (block.kind === 'terraform') {
          if (trimmed.match(/^required_providers\s*\{/)) {
            insideRequiredProviders = true;
            requiredProvidersDepth = braceDepth + 1;
          }
          if (insideRequiredProviders && depthInsideBlock === 1) {
            // Inside required_providers at one level deep — extract provider name = { ... }
            const provReqMatch = trimmed.match(/^(\w+)\s*=\s*\{/);
            if (provReqMatch) {
              addSymbol(provReqMatch[1], 'constant', lineNum, lineOffset, {
                hclKind: 'required_provider',
              });
            }
          }
        }

        // moved block: extract from and to
        if (block.kind === 'moved' && depthInsideBlock === 0) {
          const fromMatch = trimmed.match(/^from\s*=\s*(.*)/);
          const toMatch = trimmed.match(/^to\s*=\s*(.*)/);
          if (fromMatch) {
            const name = `moved:${fromMatch[1].trim()}`;
            addSymbol(name, 'constant', lineNum, lineOffset, {
              hclKind: 'moved',
              from: fromMatch[1].trim(),
            });
          }
          if (toMatch) {
            // Update the moved symbol with to info
            const movedSym = symbols.find(
              (s) => s.metadata?.hclKind === 'moved' && s.lineStart === lineNum - 1,
            );
            if (movedSym) {
              movedSym.metadata = { ...movedSym.metadata, to: toMatch[1].trim() };
            }
          }
        }
      }

      // Update braceDepth
      braceDepth += lineDepthChange;

      // Pop blocks if their brace depth closed
      while (blockStack.length > 0 && braceDepth < blockStack[blockStack.length - 1].braceDepth) {
        const popped = blockStack.pop()!;
        if (popped.kind === 'terraform') {
          insideRequiredProviders = false;
        }
      }

      byteOffset += line.length + 1;
    }

    return ok({
      language: 'hcl',
      status: 'ok',
      symbols,
      edges: edges.length > 0 ? edges : undefined,
    });
  }
}
