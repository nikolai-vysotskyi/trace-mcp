import { describe, expect, it } from 'vitest';
import { activationPolicyFor } from '../activation-policy';

describe('activationPolicyFor', () => {
  it('leaves a shipped build a normal foreground app', () => {
    expect(activationPolicyFor(undefined, true)).toBe('regular');
    expect(activationPolicyFor('visible', true)).toBe('regular');
  });

  it('keeps an unpackaged build out of the Dock by default', () => {
    expect(activationPolicyFor(undefined, false)).toBe('accessory');
    expect(activationPolicyFor('', false)).toBe('accessory');
  });

  it('gives the dev build a foreground opt-out', () => {
    expect(activationPolicyFor('visible', false)).toBe('regular');
  });

  it('never activates for a hidden-window run, packaged or not', () => {
    expect(activationPolicyFor('hidden', false)).toBe('accessory');
    expect(activationPolicyFor('hidden', true)).toBe('accessory');
  });

  it('never activates for a run that announced itself as an agent run', () => {
    expect(activationPolicyFor(undefined, true, true)).toBe('accessory');
    expect(activationPolicyFor('visible', true, true)).toBe('accessory');
    expect(activationPolicyFor('visible', false, true)).toBe('accessory');
  });

  it('treats an unrecognised mode as the default for the build', () => {
    expect(activationPolicyFor('nonsense', false)).toBe('accessory');
    expect(activationPolicyFor('nonsense', true)).toBe('regular');
  });
});
