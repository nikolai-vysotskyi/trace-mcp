import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { makeIntraFileReader } from '../intra-file-usage.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'intra-file-reader-'));
const root = path.join(tmp, 'project');
fs.mkdirSync(root);
fs.writeFileSync(path.join(root, 'inside.ts'), 'export const inside = 1;\n');
fs.writeFileSync(path.join(tmp, 'outside.ts'), 'export const outside = 1;\n');

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('makeIntraFileReader', () => {
  it('reads a file inside the project root', () => {
    expect(makeIntraFileReader(root)('inside.ts')).toContain('inside');
  });

  it('returns null for an absolute path outside the project root', () => {
    expect(makeIntraFileReader(root)(path.join(tmp, 'outside.ts'))).toBeNull();
  });

  it('returns null for a relative path that escapes the project root', () => {
    expect(makeIntraFileReader(root)('../outside.ts')).toBeNull();
  });

  it('returns null when no project root is configured', () => {
    expect(makeIntraFileReader(undefined)('inside.ts')).toBeNull();
  });
});
