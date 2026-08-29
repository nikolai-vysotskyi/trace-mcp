import { describe, expect, it } from 'vitest';
import { parseWindowMode, shouldRunAsAccessory } from '../../shared/window-mode';

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
