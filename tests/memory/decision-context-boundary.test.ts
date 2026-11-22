import { describe, expect, it } from 'vitest';
import { extractDecisions } from '../../src/memory/conversation-miner-types.js';

const decision = 'We decided to use SQLite for the local cache because it works offline.';

function mine(text: string) {
  return extractDecisions([
    {
      role: 'assistant',
      text,
      timestamp: '2026-01-01T00:00:00Z',
      referenced_files: [],
      referenced_symbols: [],
    },
  ]);
}

describe('bounded mined-decision context', () => {
  it('does not create the observed partial-word coverage tail', () => {
    const padding = ` ${'padding '.repeat(24)}    `;
    expect(padding.length).toBe(197);
    const [result] = mine(`${decision}${padding}coverage is checked elsewhere.`);
    expect(result).toBeDefined();
    expect(result.content).not.toMatch(/\bcov$/);
    expect(result.content.length).toBeLessThanOrEqual(decision.length + 200);
  });

  it.each(['go', 'coverage_check', 'café', '🔎'])('keeps complete terminal token %s', (word) => {
    const padding = ' '.repeat(200 - word.length);
    const [result] = mine(`${decision}${padding}${word} more context follows`);
    expect(result).toBeDefined();
    expect(result.content).toBe(`${decision}${padding}${word}`.trim());
  });

  it('advances the starting boundary without losing the decision', () => {
    const prefix = `coverage_check${' '.repeat(188)}`;
    const [result] = mine(`${prefix}${decision}`);
    expect(result).toBeDefined();
    expect(result.content).not.toMatch(/^e_check/);
    expect(result.content).toContain(decision);
    expect(result.content.length).toBeLessThanOrEqual(decision.length + 200);
  });

  it('never slices a Unicode surrogate pair', () => {
    const [result] = mine(`${decision}${' '.repeat(199)}🔎 and more text`);
    expect(result).toBeDefined();
    expect(result.content).not.toContain('�');
    expect(result.content).not.toContain('\ud83d');
  });

  it('does not strip a combining mark from an NFD word', () => {
    const [result] = mine(`${decision}${' '.repeat(196)}cafe\u0301 more context follows`);
    expect(result).toBeDefined();
    expect(result.content).not.toMatch(/cafe$/);
    expect(result.content).not.toContain('�');
  });

  it('does not cut a joined emoji sequence', () => {
    const [result] = mine(`${decision}${' '.repeat(198)}👩‍💻 more context follows`);
    expect(result).toBeDefined();
    expect(result.content).not.toContain('👩');
    expect(result.content).not.toContain('�');
  });
});
