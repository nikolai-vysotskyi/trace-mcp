/**
 * GraphQLPlugin — indexes GraphQL schemas and resolvers.
 *
 * Language plugin: handles .graphql / .gql files.
 * Framework plugin: extracts resolver wiring from TypeScript resolver files.
 *
 * Extracts:
 * - SDL type/input/interface/union/enum definitions → symbols (kind='type')
 * - SDL fields with arguments → symbols (kind='method')
 * - Resolver objects (const resolvers = { Query: { ... } }) → edges (graphql_resolves)
 * - TypeDefs string literals inside .ts files (gql`...` template literals)
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok } from 'neverthrow';
import type {
  FrameworkPlugin,
  LanguagePlugin,
  PluginManifest,
  ProjectContext,
  FileParseResult,
  RawSymbol,
  RawEdge,
  ResolveContext,
} from '../../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../../errors.js';

// ── Language plugin: .graphql / .gql files ────────────────────────────────

export class GraphQLLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'graphql-language',
    version: '1.0.0',
    priority: 5,
    dependencies: [],
  };

  supportedExtensions = ['.graphql', '.gql'];

  extractSymbols(filePath: string, content: Buffer): TraceMcpResult<FileParseResult> {
    const source = content.toString('utf-8');
    const symbols = extractSchemaSymbols(source, filePath);
    return ok({ status: 'ok', symbols, language: 'graphql' });
  }
}

// ── Framework plugin: wires resolvers in TypeScript/JS files ─────────────

export class GraphQLPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'graphql',
    version: '1.0.0',
    priority: 40,
    category: 'api',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    const deps = {
      ...(ctx.packageJson?.dependencies as Record<string, string> | undefined),
      ...(ctx.packageJson?.devDependencies as Record<string, string> | undefined),
    };
    const gqlDeps = [
      'graphql',
      'apollo-server',
      '@apollo/server',
      'type-graphql',
      'nexus',
      'pothos',
      '@pothos/core',
      'mercurius',
      'graphql-yoga',
    ];
    if (gqlDeps.some((d) => d in deps)) return true;

    // Also check for any .graphql file in the project root
    try {
      return fs.readdirSync(ctx.rootPath).some((f) => f.endsWith('.graphql') || f.endsWith('.gql'));
    } catch {
      return false;
    }
  }

  registerSchema() {
    return {
      edgeTypes: [
        {
          name: 'graphql_resolves',
          category: 'graphql',
          description: 'Resolver function implements a GraphQL field',
        },
        {
          name: 'graphql_references_type',
          category: 'graphql',
          description: 'Field/resolver references a GraphQL type',
        },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (language !== 'typescript' && language !== 'javascript') {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');

    // Extract embedded SDL from gql`` template literals and typeDefs strings
    const sdlSymbols = extractEmbeddedSdl(source, filePath);

    // Extract resolver object patterns and produce metadata symbols
    const resolverInfo = extractResolverObjects(source, filePath);

    return ok({
      status: 'ok',
      symbols: [...sdlSymbols, ...resolverInfo.symbols],
      edges: resolverInfo.edges.length > 0 ? resolverInfo.edges : undefined,
      frameworkRole:
        sdlSymbols.length > 0 || resolverInfo.symbols.length > 0 ? 'graphql_resolver' : undefined,
    });
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}

// ── SDL symbol extraction ──────────────────────────────────────────────────

function extractSchemaSymbols(source: string, filePath: string): RawSymbol[] {
  const symbols: RawSymbol[] = [];
  const lines = source.split('\n');
  const byteOffsets = buildByteOffsets(lines);

  // Strip block comments
  const stripped = source.replace(/"""[\s\S]*?"""/g, '""" """');

  const blockRegex = /\b(type|input|interface|union|enum|scalar|directive)\s+(\w+)[^{]*\{?/g;
  let match: RegExpExecArray | null;

  while ((match = blockRegex.exec(stripped)) !== null) {
    const keyword = match[1];
    const name = match[2];

    // Skip built-in types
    if (['String', 'Int', 'Float', 'Boolean', 'ID'].includes(name)) continue;

    const lineIdx = source.slice(0, match.index).split('\n').length - 1;
    const byteStart = byteOffsets[lineIdx] ?? match.index;

    // Find closing brace for the block
    let braceDepth = 0;
    let endPos = match.index;
    for (let j = match.index; j < source.length; j++) {
      if (source[j] === '{') braceDepth++;
      else if (source[j] === '}') {
        braceDepth--;
        if (braceDepth === 0) {
          endPos = j + 1;
          break;
        }
      }
    }

    const blockContent = source.slice(match.index, endPos);
    const endLineIdx = source.slice(0, endPos).split('\n').length - 1;
    const byteEnd = byteOffsets[endLineIdx] + (lines[endLineIdx]?.length ?? 0);

    symbols.push({
      symbolId: `${filePath}::${name}#type`,
      name,
      kind: 'type',
      fqn: name,
      signature: `${keyword} ${name}`,
      byteStart,
      byteEnd,
      lineStart: lineIdx + 1,
      lineEnd: endLineIdx + 1,
    });

    // Extract fields from type/input/interface blocks
    if (
      (keyword === 'type' || keyword === 'input' || keyword === 'interface') &&
      blockContent.includes('{')
    ) {
      const bodyMatch = blockContent.match(/\{([\s\S]*)\}/);
      if (bodyMatch) {
        const fieldRegex = /^\s*(\w+)\s*(?:\([^)]*\))?\s*:\s*([\w!\[\]]+)/gm;
        let fieldMatch: RegExpExecArray | null;
        while ((fieldMatch = fieldRegex.exec(bodyMatch[1])) !== null) {
          const fieldName = fieldMatch[1];
          if (['__typename', ''].includes(fieldName)) continue;
          const bodyMatchIndex = bodyMatch.index ?? 0;
          const fieldLineOffset =
            blockContent.slice(0, bodyMatchIndex + fieldMatch.index).split('\n').length - 1;
          symbols.push({
            symbolId: `${filePath}::${name}::${fieldName}#method`,
            name: fieldName,
            kind: 'method',
            fqn: `${name}.${fieldName}`,
            parentSymbolId: `${filePath}::${name}#type`,
            signature: `${fieldName}: ${fieldMatch[2]}`,
            byteStart: byteStart + fieldMatch.index,
            byteEnd: byteStart + fieldMatch.index + fieldMatch[0].length,
            lineStart: lineIdx + fieldLineOffset + 1,
            lineEnd: lineIdx + fieldLineOffset + 1,
          });
        }
      }
    }
  }

  return symbols;
}

// ── Embedded SDL extraction ────────────────────────────────────────────────

function extractEmbeddedSdl(source: string, filePath: string): RawSymbol[] {
  const symbols: RawSymbol[] = [];

  // Match gql`...` or graphql`...` template literals
  const gqlRegex = /(?:gql|graphql)\s*`([\s\S]*?)`/g;
  let match: RegExpExecArray | null;
  while ((match = gqlRegex.exec(source)) !== null) {
    const sdl = match[1];
    const embedded = extractSchemaSymbols(sdl, `${filePath}@embedded`);
    symbols.push(...embedded);
  }

  return symbols;
}

// ── Resolver object extraction ─────────────────────────────────────────────

interface ResolverResult {
  symbols: RawSymbol[];
  edges: RawEdge[];
}

function extractResolverObjects(source: string, filePath: string): ResolverResult {
  const symbols: RawSymbol[] = [];
  const edges: RawEdge[] = [];

  // Match: const resolvers = { Query: { fieldName: ... }, Mutation: { ... }, TypeName: { ... } }
  // or: export const resolvers: Resolvers = { ... }
  const resolverVarRegex = /(?:const|export\s+const)\s+resolvers\s*(?::[^=]+)?\s*=\s*\{/;
  const match = resolverVarRegex.exec(source);
  if (!match) return { symbols, edges };

  // Extract type keys (Query, Mutation, Subscription, TypeName)
  const typeKeyRegex = /\b(Query|Mutation|Subscription|[\w]+)\s*:\s*\{/g;
  let typeMatch: RegExpExecArray | null;
  while ((typeMatch = typeKeyRegex.exec(source.slice(match.index))) !== null) {
    const typeName = typeMatch[1];

    // Extract field resolvers within this type block
    // Find the opening brace position
    const typeStart = match.index + typeMatch.index + typeMatch[0].length;
    let depth = 1;
    let pos = typeStart;
    const typeBody: string[] = [];

    while (pos < source.length && depth > 0) {
      if (source[pos] === '{') depth++;
      else if (source[pos] === '}') depth--;
      if (depth > 0) typeBody.push(source[pos]);
      pos++;
    }

    // Extract resolver field names
    const fieldRegex = /\b(\w+)\s*(?::\s*(?:async\s+)?(?:function\s*\w*|\([^)]*\)\s*=>|\w+\s*=>))/g;
    let fieldMatch: RegExpExecArray | null;
    const body = typeBody.join('');
    while ((fieldMatch = fieldRegex.exec(body)) !== null) {
      const fieldName = fieldMatch[1];
      const lineIdx =
        source.slice(0, match.index + typeMatch.index + fieldMatch.index).split('\n').length - 1;

      symbols.push({
        symbolId: `${filePath}::${typeName}::${fieldName}#function`,
        name: fieldName,
        kind: 'function',
        fqn: `${typeName}.${fieldName}`,
        signature: `${typeName}.${fieldName}(parent, args, ctx)`,
        byteStart: match.index + typeMatch.index,
        byteEnd: match.index + typeMatch.index + fieldMatch[0].length,
        lineStart: lineIdx + 1,
        lineEnd: lineIdx + 1,
        metadata: { resolverType: typeName, resolverField: fieldName },
      });

      // Edge: resolver → graphql type field
      edges.push({
        sourceSymbolId: `${filePath}::${typeName}::${fieldName}#function`,
        edgeType: 'graphql_resolves',
        resolved: false,
        metadata: { typeName, fieldName },
      } as RawEdge);
    }
  }

  return { symbols, edges };
}

// ── Utility ────────────────────────────────────────────────────────────────

function buildByteOffsets(lines: string[]): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += Buffer.byteLength(line, 'utf-8') + 1;
  }
  return offsets;
}
