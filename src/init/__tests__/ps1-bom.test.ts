import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { UTF8_BOM, hasUtf8Bom, withPs1Bom } from '../ps1-bom.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// src/init/__tests__ -> repo root is three levels up.
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const HOOKS_DIR = path.join(REPO_ROOT, 'hooks');

function listPs1Templates(): string[] {
  return fs
    .readdirSync(HOOKS_DIR)
    .filter((f) => f.toLowerCase().endsWith('.ps1'))
    .map((f) => path.join(HOOKS_DIR, f));
}

describe('withPs1Bom', () => {
  it('prepends the UTF-8 BOM to .ps1 content that lacks one', () => {
    const out = withPs1Bom('C:/x/trace-mcp-launcher.ps1', Buffer.from('# hi\n', 'utf-8'));
    expect(out.subarray(0, 3)).toEqual(UTF8_BOM);
    expect(hasUtf8Bom(out)).toBe(true);
    // Original content preserved after the BOM.
    expect(out.subarray(3).toString('utf-8')).toBe('# hi\n');
  });

  it('is idempotent — does not double-prepend when a BOM is already present', () => {
    const once = withPs1Bom('x.ps1', Buffer.from('code', 'utf-8'));
    const twice = withPs1Bom('x.ps1', once);
    expect(twice).toEqual(once);
    // Exactly one BOM.
    expect(twice.subarray(0, 3)).toEqual(UTF8_BOM);
    expect(hasUtf8Bom(twice.subarray(3))).toBe(false);
  });

  it('leaves non-.ps1 destinations untouched', () => {
    const raw = Buffer.from('#!/bin/sh\n', 'utf-8');
    expect(withPs1Bom('trace-mcp-launcher.cmd', raw)).toBe(raw);
    expect(withPs1Bom('trace-mcp', raw)).toBe(raw);
  });

  it('matches .ps1 case-insensitively', () => {
    const out = withPs1Bom('SCRIPT.PS1', Buffer.from('x', 'utf-8'));
    expect(hasUtf8Bom(out)).toBe(true);
  });
});

describe('repo .ps1 templates', () => {
  it('exist and are ASCII-only (no codepage-dependent bytes)', () => {
    const templates = listPs1Templates();
    // Guard against the directory silently going empty.
    expect(templates.length).toBeGreaterThan(0);

    for (const file of templates) {
      const bytes = fs.readFileSync(file);
      const offending: number[] = [];
      for (const b of bytes) {
        if (b > 0x7f) offending.push(b);
      }
      expect(
        offending.length,
        `${path.basename(file)} contains ${offending.length} non-ASCII byte(s): ${offending
          .map((b) => `0x${b.toString(16)}`)
          .join(', ')}. .ps1 templates must be ASCII so BOM-less reads under cp1251 stay correct.`,
      ).toBe(0);
    }
  });

  it('gain a UTF-8 BOM when written through withPs1Bom (install path)', () => {
    for (const file of listPs1Templates()) {
      const written = withPs1Bom(file, fs.readFileSync(file));
      expect(
        written.subarray(0, 3),
        `${path.basename(file)} should carry a UTF-8 BOM after install`,
      ).toEqual(UTF8_BOM);
    }
  });
});
