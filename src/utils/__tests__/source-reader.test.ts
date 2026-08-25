import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readSymbolSource } from '../source-reader.js';

function writeTempFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-reader-test-'));
  const file = path.join(dir, 'fixture.ts');
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

describe('readSymbolSource', () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const f of cleanup.splice(0)) fs.rmSync(path.dirname(f), { recursive: true, force: true });
  });

  it('extends the range back to include leading modifiers', () => {
    const content = 'export default async function foo() {}\n';
    const file = writeTempFile(content);
    cleanup.push(file);
    const byteStart = content.indexOf('function');
    const byteEnd = content.length - 1;
    expect(readSymbolSource(file, byteStart, byteEnd, false)).toBe(
      'export default async function foo() {}',
    );
  });

  it('handles a lone "export" modifier', () => {
    const content = 'export function foo() {}\n';
    const file = writeTempFile(content);
    cleanup.push(file);
    const byteStart = content.indexOf('function');
    expect(readSymbolSource(file, byteStart, content.length - 1, false)).toBe(
      'export function foo() {}',
    );
  });

  it('does not extend past unrelated preceding text', () => {
    const content = 'const x = 1;\nfunction foo() {}\n';
    const file = writeTempFile(content);
    cleanup.push(file);
    const byteStart = content.indexOf('function');
    expect(readSymbolSource(file, byteStart, content.length - 1, false)).toBe(
      'function foo() {}',
    );
  });

  it('does not exponentially backtrack on many repetitions of "export async "', () => {
    // Regression test for CodeQL js/redos alert #965: the old regex
    // `(?:export\s+async\s+|export\s+|async\s+|...)+ $` was ambiguous —
    // "export async " could be consumed as one compound rep or two atomic
    // reps — causing exponential backtracking when the line doesn't end
    // in a full modifier match.
    const modifiers = 'export async '.repeat(2000);
    const content = `${modifiers}x function foo() {}\n`;
    const file = writeTempFile(content);
    cleanup.push(file);
    const byteStart = content.indexOf('function');

    const start = Date.now();
    readSymbolSource(file, byteStart, content.length - 1, false);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500);
  });
});
