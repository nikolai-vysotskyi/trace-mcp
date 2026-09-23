/**
 * Regression tests for TRA-1848 — mutating-tool writes confined to the
 * project root.
 *
 * Two live escapes (reproduced against npm pins 3.28.0 and 3.31.2, see the
 * issue attachments):
 *  1. `apply_codemod` with a `file_pattern` escaping the root
 *     (e.g. `../outside/*.js`) matched and overwrote files outside the
 *     project. Now refused with an explicit error.
 *  2. Writes through an in-root symlink (`extract_function`,
 *     `remove_dead_code`, `apply_rename`, codemod matches) modified the
 *     link target outside the root. Now refused at write time.
 *
 * Contract preserved: signatures, dry-run defaults and the >20-file
 * `confirm_large` threshold are untouched.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Store } from '../../src/db/store.js';
import {
  applyCodemod,
  applyRename,
  extractFunction,
  removeDeadCode,
} from '../../src/tools/refactoring/refactor.js';
import { validateWritePath } from '../../src/utils/security.js';
import { createTestStore } from '../test-utils.js';

const MAIN_TS = [
  'function main() {',
  '  const x = 10;',
  '  const y = x * 2;',
  '  console.log(y);',
  '  return y;',
  '}',
  '',
].join('\n');

const OUTSIDE_JS = [
  'function outer() {',
  '  const q = 1;',
  '  const w = 2;',
  '  return q + w;',
  '}',
  'module.exports = { outer };',
  '',
].join('\n');

interface Sandbox {
  /** Project root the tools run against. */
  root: string;
  /** Sibling directory outside the root. */
  outside: string;
  /** Absolute path of the canary file outside the root. */
  outsideFile: string;
  /** The canary's original content. */
  outsideBefore: string;
}

const sandboxes: string[] = [];

function createSandbox(): Sandbox {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tra-1848-'));
  sandboxes.push(parent);
  const root = path.join(parent, 'proj');
  const outside = path.join(parent, 'outside');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(root, 'a.js'), MAIN_TS, 'utf-8');
  const outsideFile = path.join(outside, 'secret.js');
  fs.writeFileSync(outsideFile, OUTSIDE_JS, 'utf-8');
  return { root, outside, outsideFile, outsideBefore: OUTSIDE_JS };
}

