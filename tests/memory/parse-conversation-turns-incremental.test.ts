import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConversationTurns } from '../../src/memory/conversation-miner.js';

/**
 * Tests for the incremental-read variant of `parseConversationTurns`.
 *
 * Sessions are JSONL — one record per line. When `startOffset` lands
 * mid-line (cursor committed inside a record), the parser must drop the
 * partial first line and flag `warningTruncated`.
 */
describe('parseConversationTurns — incremental reads', () => {
  let tmpDir: string;
  let filePath: string;

  /** A turn long enough to clear the >20 char filter in extractTurnContent. */
  const longText = (i: number) =>
    `Decision number ${i}: we will use postgresql for persistence because of jsonb support.`;

  function writeJsonlTurns(count: number): { lines: string[]; totalBytes: number } {
    const lines: string[] = [];
    for (let i = 0; i < count; i++) {
      lines.push(
        JSON.stringify({
          type: 'assistant',
          timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: longText(i) }],
          },
        }),
      );
    }
    const content = lines.join('\n') + '\n';
    fs.writeFileSync(filePath, content);
    return { lines, totalBytes: Buffer.byteLength(content, 'utf-8') };
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parse-incr-test-'));
    filePath = path.join(tmpDir, 'session.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('with startOffset=0 returns the same turns as the no-opts call', () => {
    writeJsonlTurns(5);
    const a = parseConversationTurns(filePath);
    const b = parseConversationTurns(filePath, { startOffset: 0 });
    expect(b.turns).toEqual(a.turns);
    expect(b.endOffset).toBe(a.endOffset);
    expect(b.warningTruncated).toBeUndefined();
  });

  it('endOffset equals the file size on disk', () => {
    const { totalBytes } = writeJsonlTurns(3);
    const r = parseConversationTurns(filePath);
    expect(r.endOffset).toBe(totalBytes);
    expect(r.modifiedMs).toBeGreaterThan(0);
  });

  it('returns only the appended turns when startOffset is at a clean line boundary', () => {
    writeJsonlTurns(3);
    const firstPass = parseConversationTurns(filePath);
    expect(firstPass.turns).toHaveLength(3);

    // Append two more lines.
    const append: string[] = [];
    for (let i = 3; i < 5; i++) {
      append.push(
        JSON.stringify({
          type: 'assistant',
          timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: longText(i) }],
          },
        }),
      );
    }
    fs.appendFileSync(filePath, append.join('\n') + '\n');

    const incr = parseConversationTurns(filePath, { startOffset: firstPass.endOffset });
    expect(incr.turns).toHaveLength(2);
    expect(incr.turns[0].text).toContain('Decision number 3');
    expect(incr.turns[1].text).toContain('Decision number 4');
    expect(incr.warningTruncated).toBeUndefined();
  });

  it('drops the partial first line and sets warningTruncated when startOffset lands mid-line', () => {
    writeJsonlTurns(3);
    const stat = fs.statSync(filePath);
    // Land somewhere in the middle of the file — almost certainly inside a record.
    const midOffset = Math.floor(stat.size / 2);
    const r = parseConversationTurns(filePath, { startOffset: midOffset });
    expect(r.warningTruncated).toBe(true);
    // We dropped the partial first line; the remaining lines that parse
    // should still produce well-formed turns (possibly zero, possibly some).
    for (const t of r.turns) {
      expect(t.text.length).toBeGreaterThan(20);
    }
  });

  it('returns empty when startOffset is at or past the end of the file', () => {
    writeJsonlTurns(3);
    const stat = fs.statSync(filePath);
    const r1 = parseConversationTurns(filePath, { startOffset: stat.size });
    expect(r1.turns).toEqual([]);
    expect(r1.endOffset).toBe(stat.size);

    const r2 = parseConversationTurns(filePath, { startOffset: stat.size + 100 });
    expect(r2.turns).toEqual([]);
    expect(r2.endOffset).toBe(stat.size);
  });

  it('cleanly aligned read after a trailing newline produces no warning', () => {
    // writeJsonlTurns ends with '\n', so endOffset lands AFTER the newline.
    const { totalBytes } = writeJsonlTurns(2);
    const r = parseConversationTurns(filePath, { startOffset: totalBytes });
    expect(r.turns).toEqual([]);
    expect(r.warningTruncated).toBeUndefined();
  });

  it('mid-line read that finds no newline at all returns empty + warningTruncated', () => {
    // Write a single record without trailing newline.
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text: longText(0) }] },
      }),
    );
    const stat = fs.statSync(filePath);
    const r = parseConversationTurns(filePath, { startOffset: Math.floor(stat.size / 2) });
    expect(r.turns).toEqual([]);
    expect(r.warningTruncated).toBe(true);
    expect(r.endOffset).toBe(stat.size);
  });
});
