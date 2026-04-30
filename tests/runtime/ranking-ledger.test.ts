import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RankingLedger } from '../../src/runtime/ranking-ledger.js';

describe('RankingLedger', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-ledger-'));
    dbPath = path.join(tmpDir, 'ranking.db');
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('records events and reports zero acceptance until acceptance is recorded', () => {
    const ledger = new RankingLedger({ dbPath });
    ledger.recordEvent({
      tool: 'search',
      query: 'foo',
      topSymbolIds: ['a', 'b', 'c'],
      repo: '/proj',
    });
    const stats = ledger.getStats('/proj')!;
    expect(stats.total_events).toBe(1);
    expect(stats.total_accepted).toBe(0);
    ledger.close();
  });

  it('attributes acceptance to the freshest event whose top list contains the symbol', () => {
    const ledger = new RankingLedger({ dbPath });
    ledger.recordEvent({
      tool: 'search',
      query: 'foo',
      topSymbolIds: ['s1', 's2', 's3'],
      repo: '/proj',
      ts: Date.now() - 10_000,
    });
    const accepted = ledger.recordAcceptance('/proj', 's2');
    expect(accepted).toBe(true);
    const stats = ledger.getStats('/proj')!;
    expect(stats.total_accepted).toBe(1);
    expect(stats.acceptance_rate).toBe(1);
    ledger.close();
  });

  it('does not attribute acceptance outside the attribution window', () => {
    const ledger = new RankingLedger({ dbPath, attributionWindowMs: 1000 });
    ledger.recordEvent({
      tool: 'search',
      query: 'foo',
      topSymbolIds: ['s1'],
      repo: '/proj',
      ts: Date.now() - 60_000, // 60s ago, window is 1s
    });
    const accepted = ledger.recordAcceptance('/proj', 's1');
    expect(accepted).toBe(false);
    ledger.close();
  });

  it('attributes only when the symbol is in the top list', () => {
    const ledger = new RankingLedger({ dbPath });
    ledger.recordEvent({
      tool: 'search',
      query: 'foo',
      topSymbolIds: ['s1', 's2'],
      repo: '/proj',
    });
    const accepted = ledger.recordAcceptance('/proj', 'unrelated_symbol');
    expect(accepted).toBe(false);
    ledger.close();
  });

  it('isolates events by repo', () => {
    const ledger = new RankingLedger({ dbPath });
    ledger.recordEvent({ tool: 'search', query: 'a', topSymbolIds: ['x'], repo: '/proj-a' });
    ledger.recordEvent({ tool: 'search', query: 'b', topSymbolIds: ['x'], repo: '/proj-b' });
    expect(ledger.recordAcceptance('/proj-a', 'x')).toBe(true);
    expect(ledger.getStats('/proj-a')!.total_accepted).toBe(1);
    expect(ledger.getStats('/proj-b')!.total_accepted).toBe(0);
    ledger.close();
  });

  it('aggregates per-channel acceptance from channel_hints', () => {
    const ledger = new RankingLedger({ dbPath });
    ledger.recordEvent({
      tool: 'search',
      query: 'foo',
      topSymbolIds: ['s1', 's2'],
      repo: '/proj',
      channelHints: {
        lexical: ['s1', 's2'],
        similarity: ['s1'],
      },
    });
    ledger.recordAcceptance('/proj', 's1');

    const stats = ledger.getStats('/proj')!;
    const lex = stats.by_channel.find((c) => c.channel === 'lexical')!;
    const sim = stats.by_channel.find((c) => c.channel === 'similarity')!;
    const struct = stats.by_channel.find((c) => c.channel === 'structural')!;
    expect(lex.accepted).toBe(1);
    expect(lex.shown).toBe(1);
    expect(sim.accepted).toBe(1);
    expect(struct.shown).toBe(0);
    ledger.close();
  });
});
