import { describe, it, expect } from 'vitest';
import { parseToolName, extractTargetFile, parseSessionFile } from '../../src/analytics/log-parser.js';
import fs from 'node:fs';
import path from 'node:path';
import { createTmpDir, removeTmpDir } from '../test-utils.js';

describe('parseToolName', () => {
  it('parses builtin tool', () => {
    expect(parseToolName('Read')).toEqual({ server: 'builtin', shortName: 'Read' });
  });

  it('parses MCP tool', () => {
    expect(parseToolName('mcp__jcodemunch__search_symbols')).toEqual({ server: 'jcodemunch', shortName: 'search_symbols' });
  });

  it('parses MCP tool with dashes in server name', () => {
    expect(parseToolName('mcp__trace-mcp__get_outline')).toEqual({ server: 'trace-mcp', shortName: 'get_outline' });
  });
});

describe('extractTargetFile', () => {
  it('extracts file_path', () => {
    expect(extractTargetFile('Read', { file_path: '/src/foo.ts' })).toBe('/src/foo.ts');
  });

  it('extracts path param', () => {
    expect(extractTargetFile('Glob', { path: 'src/', pattern: '*.ts' })).toBe('src/');
  });

  it('extracts from Bash cat command', () => {
    expect(extractTargetFile('Bash', { command: 'cat src/main.ts | head -10' })).toBe('src/main.ts');
  });

  it('returns undefined for non-file tools', () => {
    expect(extractTargetFile('TodoWrite', { todos: [] })).toBeUndefined();
  });
});

describe('parseSessionFile', () => {
  it('parses a JSONL session file', () => {
    const tmpDir = createTmpDir('log-parser-test-');
    const filePath = path.join(tmpDir, 'test-session.jsonl');

    const lines = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        timestamp: '2026-04-01T10:00:00Z',
        sessionId: 'test-123',
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200, cache_creation_input_tokens: 30 },
          content: [
            { type: 'tool_use', id: 'tool_1', name: 'Read', input: { file_path: 'src/main.ts' } },
          ],
        },
        timestamp: '2026-04-01T10:00:05Z',
        sessionId: 'test-123',
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool_1', content: 'const x = 1;\nconst y = 2;', is_error: false },
          ],
        },
        timestamp: '2026-04-01T10:00:06Z',
        sessionId: 'test-123',
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 150, output_tokens: 80, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 },
          content: [
            { type: 'text', text: 'Here is the code.' },
          ],
        },
        timestamp: '2026-04-01T10:00:10Z',
        sessionId: 'test-123',
      }),
    ];

    fs.writeFileSync(filePath, lines.join('\n'));

    const result = parseSessionFile(filePath, '/test/project');
    expect(result).not.toBeNull();
    expect(result!.summary.model).toBe('claude-sonnet-4-6');
    expect(result!.summary.usage.inputTokens).toBe(250); // 100 + 150
    expect(result!.summary.usage.outputTokens).toBe(130); // 50 + 80
    expect(result!.summary.usage.cacheReadTokens).toBe(500); // 200 + 300
    expect(result!.summary.toolCallCount).toBe(1);

    expect(result!.toolCalls).toHaveLength(1);
    expect(result!.toolCalls[0].toolName).toBe('Read');
    expect(result!.toolCalls[0].toolServer).toBe('builtin');
    expect(result!.toolCalls[0].targetFile).toBe('src/main.ts');

    expect(result!.toolResults.get('tool_1')).toBeDefined();
    expect(result!.toolResults.get('tool_1')!.outputSizeChars).toBe(25);
    expect(result!.toolResults.get('tool_1')!.isError).toBe(false);

    removeTmpDir(tmpDir);
  });

  it('parses Claw Code JSONL format', () => {
    const tmpDir = createTmpDir('log-parser-claw-');
    const filePath = path.join(tmpDir, 'claw-session.jsonl');

    // Claw Code uses {type: "message", message: {role, content, usage}}
    // and tool_use input is a JSON string, not an object
    const lines = [
      JSON.stringify({
        type: 'session_meta',
        session_id: 'claw-1',
        version: 1,
        created_at_ms: 1712000000000,
        updated_at_ms: 1712000060000,
      }),
      JSON.stringify({
        type: 'message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'read main.ts' }],
        },
      }),
      JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'Read', input: '{"file_path":"src/main.ts"}' },
          ],
          usage: { input_tokens: 200, output_tokens: 30, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 },
        },
      }),
      JSON.stringify({
        type: 'message',
        message: {
          role: 'tool',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', tool_name: 'Read', output: 'export const x = 42;', is_error: false },
          ],
        },
      }),
    ];

    fs.writeFileSync(filePath, lines.join('\n'));

    const result = parseSessionFile(filePath, '/test/claw-project');
    expect(result).not.toBeNull();
    expect(result!.summary.usage.inputTokens).toBe(200);
    expect(result!.summary.usage.outputTokens).toBe(30);
    expect(result!.summary.usage.cacheReadTokens).toBe(100);
    expect(result!.summary.toolCallCount).toBe(1);

    expect(result!.toolCalls).toHaveLength(1);
    expect(result!.toolCalls[0].toolName).toBe('Read');
    expect(result!.toolCalls[0].targetFile).toBe('src/main.ts');
    // Input was a JSON string — should be parsed into object
    expect(result!.toolCalls[0].inputParams).toEqual({ file_path: 'src/main.ts' });

    expect(result!.toolResults.get('tu_1')).toBeDefined();
    expect(result!.toolResults.get('tu_1')!.outputSizeChars).toBe(20); // "export const x = 42;"
    expect(result!.toolResults.get('tu_1')!.isError).toBe(false);

    removeTmpDir(tmpDir);
  });

  it('returns null for empty session', () => {
    const tmpDir = createTmpDir('log-parser-test-');
    const filePath = path.join(tmpDir, 'empty.jsonl');
    fs.writeFileSync(filePath, JSON.stringify({ type: 'queue-operation', timestamp: '2026-04-01T10:00:00Z', sessionId: 'empty' }));
    const result = parseSessionFile(filePath, '/test/project');
    expect(result).toBeNull();
    removeTmpDir(tmpDir);
  });
});
