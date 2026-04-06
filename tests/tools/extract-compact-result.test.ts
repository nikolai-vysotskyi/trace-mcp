import { describe, it, expect } from 'vitest';

// extractCompactResult is a module-level function in server.ts — not exported.
// We test it indirectly via the integration test, but also test the logic here
// by duplicating the extraction logic (it's a pure function).

function extractCompactResult(
  toolName: string,
  response: { content: Array<{ type: string; text: string }>; isError?: boolean },
): Record<string, unknown> | undefined {
  const DEDUP_TOOLS = new Set([
    'get_symbol', 'get_outline', 'get_context_bundle', 'get_call_graph',
  ]);
  if (!DEDUP_TOOLS.has(toolName)) return undefined;
  if (response?.isError) return undefined;

  try {
    const text = response?.content?.[0]?.text;
    if (!text) return undefined;
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return undefined;

    switch (toolName) {
      case 'get_symbol':
        return {
          symbol_id: parsed.symbol_id,
          name: parsed.name,
          kind: parsed.kind,
          fqn: parsed.fqn,
          signature: parsed.signature,
          file: parsed.file,
          line_start: parsed.line_start,
          line_end: parsed.line_end,
          _result_count: 1,
        };

      case 'get_outline':
        return {
          path: parsed.path,
          language: parsed.language,
          symbols: Array.isArray(parsed.symbols)
            ? parsed.symbols.map((s: Record<string, unknown>) => ({
              symbolId: s.symbolId, name: s.name, kind: s.kind,
              signature: s.signature, lineStart: s.lineStart, lineEnd: s.lineEnd,
            }))
            : [],
          _result_count: Array.isArray(parsed.symbols) ? parsed.symbols.length : 1,
        };

      default:
        return { _result_count: 1, _tool: toolName, _note: 'Previously returned this session' };
    }
  } catch {
    return undefined;
  }
}

describe('extractCompactResult', () => {
  it('extracts compact result for get_symbol', () => {
    const response = {
      content: [{
        type: 'text',
        text: JSON.stringify({
          symbol_id: 'src/a.ts::Foo#class',
          name: 'Foo',
          kind: 'class',
          fqn: 'Foo',
          signature: 'export class Foo',
          file: 'src/a.ts',
          line_start: 10,
          line_end: 50,
          source: 'export class Foo {\n  // lots of code...\n}',
        }),
      }],
    };
    const compact = extractCompactResult('get_symbol', response);
    expect(compact).toBeDefined();
    expect(compact!.symbol_id).toBe('src/a.ts::Foo#class');
    expect(compact!.name).toBe('Foo');
    expect(compact).not.toHaveProperty('source'); // source stripped
    expect(compact!._result_count).toBe(1);
  });

  it('extracts compact result for get_outline', () => {
    const response = {
      content: [{
        type: 'text',
        text: JSON.stringify({
          path: 'src/server.ts',
          language: 'typescript',
          symbols: [
            { symbolId: 's1', name: 'foo', kind: 'function', signature: 'function foo()', lineStart: 1, lineEnd: 10, source: 'function foo() {}' },
            { symbolId: 's2', name: 'bar', kind: 'function', signature: 'function bar()', lineStart: 12, lineEnd: 20, source: 'function bar() {}' },
          ],
        }),
      }],
    };
    const compact = extractCompactResult('get_outline', response);
    expect(compact).toBeDefined();
    expect(compact!.path).toBe('src/server.ts');
    expect((compact!.symbols as unknown[]).length).toBe(2);
    // Verify source is NOT in compact symbols
    expect((compact!.symbols as Record<string, unknown>[])[0]).not.toHaveProperty('source');
    expect(compact!._result_count).toBe(2);
  });

  it('returns undefined for non-dedup tools', () => {
    const response = {
      content: [{ type: 'text', text: JSON.stringify({ items: [1, 2, 3] }) }],
    };
    expect(extractCompactResult('search', response)).toBeUndefined();
    expect(extractCompactResult('find_usages', response)).toBeUndefined();
  });

  it('returns undefined for error responses', () => {
    const response = {
      content: [{ type: 'text', text: '{"error":"not found"}' }],
      isError: true,
    };
    expect(extractCompactResult('get_symbol', response)).toBeUndefined();
  });
});
