import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseWindowMode, shouldRunAsAccessory } from '../../shared/window-mode';

const APP_DIR = path.join(__dirname, '..', '..', '..');

describe('parseWindowMode', () => {
  it('accepts the two known modes and rejects anything else', () => {
    expect(parseWindowMode('hidden')).toBe('hidden');
    expect(parseWindowMode('visible')).toBe('visible');
    expect(parseWindowMode(undefined)).toBeUndefined();
    expect(parseWindowMode('')).toBeUndefined();
    expect(parseWindowMode('Hidden')).toBeUndefined();
  });
});

describe('shouldRunAsAccessory', () => {
  it('leaves a shipped build a normal app with a Dock icon', () => {
    expect(shouldRunAsAccessory(undefined, true)).toBe(false);
  });

  it('defaults an unpackaged build to accessory, so a dev run cannot steal the Space', () => {
    expect(shouldRunAsAccessory(undefined, false)).toBe(true);
  });

  it('honours the explicit visible opt-out even when unpackaged', () => {
    expect(shouldRunAsAccessory('visible', false)).toBe(false);
  });

  it('honours hidden even in a packaged build, for capture runs on the artifact', () => {
    expect(shouldRunAsAccessory('hidden', true)).toBe(true);
  });
});

// The two call sites the decision above only matters through. Asserted against
// the source because neither can be exercised from a unit test: one needs a
// non-darwin Electron, the other is a package script.
describe('activation policy call sites', () => {
  it('guards setActivationPolicy on darwin — it does not exist elsewhere', () => {
    const src = fs.readFileSync(path.join(APP_DIR, 'src/main/index.ts'), 'utf-8');
    const call = src.split('\n').find((l) => l.includes('app.setActivationPolicy('));
    expect(call).toBeDefined();
    expect(call).toMatch(/process\.platform === 'darwin'/);
  });

  it('gives the dev:electron script the visible opt-out', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf-8'));
    expect(pkg.scripts['dev:electron']).toContain('TRACE_MCP_WINDOW_MODE=visible');
  });
});
