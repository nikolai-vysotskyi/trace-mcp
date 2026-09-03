import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HOOK = path.resolve('hooks/trace-mcp-mirror.sh');

let home: string;

interface MirrorResult {
  rewritten: boolean;
  output?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  response?: any;
}

/** The exact tool_response envelopes Claude Code sends for each tool. */
function bashResponse(stdout: string) {
  return { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false };
}

function readResponse(content: string) {
  return {
    type: 'text',
    file: {
      filePath: '/tmp/fixture.log',
      content,
      numLines: content.split('\n').length,
      startLine: 1,
      totalLines: content.split('\n').length,
    },
  };
}

function runMirror(
  toolName: string,
  toolResponse: unknown,
  env: Record<string, string> = {},
): MirrorResult {
  const result = spawnSync('bash', [HOOK], {
    input: JSON.stringify({
      tool_name: toolName,
      session_id: 'test-session',
      tool_response: toolResponse,
    }),
    env: { ...process.env, TRACE_MCP_MIRROR_HOME: home, ...env },
    encoding: 'utf-8',
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);

  const stdout = result.stdout.trim();
  if (stdout.length === 0) return { rewritten: false };
  const parsed = JSON.parse(stdout);
  expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUse');
  const response = parsed.hookSpecificOutput.updatedToolOutput;
  const text = toolName === 'Read' ? response.file.content : response.stdout;
  return { rewritten: true, output: text, response };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mirror-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('trace-mcp mirror hook', () => {
  it('passes small outputs through untouched', () => {
    expect(runMirror('Bash', bashResponse('tiny')).rewritten).toBe(false);
  });

  it('ignores tools it does not mirror', () => {
    expect(runMirror('Edit', bashResponse('x'.repeat(50_000))).rewritten).toBe(false);
  });

  it('collapses repeated lines and reports the saving', () => {
    const noisy = `${Array.from({ length: 400 }, () => 'copying asset').join('\n')}\ndone`;
    const { rewritten, output } = runMirror('Bash', bashResponse(noisy));

    expect(rewritten).toBe(true);
    expect(output).toContain('previous line repeated 399 more time(s)');
    expect(output).toContain('done');
    expect(output!.length).toBeLessThan(noisy.length);
    expect(output).toMatch(/\[trace-mcp mirror] Bash output compressed \d+ → \d+ chars \(−\d+%\)/);
  });

  it('spills the full output to a path named in the compressed view', () => {
    const noisy = `${Array.from({ length: 400 }, () => 'copying asset').join('\n')}\nUNIQUE_TAIL`;
    const { output } = runMirror('Bash', bashResponse(noisy));

    const spill = output!.match(/Full output: (\S+)/)![1];
    expect(fs.readFileSync(spill, 'utf-8')).toBe(noisy);
  });

  it('windows a long output but keeps both ends', () => {
    const long = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n');
    const { output } = runMirror('Bash', bashResponse(long));

    expect(output).toContain('line 0');
    expect(output).toContain('line 999');
    expect(output).toContain('line(s) elided by trace-mcp mirror');
    expect(output).not.toContain('line 500');
  });

  it('reads Read-shaped object responses', () => {
    const content = Array.from({ length: 400 }, () => 'const x = 1;').join('\n');
    const { rewritten, output } = runMirror('Read', readResponse(content));

    expect(rewritten).toBe(true);
    expect(output).toContain('[trace-mcp mirror] Read output compressed');
  });

  it('leaves output alone when compression would not shrink it', () => {
    // 400 distinct, noise-free lines within the window: nothing to collapse.
    const incompressible = Array.from({ length: 60 }, (_, i) => `x${i} ${'y'.repeat(60)}`).join(
      '\n',
    );
    expect(runMirror('Bash', bashResponse(incompressible)).rewritten).toBe(false);
  });

  it('records one measurement row per rewrite', () => {
    const noisy = Array.from({ length: 400 }, () => 'copying asset').join('\n');
    runMirror('Bash', bashResponse(noisy));
    runMirror('Read', readResponse(noisy));

    const rows = fs
      .readFileSync(path.join(home, 'metrics.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.tool)).toEqual(['Bash', 'Read']);
    for (const row of rows) {
      expect(row.new_chars).toBeLessThan(row.orig_chars);
      expect(fs.existsSync(row.spill)).toBe(true);
    }
  });

  // Source code is full of lines that package-manager noise patterns match.
  // Filtering a Read through them deletes code, silently.
  it('never applies noise filtering to a Read', () => {
    const code = [
      ...Array.from({ length: 200 }, () => 'const spread = { ...a, ...b };'),
      '@keyframes fade { 0% { opacity: 0 } 100% { opacity: 1 } }',
      '  50% { opacity: 0.5 }',
      '/** Resolving the target before use. */',
      'const ellipsis = ...;',
      'UNIQUE_TAIL_MARKER',
    ].join('\n');
    const { output } = runMirror('Read', readResponse(code));

    expect(output).toContain('{ ...a, ...b }');
    expect(output).toContain('50% { opacity: 0.5 }');
    expect(output).toContain('Resolving the target before use.');
    expect(output).toContain('const ellipsis = ...;');
    expect(output).toContain('UNIQUE_TAIL_MARKER');
  });

  it('still strips package-manager progress noise from Bash', () => {
    const noisy = [
      ...Array.from({ length: 200 }, (_, i) => `Progress: resolved ${i}, reused 0`),
      '⠋ installing',
      'npm WARN deprecated foo@1.0.0',
      'Added 12 packages',
      'BUILD OK',
    ].join('\n');
    const { output } = runMirror('Bash', bashResponse(noisy));

    expect(output).not.toContain('Progress: resolved');
    expect(output).not.toContain('npm WARN');
    expect(output).toContain('BUILD OK');
  });

  it('keeps a leading blank line instead of reporting it as a repeat', () => {
    const withBlankFirst = `\n${Array.from({ length: 400 }, () => 'copying asset').join('\n')}\nEND`;
    const { output } = runMirror('Bash', bashResponse(withBlankFirst));

    expect(output!.startsWith('\n')).toBe(true);
    expect(output).not.toMatch(/^\s*… previous line repeated/);
    expect(output).toContain('previous line repeated 399 more time(s)');
  });

  // The footer costs ~120 chars. A saving smaller than that would make the
  // rewrite bigger than the original.
  it('does not inflate when the saving is smaller than the footer', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `x${i} ${'y'.repeat(60)}`);
    lines.splice(5, 0, lines[4]); // exactly one collapsible duplicate
    expect(runMirror('Bash', bashResponse(lines.join('\n'))).rewritten).toBe(false);
  });

  // Passing the rewrite through argv dies with E2BIG past ARG_MAX (1 MB on
  // macOS). Few enough lines to escape the window, wide enough to exceed it --
  // a minified bundle or a single huge JSON blob has exactly this shape.
  it('survives a rewrite larger than the argv limit', () => {
    const wide = Array.from({ length: 50 }, (_, i) => `line${i} ${'z'.repeat(30_000)}`);
    wide.splice(10, 0, wide[9], wide[9]); // something to collapse, so it still shrinks
    const huge = wide.join('\n');
    expect(huge.length).toBeGreaterThan(1_048_576);

    const { rewritten, output } = runMirror('Read', readResponse(huge));

    expect(rewritten).toBe(true);
    expect(output!.length).toBeGreaterThan(1_048_576);
    expect(output).toContain('line0 ');
    expect(output).toContain('line49 ');
  });

  it('reaps stale spills but keeps the current one', () => {
    const stale = path.join(home, 'old-session');
    fs.mkdirSync(stale, { recursive: true });
    const staleFile = path.join(stale, 'ancient.txt');
    fs.writeFileSync(staleFile, 'old');
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(staleFile, twoDaysAgo, twoDaysAgo);

    const noisy = Array.from({ length: 400 }, () => 'copying asset').join('\n');
    const { output } = runMirror('Bash', bashResponse(noisy));

    expect(fs.existsSync(staleFile)).toBe(false);
    expect(fs.existsSync(output!.match(/Full output: (\S+)/)![1])).toBe(true);
  });

  // The harness discards a rewrite whose shape differs from the tool's own
  // output envelope, silently and without changing the transcript. Only the
  // text field may move; every sibling key must survive untouched.
  it('preserves the Bash output envelope', () => {
    const noisy = Array.from({ length: 400 }, () => 'copying asset').join('\n');
    const { response } = runMirror('Bash', bashResponse(noisy));

    expect(Object.keys(response).sort()).toEqual(Object.keys(bashResponse('')).sort());
    expect(response.stderr).toBe('');
    expect(response.interrupted).toBe(false);
    expect(response.isImage).toBe(false);
    expect(response.noOutputExpected).toBe(false);
  });

  it('preserves the Read output envelope and restates numLines', () => {
    const content = Array.from({ length: 400 }, () => 'const x = 1;').join('\n');
    const { response } = runMirror('Read', readResponse(content));

    expect(response.type).toBe('text');
    expect(Object.keys(response.file).sort()).toEqual(Object.keys(readResponse('').file).sort());
    expect(response.file.filePath).toBe('/tmp/fixture.log');
    expect(response.file.startLine).toBe(1);
    expect(response.file.totalLines).toBe(400);
    expect(response.file.numLines).toBe(response.file.content.split('\n').length);
    expect(response.file.numLines).toBeLessThan(400);
  });

  it('honours the disable switch', () => {
    const noisy = Array.from({ length: 400 }, () => 'copying asset').join('\n');
    expect(
      runMirror('Bash', bashResponse(noisy), { TRACE_MCP_MIRROR_DISABLE: '1' }).rewritten,
    ).toBe(false);
  });
});
