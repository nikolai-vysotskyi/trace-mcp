import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexSessionProvider } from '../../../src/session/providers/codex.js';

function writeJsonl(file: string, lines: object[]): void {
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

describe('CodexSessionProvider', () => {
  let tmpHome: string;
  let provider: CodexSessionProvider;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-'));
    provider = new CodexSessionProvider();
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns [] when ~/.codex is missing', async () => {
    const handles = await provider.discover({ homeDir: tmpHome });
    expect(handles).toEqual([]);
  });

  it('returns [] when sessions/ is empty', async () => {
    fs.mkdirSync(path.join(tmpHome, '.codex', 'sessions'), { recursive: true });
    const handles = await provider.discover({ homeDir: tmpHome });
    expect(handles).toEqual([]);
  });

  it('discovers a flat sessions/<id>.jsonl file', async () => {
    const sessions = path.join(tmpHome, '.codex', 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    const file = path.join(sessions, 'abc123.jsonl');
    writeJsonl(file, [
      { type: 'session.start', timestamp: '2026-05-09T10:00:00Z', cwd: '/repo/foo' },
      {
        type: 'message',
        timestamp: '2026-05-09T10:00:01Z',
        message: { role: 'user', content: 'hello' },
      },
    ]);

    const handles = await provider.discover({ homeDir: tmpHome });
    expect(handles).toHaveLength(1);
    expect(handles[0].providerId).toBe('codex');
    expect(handles[0].sessionId).toBe('abc123');
    expect(handles[0].sourcePath).toBe(file);
    expect(handles[0].projectPath).toBe('/repo/foo');
  });

  it('discovers shard-nested sessions (~/.codex/sessions/2026/05/<id>.jsonl)', async () => {
    const dir = path.join(tmpHome, '.codex', 'sessions', '2026', '05');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'shard-x.jsonl');
    writeJsonl(file, [{ type: 'message', message: { role: 'user', content: 'shard' } }]);

    const handles = await provider.discover({ homeDir: tmpHome });
    expect(handles).toHaveLength(1);
    expect(handles[0].sessionId).toBe('shard-x');
  });

  it('filters by projectRoot when provided (and keeps sessions with no cwd)', async () => {
    const sessions = path.join(tmpHome, '.codex', 'sessions');
    fs.mkdirSync(sessions, { recursive: true });

    writeJsonl(path.join(sessions, 'in-project.jsonl'), [
      { type: 'session.start', cwd: '/repo/foo' },
    ]);
    writeJsonl(path.join(sessions, 'other-project.jsonl'), [
      { type: 'session.start', cwd: '/repo/bar' },
    ]);
    writeJsonl(path.join(sessions, 'no-cwd.jsonl'), [
      { type: 'message', message: { role: 'user', content: 'no-cwd here' } },
    ]);

    const handles = await provider.discover({ homeDir: tmpHome, projectRoot: '/repo/foo' });
    const ids = handles.map((h) => h.sessionId).sort();
    expect(ids).toEqual(['in-project', 'no-cwd']);
  });

  it('honours $CODEX_HOME override', async () => {
    const customHome = path.join(tmpHome, 'custom');
    fs.mkdirSync(path.join(customHome, 'sessions'), { recursive: true });
    writeJsonl(path.join(customHome, 'sessions', 's.jsonl'), [
      { type: 'message', message: { role: 'user', content: 'x' } },
    ]);

    const original = process.env.CODEX_HOME;
    process.env.CODEX_HOME = customHome;
    try {
      const handles = await provider.discover({ homeDir: tmpHome });
      expect(handles.map((h) => h.sessionId)).toEqual(['s']);
    } finally {
      if (original === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = original;
    }
  });

  it('honours configOverrides.home_override', async () => {
    const customHome = path.join(tmpHome, 'custom');
    fs.mkdirSync(path.join(customHome, 'sessions'), { recursive: true });
    writeJsonl(path.join(customHome, 'sessions', 'over.jsonl'), [
      { type: 'message', message: { role: 'user', content: 'x' } },
    ]);

    const handles = await provider.discover({
      homeDir: tmpHome,
      configOverrides: { homeOverride: customHome },
    });
    expect(handles.map((h) => h.sessionId)).toEqual(['over']);
  });

  it('streams text content', async () => {
    const sessions = path.join(tmpHome, '.codex', 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    const file = path.join(sessions, 's.jsonl');
    writeJsonl(file, [
      { type: 'message', message: { role: 'user', content: 'plain text' } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'block 1' },
            { type: 'text', text: 'block 2' },
          ],
        },
      },
      { type: 'session.end' }, // no message
    ]);

    const [handle] = await provider.discover({ homeDir: tmpHome });
    const messages: Array<{ role: string; text: string }> = [];
    for await (const msg of provider.streamMessages(handle)) {
      messages.push({ role: msg.role, text: msg.text });
    }
    expect(messages).toEqual([
      { role: 'user', text: 'plain text' },
      { role: 'assistant', text: 'block 1\nblock 2' },
    ]);
  });

  it('extracts tool_call / tool_result blocks', async () => {
    const sessions = path.join(tmpHome, '.codex', 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    const file = path.join(sessions, 's.jsonl');
    writeJsonl(file, [
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'calling tool' },
            { type: 'tool_call', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      },
      {
        type: 'message',
        message: {
          role: 'tool',
          content: [{ type: 'tool_result', output: 'README.md' }],
        },
      },
    ]);

    const [handle] = await provider.discover({ homeDir: tmpHome });
    const messages: Array<RawMessageLike> = [];
    for await (const msg of provider.streamMessages(handle)) {
      messages.push({
        role: msg.role,
        text: msg.text,
        toolName: msg.toolName,
        toolResult: msg.toolResult,
      });
    }

    expect(messages[0]).toMatchObject({
      role: 'assistant',
      text: 'calling tool',
      toolName: 'Bash',
    });
    expect(messages[1]).toMatchObject({
      role: 'tool',
      toolResult: 'README.md',
    });
  });

  it('parse() returns a minimal ParsedSession with timestamps and tool count', async () => {
    const sessions = path.join(tmpHome, '.codex', 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    const file = path.join(sessions, 's.jsonl');
    writeJsonl(file, [
      {
        type: 'message',
        timestamp: '2026-05-09T10:00:00Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_call', name: 'Bash' }],
        },
      },
      {
        type: 'message',
        timestamp: '2026-05-09T10:00:05Z',
        message: { role: 'user', content: 'thanks' },
      },
    ]);

    const [handle] = await provider.discover({ homeDir: tmpHome });
    const parsed = await provider.parse(handle);
    expect(parsed).not.toBeNull();
    expect(parsed!.summary.toolCallCount).toBe(1);
    expect(parsed!.summary.startedAt).toBe('2026-05-09T10:00:00.000Z');
    expect(parsed!.summary.endedAt).toBe('2026-05-09T10:00:05.000Z');
  });

  it('tolerates a single corrupt JSONL line without dropping the file', async () => {
    const sessions = path.join(tmpHome, '.codex', 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    const file = path.join(sessions, 's.jsonl');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: 'message', message: { role: 'user', content: 'good' } }),
        '{not valid json',
        JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'after' } }),
      ].join('\n'),
    );

    const [handle] = await provider.discover({ homeDir: tmpHome });
    const messages: Array<{ role: string; text: string }> = [];
    for await (const msg of provider.streamMessages(handle)) {
      messages.push({ role: msg.role, text: msg.text });
    }
    expect(messages.map((m) => m.text)).toEqual(['good', 'after']);
  });
});

interface RawMessageLike {
  role: string;
  text: string;
  toolName?: string;
  toolResult?: unknown;
}
