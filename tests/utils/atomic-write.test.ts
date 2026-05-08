import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { atomicWriteJson, atomicWriteString } from '../../src/utils/atomic-write.js';

describe('atomicWriteString', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trace-atomic-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes content with trailing newline by default', () => {
    const target = join(dir, 'a.txt');
    atomicWriteString(target, 'hello');
    expect(readFileSync(target, 'utf8')).toBe('hello\n');
  });

  it('does not double a trailing newline', () => {
    const target = join(dir, 'b.txt');
    atomicWriteString(target, 'hello\n');
    expect(readFileSync(target, 'utf8')).toBe('hello\n');
  });

  it('honours trailingNewline:false', () => {
    const target = join(dir, 'c.txt');
    atomicWriteString(target, 'hello', { trailingNewline: false });
    expect(readFileSync(target, 'utf8')).toBe('hello');
  });

  it('overwrites an existing file atomically', () => {
    const target = join(dir, 'd.txt');
    writeFileSync(target, 'old');
    atomicWriteString(target, 'new');
    expect(readFileSync(target, 'utf8')).toBe('new\n');
  });

  it('refuses to overwrite a symlink by default', () => {
    const realTarget = join(dir, 'real.txt');
    writeFileSync(realTarget, 'do-not-touch');
    const linkTarget = join(dir, 'link.txt');
    symlinkSync(realTarget, linkTarget);
    expect(() => atomicWriteString(linkTarget, 'gotcha')).toThrowError(/symlink/);
    // realTarget must remain untouched
    expect(readFileSync(realTarget, 'utf8')).toBe('do-not-touch');
  });

  it('rejectSymlinks:false allows writing through a symlink', () => {
    const realTarget = join(dir, 'real2.txt');
    writeFileSync(realTarget, 'old');
    const linkTarget = join(dir, 'link2.txt');
    symlinkSync(realTarget, linkTarget);
    // even with rejectSymlinks:false, atomic rename onto the link replaces
    // the link itself with a regular file (rename(2) doesn't follow symlinks
    // at the target). That's the safer outcome — original file untouched.
    atomicWriteString(linkTarget, 'fresh', { rejectSymlinks: false });
    expect(readFileSync(linkTarget, 'utf8')).toBe('fresh\n');
    expect(readFileSync(realTarget, 'utf8')).toBe('old');
  });

  it('applies the requested mode to the destination', () => {
    if (process.platform === 'win32') return; // Windows mode is mostly meaningless
    const target = join(dir, 'secret.txt');
    atomicWriteString(target, 's', { mode: 0o600 });
    const st = statSync(target);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('does not leave tmp files behind on success', () => {
    const target = join(dir, 'clean.txt');
    atomicWriteString(target, 'x');
    const remaining = require('node:fs')
      .readdirSync(dir)
      .filter((f: string) => f !== 'clean.txt');
    expect(remaining).toEqual([]);
  });

  it('does not leave tmp files behind on failure', () => {
    const subdir = join(dir, 'will-fail');
    mkdirSync(subdir);
    const realTarget = join(subdir, 'real.txt');
    writeFileSync(realTarget, 'x');
    const linkTarget = join(subdir, 'link.txt');
    symlinkSync(realTarget, linkTarget);
    expect(() => atomicWriteString(linkTarget, 'gotcha')).toThrow();
    // No leftover .tmp files in subdir
    const leftover = require('node:fs')
      .readdirSync(subdir)
      .filter((f: string) => f.includes('.tmp.'));
    expect(leftover).toEqual([]);
  });
});

describe('atomicWriteJson', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trace-atomic-json-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips structured data', () => {
    const target = join(dir, 'state.json');
    atomicWriteJson(target, { version: 1, items: [{ a: 1 }, { b: 'two' }] });
    const back = JSON.parse(readFileSync(target, 'utf8'));
    expect(back).toEqual({ version: 1, items: [{ a: 1 }, { b: 'two' }] });
  });

  it('produces a 2-space indented body by default', () => {
    const target = join(dir, 'pretty.json');
    atomicWriteJson(target, { a: 1, b: 2 });
    expect(readFileSync(target, 'utf8')).toBe('{\n  "a": 1,\n  "b": 2\n}\n');
  });

  it('indent:0 produces single-line output', () => {
    const target = join(dir, 'compact.json');
    atomicWriteJson(target, { a: 1 }, { indent: 0 });
    expect(readFileSync(target, 'utf8')).toBe('{"a":1}\n');
  });
});