afterEach(() => {
  while (sandboxes.length > 0) {
    const dir = sandboxes.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function insertFile(store: Store, filePath: string): number {
  return store.insertFile(filePath, 'typescript', `hash_${filePath}`, 100);
}

function insertFunction(
  store: Store,
  fileId: number,
  name: string,
  lineStart?: number,
  lineEnd?: number,
): void {
  const file = store.getFileById(fileId);
  const filePath = file?.path ?? `file_${fileId}`;
  store.insertSymbol(fileId, {
    symbolId: `${filePath}::${name}#function`,
    name,
    kind: 'function',
    byteStart: 0,
    byteEnd: 100,
    lineStart,
    lineEnd,
  });
}

describe('TRA-1848: apply_codemod file_pattern confinement', () => {
  it('refuses a file_pattern escaping the root (apply mode, no write outside)', async () => {
    const sb = createSandbox();
    const result = await applyCodemod(sb.root, 'outer', 'OUTER_X', '../outside/*.js', {
      dryRun: false,
    });

    expect(result.success).toBe(false);
    expect(result.error ?? '').toMatch(/escape.*project root/i);
    expect(fs.readFileSync(sb.outsideFile, 'utf-8')).toBe(sb.outsideBefore);
    expect(result.files_modified).toEqual([]);
  });

  it('refuses a file_pattern escaping the root (dry-run also refuses, no silent trim)', async () => {
    const sb = createSandbox();
    const result = await applyCodemod(sb.root, 'outer', 'OUTER_X', '../outside/*.js', {
      dryRun: true,
    });

    expect(result.success).toBe(false);
    expect(result.error ?? '').toMatch(/escape.*project root/i);
    expect(fs.readFileSync(sb.outsideFile, 'utf-8')).toBe(sb.outsideBefore);
  });

  it('refuses an absolute file_pattern outside the root', async () => {
    const sb = createSandbox();
    // Forward slashes: fast-glob's preferred spelling, so the absolute
    // pattern has the best chance of matching on every OS.
    const absolutePattern = `${sb.outside.replace(/\\/g, '/')}/*.js`;
    const result = await applyCodemod(sb.root, 'outer', 'OUTER_X', absolutePattern, {
      dryRun: false,
    });

    expect(result.success).toBe(false);
    // POSIX: the glob matches and confinement refuses with the escape error.
    // Windows: fast-glob may return no matches for an absolute pattern, which
    // is still an explicit refusal ("No files matched") — either way nothing
    // outside is written.
    expect(result.error ?? '').toMatch(/escape.*project root|No files matched/i);
    expect(fs.readFileSync(sb.outsideFile, 'utf-8')).toBe(sb.outsideBefore);
  });

  it('still applies an in-root pattern normally', async () => {
    const sb = createSandbox();
    const result = await applyCodemod(sb.root, 'main', 'MAIN_X', 'a.js', {
      dryRun: false,
    });

    expect(result.success).toBe(true);
    expect(result.files_modified).toContain('a.js');
    expect(fs.readFileSync(path.join(sb.root, 'a.js'), 'utf-8')).toContain('MAIN_X');
    expect(fs.readFileSync(sb.outsideFile, 'utf-8')).toBe(sb.outsideBefore);
  });
});

describe('TRA-1848: symlink write-through blocked', () => {
  it('extract_function previews through a symlink but refuses to write through it', () => {
    const sb = createSandbox();
    const store = createTestStore();
    fs.symlinkSync(sb.outsideFile, path.join(sb.root, 'link-out.js'));

    const preview = extractFunction(store, sb.root, 'link-out.js', 2, 2, 'extracted', true);
    expect(preview.success).toBe(true);

    const applied = extractFunction(store, sb.root, 'link-out.js', 2, 2, 'extracted', false);
    expect(applied.success).toBe(false);
    expect(applied.error ?? '').toMatch(/symlink/i);
    expect(applied.files_modified).toEqual([]);
    expect(fs.readFileSync(sb.outsideFile, 'utf-8')).toBe(sb.outsideBefore);
  });

  it('extract_function refuses a write under a symlinked parent directory', () => {
    const sb = createSandbox();
    const store = createTestStore();
    fs.symlinkSync(sb.outside, path.join(sb.root, 'linkdir'));

    const applied = extractFunction(store, sb.root, 'linkdir/secret.js', 2, 2, 'extracted', false);
    expect(applied.success).toBe(false);
    expect(applied.error ?? '').toMatch(/symlink|project root/i);
    expect(fs.readFileSync(sb.outsideFile, 'utf-8')).toBe(sb.outsideBefore);
  });

  it('extract_function still rejects plain path traversal', () => {
    const sb = createSandbox();
    const store = createTestStore();

    const applied = extractFunction(
      store,
      sb.root,
      '../outside/secret.js',
      2,
      2,
      'extracted',
      false,
    );
    expect(applied.success).toBe(false);
    expect(applied.error ?? '').toMatch(/traversal|project root/i);
    expect(fs.readFileSync(sb.outsideFile, 'utf-8')).toBe(sb.outsideBefore);
  });

  it('remove_dead_code refuses to delete through a symlink', () => {
    const sb = createSandbox();
    const store = createTestStore();
    const linkAbs = path.join(sb.root, 'link-dead.js');
    fs.symlinkSync(sb.outsideFile, linkAbs);

    const fileId = insertFile(store, 'link-dead.js');
    insertFunction(store, fileId, 'outer', 1, 5);

    const result = removeDeadCode(store, sb.root, 'link-dead.js::outer#function', false);
    expect(result.success).toBe(false);
    expect(result.error ?? '').toMatch(/symlink/i);
    expect(fs.readFileSync(sb.outsideFile, 'utf-8')).toBe(sb.outsideBefore);
  });

  it('apply_rename refuses to write through a symlink', () => {
    const sb = createSandbox();
    const store = createTestStore();
    fs.symlinkSync(sb.outsideFile, path.join(sb.root, 'link-rename.js'));

    const fileId = insertFile(store, 'link-rename.js');
    insertFunction(store, fileId, 'outer');

    const result = applyRename(store, sb.root, 'link-rename.js::outer#function', 'outer2', false);
    expect(result.success).toBe(false);
    expect(result.error ?? '').toMatch(/symlink/i);
    expect(fs.readFileSync(sb.outsideFile, 'utf-8')).toBe(sb.outsideBefore);
  });

  it('apply_codemod refuses matches that resolve outside via symlink', async () => {
    const sb = createSandbox();
    fs.symlinkSync(sb.outsideFile, path.join(sb.root, 'link-codemod.js'));

    const result = await applyCodemod(sb.root, 'outer', 'OUTER_X', 'link-codemod.js', {
      dryRun: false,
    });

    expect(result.success).toBe(false);
    expect(result.error ?? '').toMatch(/symlink/i);
    expect(fs.readFileSync(sb.outsideFile, 'utf-8')).toBe(sb.outsideBefore);
  });
});

describe('TRA-1848: validateWritePath unit contract', () => {
  it('allows in-root writes and rejects traversal, symlinks and symlink escapes', () => {
    const sb = createSandbox();
    const inner = path.join(sb.root, 'a.js');
    expect(validateWritePath(inner, sb.root).isOk()).toBe(true);
    expect(validateWritePath('../outside/secret.js', sb.root).isErr()).toBe(true);

    const linkAbs = path.join(sb.root, 'unit-link.js');
    fs.symlinkSync(sb.outsideFile, linkAbs);
    const linkCheck = validateWritePath(linkAbs, sb.root);
    expect(linkCheck.isErr()).toBe(true);

    // Not-yet-existing target inside the root is allowed (creation path).
    expect(validateWritePath(path.join(sb.root, 'new-file.js'), sb.root).isOk()).toBe(true);
    // Not-yet-existing target outside the root is rejected lexically.
    expect(validateWritePath(path.join(sb.outside, 'new-file.js'), sb.root).isErr()).toBe(true);
  });
});
