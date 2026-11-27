/**
 * Agent config homes (~/.codex, ...) and scratch dirs under the shared tmp
 * roots must not become persistent auto-registered projects.
 */
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAutoRegisterNoiseRoot as isEphemeralProjectRoot } from '../global.js';

describe('isAutoRegisterNoiseRoot — agent homes and shared tmp scratch', () => {
  const home = os.homedir();

  it('treats agent config homes and anything below them as ephemeral', () => {
    for (const d of ['.codex', '.claude', '.cursor', '.gemini', '.bb']) {
      expect(isEphemeralProjectRoot(path.join(home, d))).toBe(true);
    }
    expect(isEphemeralProjectRoot(path.join(home, '.codex', 'skills', 'seo'))).toBe(true);
  });

  it('does not match lookalikes or ordinary projects', () => {
    expect(isEphemeralProjectRoot(path.join(home, '.codex-notes'))).toBe(false);
    expect(isEphemeralProjectRoot(path.join(home, 'work', '.codex'))).toBe(false);
    expect(isEphemeralProjectRoot(path.join(home, 'PhpstormProjects', 'app'))).toBe(false);
  });

  it('treats directories below /tmp and /private/tmp as ephemeral unless they are os.tmpdir()', () => {
    const own = os.tmpdir().replace(/^\/private(?=\/)/, '');
    const inOwnTmp = own === '/tmp';
    for (const root of [
      '/tmp/fr_codex_0_x1',
      '/private/tmp/fr_agy_1_y2',
      '/private/tmp/fe_empty',
    ]) {
      expect(isEphemeralProjectRoot(root)).toBe(!inOwnTmp);
    }
  });

  it('never matches the tmp roots themselves or lookalike prefixes', () => {
    expect(isEphemeralProjectRoot('/tmp')).toBe(false);
    expect(isEphemeralProjectRoot('/private/tmp')).toBe(false);
    expect(isEphemeralProjectRoot('/tmpfoo/app')).toBe(false);
    expect(isEphemeralProjectRoot('/private/tmp-backup/app')).toBe(false);
  });

  it('keeps the process own tmpdir persistent (suite fixtures live there)', () => {
    expect(isEphemeralProjectRoot(path.join(os.tmpdir(), 'fixture-project'))).toBe(false);
  });
});
