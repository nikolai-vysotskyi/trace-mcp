/**
 * Objective-C Language Plugin — regex-based symbol extraction.
 *
 * Extracts: @interface, @implementation, @protocol, methods (full selector),
 * @property, C functions, #define, typedef, NS_ENUM.
 */
import { ok } from 'neverthrow';
import type { LanguagePlugin, PluginManifest, FileParseResult, RawSymbol, RawEdge } from '../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../errors.js';
import { lineAt, makeSymbolId, extractSignature } from '../regex-base.js';

export class ObjCLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'objc-language',
    version: '1.0.0',
    priority: 6,
  };

  supportedExtensions = ['.m', '.mm'];

  extractSymbols(filePath: string, content: Buffer): TraceMcpResult<FileParseResult> {
    const source = content.toString('utf-8');
    const symbols: RawSymbol[] = [];
    const edges: RawEdge[] = [];
    const seen = new Set<string>();

    const add = (name: string, kind: RawSymbol['kind'], idx: number, text: string, meta?: Record<string, unknown>) => {
      const sid = makeSymbolId(filePath, name, kind);
      if (seen.has(sid)) return;
      seen.add(sid);
      symbols.push({
        symbolId: sid, name, kind, fqn: name,
        signature: extractSignature(text),
        byteStart: idx, byteEnd: idx + text.length,
        lineStart: lineAt(source, idx), lineEnd: lineAt(source, idx + text.length),
        metadata: meta,
      });
    };

    // @interface, @implementation, @protocol
    for (const m of source.matchAll(/^[ \t]*@interface\s+(\w+)/gm)) add(m[1], 'class', m.index, m[0], { objcKind: 'interface' });
    for (const m of source.matchAll(/^[ \t]*@implementation\s+(\w+)/gm)) add(m[1], 'class', m.index, m[0], { objcKind: 'implementation' });
    for (const m of source.matchAll(/^[ \t]*@protocol\s+(\w+)/gm)) add(m[1], 'interface', m.index, m[0], { objcKind: 'protocol' });

    // Instance methods: - (type)selector:(type)param selector2:(type)param2 ...
    // Capture FULL selector by joining all selector parts
    const methodRe = /^[ \t]*([+-])\s*\([^)]+\)\s*(.+?)[\s{;]/gm;
    for (const m of source.matchAll(methodRe)) {
      const prefix = m[1];
      const selectorLine = m[2].trim();
      // Build full selector: extract all "word:" or just the single word
      const parts = selectorLine.match(/\w+(?=\s*:)|^\w+$/gm);
      if (!parts) continue;
      const selector = parts.length === 1 && !selectorLine.includes(':')
        ? parts[0]
        : parts.map(p => p + ':').join('');
      const isStatic = prefix === '+';
      add(selector, 'method', m.index, m[0], { static: isStatic });
    }

    // @property
    for (const m of source.matchAll(/^[ \t]*@property\s*(?:\([^)]*\)\s*)?[\w<>*\s]+\b(\w+)\s*;/gm)) {
      add(m[1], 'property', m.index, m[0]);
    }

    // C functions
    for (const m of source.matchAll(/^[ \t]*(?:(?:static|inline|extern|NS_INLINE|CF_INLINE)\s+)*(?:[\w*]+\s+)+(\w+)\s*\([^;]*\)\s*\{/gm)) {
      add(m[1], 'function', m.index, m[0]);
    }

    // #define
    for (const m of source.matchAll(/^[ \t]*#\s*define\s+(\w+)/gm)) add(m[1], 'constant', m.index, m[0]);

    // typedef
    for (const m of source.matchAll(/^[ \t]*typedef\s+[^;]+?\b(\w+)\s*;/gm)) add(m[1], 'type', m.index, m[0]);

    // NS_ENUM / NS_OPTIONS
    for (const m of source.matchAll(/^[ \t]*typedef\s+(?:NS_ENUM|NS_OPTIONS|NS_CLOSED_ENUM)\s*\([^,]+,\s*(\w+)\s*\)/gm)) {
      add(m[1], 'enum', m.index, m[0]);
    }

    // Import edges
    for (const m of source.matchAll(/^[ \t]*#\s*import\s+["<]([^">]+)[">]/gm)) edges.push({ edgeType: 'imports', metadata: { module: m[1] } });
    for (const m of source.matchAll(/^[ \t]*@import\s+([\w.]+)\s*;/gm)) edges.push({ edgeType: 'imports', metadata: { module: m[1] } });
    for (const m of source.matchAll(/^[ \t]*#\s*include\s+["<]([^">]+)[">]/gm)) edges.push({ edgeType: 'imports', metadata: { module: m[1] } });

    return ok({
      language: 'objc',
      status: 'ok',
      symbols,
      edges: edges.length > 0 ? edges : undefined,
    });
  }
}
