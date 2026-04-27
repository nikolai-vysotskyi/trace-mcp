/**
 * Erlang Language Plugin — regex-based symbol extraction.
 *
 * Extracts: modules (-module), exported functions, records, macros (-define),
 * type specs, callbacks, and import edges (-include, -include_lib).
 */
import { ok } from 'neverthrow';
import type { TraceMcpResult } from '../../../../errors.js';
import type {
  FileParseResult,
  LanguagePlugin,
  PluginManifest,
  RawEdge,
  RawSymbol,
} from '../../../../plugin-api/types.js';
import { lineAt, makeSymbolId } from '../regex-base.js';

export const ErlangLanguagePlugin = class implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'erlang-language',
    version: '1.0.0',
    priority: 6,
  };

  supportedExtensions = ['.erl', '.hrl'];
  supportedVersions = ['OTP-24', 'OTP-25', 'OTP-26', 'OTP-27'];

  extractSymbols(filePath: string, content: Buffer): TraceMcpResult<FileParseResult> {
    const source = content.toString('utf-8');
    const symbols: RawSymbol[] = [];
    const edges: RawEdge[] = [];
    const seen = new Set<string>();

    const add = (
      name: string,
      kind: RawSymbol['kind'],
      m: RegExpExecArray,
      meta?: Record<string, unknown>,
    ) => {
      const sid = makeSymbolId(filePath, name, kind);
      if (seen.has(sid)) return;
      seen.add(sid);
      symbols.push({
        symbolId: sid,
        name,
        kind,
        fqn: name,
        signature: m[0].split('\n')[0].trim().slice(0, 120),
        byteStart: m.index,
        byteEnd: m.index + m[0].length,
        lineStart: lineAt(source, m.index),
        lineEnd: lineAt(source, m.index + m[0].length),
        metadata: meta,
      });
    };

    // -module(name).
    for (const m of source.matchAll(/^-module\((\w+)\)/gm)) add(m[1], 'namespace', m);

    // -export([func/arity, ...]). — collect exported function names
    const exported = new Set<string>();
    for (const m of source.matchAll(/^-export\(\[([^\]]+)\]\)/gm)) {
      for (const entry of m[1].split(',')) {
        const fn = entry.trim().split('/')[0].trim();
        if (fn) exported.add(fn);
      }
    }

    // -record(name, {...}).
    for (const m of source.matchAll(/^-record\((\w+)\s*,/gm))
      add(m[1], 'class', m, { record: true });

    // -define(NAME, ...).
    for (const m of source.matchAll(/^-define\((\w+)/gm)) add(m[1], 'constant', m, { macro: true });

    // -type name() ::
    for (const m of source.matchAll(/^-type\s+(\w+)\s*\(/gm)) add(m[1], 'type', m);
    // -opaque name() ::
    for (const m of source.matchAll(/^-opaque\s+(\w+)\s*\(/gm))
      add(m[1], 'type', m, { opaque: true });

    // -spec name(...)
    for (const m of source.matchAll(/^-spec\s+(\w+)\s*\(/gm))
      add(m[1], 'function', m, { spec: true });
    // -callback name(...)
    for (const m of source.matchAll(/^-callback\s+(\w+)\s*\(/gm))
      add(m[1], 'function', m, { callback: true });

    // Top-level function clauses: name(... — must be lowercase atom at column 0 (no leading whitespace)
    // Only extract if name is exported OR if no -export found (header file)
    const hasExports = exported.size > 0;
    for (const m of source.matchAll(/^([a-z_]\w*)\s*\(/gm)) {
      const name = m[1];
      // Skip common false positives (Erlang keywords, directives we already captured)
      if (
        ['if', 'case', 'receive', 'try', 'catch', 'begin', 'when', 'end', 'of', 'after'].includes(
          name,
        )
      )
        continue;
      if (!hasExports || exported.has(name)) {
        add(name, 'function', m, hasExports && exported.has(name) ? { exported: true } : undefined);
      }
    }

    // Import edges
    for (const m of source.matchAll(/^-include\("([^"]+)"\)/gm)) {
      edges.push({ edgeType: 'imports', metadata: { module: m[1] } });
    }
    for (const m of source.matchAll(/^-include_lib\("([^"]+)"\)/gm)) {
      edges.push({ edgeType: 'imports', metadata: { module: m[1] } });
    }
    for (const m of source.matchAll(/^-import\((\w+)\s*,/gm)) {
      edges.push({ edgeType: 'imports', metadata: { module: m[1] } });
    }

    return ok({
      language: 'erlang',
      status: 'ok',
      symbols,
      edges: edges.length > 0 ? edges : undefined,
    });
  }
};
