import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RankingLedger } from '../../src/runtime/ranking-ledger.js';
import {
  computeTunedWeights,
  loadTuning,
  loadTunedWeights,
  tuneRepoWeights,
} from '../../src/runtime/tuning.js';

describe('tuning', () => {
  let tmpDir: string;
  let ledgerDb: string;
  let tuningFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-tuning-'));
    ledgerDb = path.join(tmpDir, 'ranking.db');
    tuningFile = path.join(tmpDir, 'tuning.jsonc');
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('computeTunedWeights', () => {
    it('lifts the lexical channel when its acceptance rate dominates', () => {
      const stats = [
        { channel: 'lexical' as const, shown: 100, accepted: 80, acceptance_rate: 0.8 },
        { channel: 'structural' as const, shown: 50, accepted: 5, acceptance_rate: 0.1 },
        { channel: 'similarity' as const, shown: 30, accepted: 3, acceptance_rate: 0.1 },
        { channel: 'identity' as const, shown: 10, accepted: 1, acceptance_rate: 0.1 },
      ];
      const weights = computeTunedWeights(stats);
      expect(weights.lexical).toBeGreaterThan(weights.structural);
      expect(weights.lexical).toBeGreaterThan(weights.similarity);
      const sum = weights.lexical + weights.structural + weights.similarity + weights.identity;
      expect(sum).toBeCloseTo(1, 2);
    });

    it('honors a floor so a 0% channel does not vanish', () => {
      const stats = [
        { channel: 'lexical' as const, shown: 100, accepted: 100, acceptance_rate: 1 },
        { channel: 'structural' as const, shown: 100, accepted: 0, acceptance_rate: 0 },
        { channel: 'similarity' as const, shown: 100, accepted: 0, acceptance_rate: 0 },
        { channel: 'identity' as const, shown: 100, accepted: 0, acceptance_rate: 0 },
      ];
      const weights = computeTunedWeights(stats);
      expect(weights.structural).toBeGreaterThan(0);
      expect(weights.similarity).toBeGreaterThan(0);
      expect(weights.identity).toBeGreaterThan(0);
    });
  });

  describe('tuneRepoWeights', () => {
    function seedLedger(eventCount: number, acceptedCount: number): RankingLedger {
      const ledger = new RankingLedger({ dbPath: ledgerDb });
      const ts = Date.now();
      for (let i = 0; i < eventCount; i += 1) {
        ledger.recordEvent({
          tool: 'search',
          query: `q${i}`,
          topSymbolIds: [`s${i}`, `s${i + 1}`],
          repo: '/proj',
          channelHints: { lexical: [`s${i}`, `s${i + 1}`], similarity: [`s${i}`] },
          ts: ts + i,
        });
      }
      for (let i = 0; i < acceptedCount; i += 1) {
        ledger.recordAcceptance('/proj', `s${i}`);
      }
      return ledger;
    }

    it('refuses to tune when below min_events', () => {
      const ledger = seedLedger(5, 5);
      const result = tuneRepoWeights(ledger, '/proj', { filePath: tuningFile, minEvents: 25 });
      expect(result.applied).toBe(false);
      expect(result.reason).toContain('only 5 events');
      ledger.close();
    });

    it('refuses to tune when no acceptance signal exists', () => {
      const ledger = seedLedger(50, 0);
      const result = tuneRepoWeights(ledger, '/proj', { filePath: tuningFile });
      expect(result.applied).toBe(false);
      expect(result.reason).toContain('no acceptance signal');
      ledger.close();
    });

    it('writes tuning.jsonc when applied', () => {
      const ledger = seedLedger(50, 30);
      const result = tuneRepoWeights(ledger, '/proj', { filePath: tuningFile });
      expect(result.applied).toBe(true);
      expect(result.weights).toBeDefined();
      expect(fs.existsSync(tuningFile)).toBe(true);

      const parsed = loadTuning(tuningFile)!;
      expect(parsed.version).toBe(1);
      expect(parsed.repos['/proj']).toBeDefined();
      expect(parsed.repos['/proj'].fusion_weights.lexical).toBeGreaterThan(0);
      ledger.close();
    });

    it('does not persist on dry_run', () => {
      const ledger = seedLedger(50, 30);
      const result = tuneRepoWeights(ledger, '/proj', { filePath: tuningFile, dryRun: true });
      expect(result.applied).toBe(false);
      expect(result.weights).toBeDefined();
      expect(fs.existsSync(tuningFile)).toBe(false);
      ledger.close();
    });
  });

  describe('loadTunedWeights', () => {
    it('returns null when no tuning file exists', () => {
      expect(loadTunedWeights('/proj', tuningFile)).toBeNull();
    });

    it('returns null when the file exists but the repo has no entry', () => {
      fs.writeFileSync(
        tuningFile,
        JSON.stringify({
          version: 1,
          repos: {
            '/other-repo': {
              fusion_weights: { lexical: 0.5, structural: 0.2, similarity: 0.2, identity: 0.1 },
              events_used: 50,
              tuned_at: '2026-04-30T00:00:00.000Z',
            },
          },
        }),
      );
      expect(loadTunedWeights('/proj', tuningFile)).toBeNull();
    });

    it('returns the saved weights for a tuned repo', () => {
      fs.writeFileSync(
        tuningFile,
        JSON.stringify({
          version: 1,
          repos: {
            '/proj': {
              fusion_weights: { lexical: 0.5, structural: 0.2, similarity: 0.2, identity: 0.1 },
              events_used: 100,
              tuned_at: '2026-04-30T00:00:00.000Z',
            },
          },
        }),
      );
      const w = loadTunedWeights('/proj', tuningFile);
      expect(w).toEqual({ lexical: 0.5, structural: 0.2, similarity: 0.2, identity: 0.1 });
    });

    it('round-trips: tuneRepoWeights → loadTunedWeights returns the just-written values', () => {
      const ledger = new RankingLedger({ dbPath: ledgerDb });
      const ts = Date.now();
      for (let i = 0; i < 50; i += 1) {
        ledger.recordEvent({
          tool: 'search',
          query: `q${i}`,
          topSymbolIds: [`s${i}`],
          repo: '/proj',
          channelHints: { lexical: [`s${i}`] },
          ts: ts + i,
        });
      }
      for (let i = 0; i < 30; i += 1) ledger.recordAcceptance('/proj', `s${i}`);
      const r = tuneRepoWeights(ledger, '/proj', { filePath: tuningFile });
      expect(r.applied).toBe(true);

      const loaded = loadTunedWeights('/proj', tuningFile);
      expect(loaded).toEqual(r.weights);
      ledger.close();
    });
  });

  describe('loadTuning', () => {
    it('returns null for missing file', () => {
      expect(loadTuning(path.join(tmpDir, 'never-existed.jsonc'))).toBeNull();
    });

    it('tolerates // line comments', () => {
      fs.writeFileSync(
        tuningFile,
        '// header comment\n{ "version": 1, "repos": { "/x": { "fusion_weights": { "lexical": 0.4, "structural": 0.25, "similarity": 0.2, "identity": 0.15 }, "events_used": 50, "tuned_at": "2026-04-30T00:00:00.000Z" } } }',
      );
      const t = loadTuning(tuningFile);
      expect(t).not.toBeNull();
      expect(t!.repos['/x'].fusion_weights.lexical).toBe(0.4);
    });

    it('returns null for malformed JSON', () => {
      fs.writeFileSync(tuningFile, '{ broken');
      expect(loadTuning(tuningFile)).toBeNull();
    });

    it('returns null for unknown schema version', () => {
      fs.writeFileSync(tuningFile, '{ "version": 99 }');
      expect(loadTuning(tuningFile)).toBeNull();
    });
  });
});
