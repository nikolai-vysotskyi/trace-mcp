import { describe, expect, it } from 'vitest';
import { parsePresetArg } from '../../src/server/tool-filter.js';

describe('parsePresetArg (TRA-1218)', () => {
  it('parses --preset <name>', () => {
    expect(parsePresetArg(['node', 'proxy.js', '--preset', 'core'])).toBe('core');
    expect(parsePresetArg(['node', 'proxy.js', 'serve', '--preset', 'minimal'])).toBe('minimal');
  });

  it('parses --preset=<name>', () => {
    expect(parsePresetArg(['node', 'proxy.js', '--preset=indexing'])).toBe('indexing');
    expect(parsePresetArg(['node', 'proxy.js', 'serve', '--preset=review'])).toBe('review');
  });

  it('returns undefined when no preset flag is present', () => {
    expect(parsePresetArg(['node', 'proxy.js'])).toBeUndefined();
    expect(parsePresetArg(['node', 'proxy.js', 'serve'])).toBeUndefined();
  });

  it('returns undefined when preset argument is missing or malformed', () => {
    expect(parsePresetArg(['node', 'proxy.js', '--preset'])).toBeUndefined();
    expect(parsePresetArg(['node', 'proxy.js', '--preset='])).toBeUndefined();
    expect(parsePresetArg(['node', 'proxy.js', '--preset', '--another-flag'])).toBeUndefined();
  });
});
