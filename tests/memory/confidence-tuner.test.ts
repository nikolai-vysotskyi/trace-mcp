/**
 * Tests for the P2.5 confidence-weight tuner.
 *
 * These tests intentionally avoid the global ~/.trace-mcp/confidence_weights.json
 * path — every load/save uses an explicit per-test tmp path so the suite can
 * run in parallel with a daemon writing to the real file.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_WEIGHTS,
  type LearnedWeights,
  type TuneEvent,
  loadWeights,
  saveWeights,
  scoreWithWeights,
  tuneConfidenceWeights,
} from '../../src/memory/confidence-tuner.js';

function makeEvent(label: 0 | 1, signalOverrides: Partial<TuneEvent['signals']> = {}): TuneEvent {
  return {
    label,
    confidence_at_decision: 0.5,
    signals: {
      has_code_ref: false,
      content_length: 100,
      tag_count: 0,
      type: 'preference',
      has_service: false,
      ...signalOverrides,
    },
  };
}

describe('tuneConfidenceWeights', () => {
  it('refuses to fit when events < minEvents', () => {
    const events = [makeEvent(1), makeEvent(0)];
    const res = tuneConfidenceWeights(events, DEFAULT_WEIGHTS, { minEvents: 25 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('insufficient_events');
    expect(res.events_used).toBe(2);
    expect(res.weights).toBeUndefined();
  });

  it('refuses to fit when all labels are 1 (all-approved)', () => {
    const events = Array.from({ length: 30 }, () => makeEvent(1));
    const res = tuneConfidenceWeights(events, DEFAULT_WEIGHTS, { minEvents: 25 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('all_same_label');
  });

  it('refuses to fit when all labels are 0 (all-rejected)', () => {
    const events = Array.from({ length: 30 }, () => makeEvent(0));
    const res = tuneConfidenceWeights(events, DEFAULT_WEIGHTS, { minEvents: 25 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('all_same_label');
  });

  it('fits with a separable dataset where code_ref discriminates', () => {
    // 25 approved decisions all carry has_code_ref; 25 rejected decisions don't.
    // The fitter should learn that codeRef is a strong positive signal.
    const events: TuneEvent[] = [
      ...Array.from({ length: 25 }, () => makeEvent(1, { has_code_ref: true })),
      ...Array.from({ length: 25 }, () => makeEvent(0, { has_code_ref: false })),
    ];
    const res = tuneConfidenceWeights(events, DEFAULT_WEIGHTS, { minEvents: 25 });
    expect(res.ok).toBe(true);
    expect(res.weights).toBeDefined();
    // codeRef weight should grow above the default 0.2 because every approval
    // had it and every rejection didn't.
    expect(res.weights!.codeRef).toBeGreaterThan(DEFAULT_WEIGHTS.codeRef);
    expect(res.events_used).toBe(50);
    expect(res.weights!.version).toBe(1);
    expect(res.weights!.fitted_at).toBeTruthy();
  });

  it('loss decreases between before and after fitting', () => {
    // Approve = high-signal type + code ref; reject = low-signal preference, no refs.
    const events: TuneEvent[] = [
      ...Array.from({ length: 20 }, () =>
        makeEvent(1, {
          has_code_ref: true,
          type: 'architecture_decision',
          content_length: 250,
        }),
      ),
      ...Array.from({ length: 20 }, () =>
        makeEvent(0, {
          has_code_ref: false,
          type: 'preference',
          content_length: 30,
        }),
      ),
    ];
    const res = tuneConfidenceWeights(events, DEFAULT_WEIGHTS, { minEvents: 25 });
    expect(res.ok).toBe(true);
    expect(res.loss_after).toBeLessThan(res.loss_before!);
  });

  it('clamps weights within [-1, 1.5] even with aggressive learning rate', () => {
    // Pathological dataset to push weights to extremes.
    const events: TuneEvent[] = [
      ...Array.from({ length: 100 }, () => makeEvent(1, { has_code_ref: true, tag_count: 5 })),
      ...Array.from({ length: 100 }, () => makeEvent(0, { has_code_ref: false, tag_count: 0 })),
    ];
    const res = tuneConfidenceWeights(events, DEFAULT_WEIGHTS, {
      minEvents: 25,
      iterations: 5000,
      learningRate: 1.0,
    });
    expect(res.ok).toBe(true);
    const w = res.weights!;
    for (const v of [w.base, w.codeRef, w.length, w.tags, w.typeHighSignal, w.service]) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1.5);
    }
  });

  it('marks reason="fitted" on success', () => {
    const events: TuneEvent[] = [
      ...Array.from({ length: 15 }, () => makeEvent(1, { has_code_ref: true })),
      ...Array.from({ length: 15 }, () => makeEvent(0)),
    ];
    const res = tuneConfidenceWeights(events, DEFAULT_WEIGHTS, { minEvents: 25 });
    expect(res.ok).toBe(true);
    expect(res.reason).toBe('fitted');
  });
});

describe('scoreWithWeights', () => {
  it('clamps the output to [0, 1]', () => {
    // Wildly out-of-range weights — the score should still saturate at 1.
    const huge: LearnedWeights = {
      base: 0.5,
      codeRef: 2,
      length: 2,
      tags: 2,
      typeHighSignal: 2,
      service: 2,
      version: 1,
    };
    const score = scoreWithWeights(
      {
        has_code_ref: true,
        content_length: 500,
        tag_count: 3,
        type: 'architecture_decision',
        has_service: true,
      },
      huge,
    );
    expect(score).toBeLessThanOrEqual(1);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it('matches the legacy fixed-weight scorer when weights are DEFAULT_WEIGHTS', () => {
    // base=0.4, code_ref present (+0.2), tags (+0.1) -> 0.7
    const score = scoreWithWeights(
      {
        has_code_ref: true,
        content_length: 50,
        tag_count: 2,
        type: 'preference',
        has_service: false,
      },
      DEFAULT_WEIGHTS,
    );
    expect(score).toBeCloseTo(0.7, 5);
  });
});

describe('saveWeights / loadWeights round-trip', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weights-test-'));
    filePath = path.join(tmpDir, 'confidence_weights.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saves and reloads weights exactly', () => {
    const w: LearnedWeights = {
      base: 0.42,
      codeRef: 0.31,
      length: 0.18,
      tags: 0.11,
      typeHighSignal: 0.09,
      service: 0.04,
      fitted_at: '2026-05-18T12:00:00.000Z',
      events_used: 100,
      version: 1,
    };
    saveWeights(w, filePath);
    expect(fs.existsSync(filePath)).toBe(true);
    const loaded = loadWeights(filePath);
    expect(loaded).toEqual(w);
  });

  it('returns DEFAULT_WEIGHTS when file is absent', () => {
    const loaded = loadWeights(path.join(tmpDir, 'missing.json'));
    expect(loaded).toEqual(DEFAULT_WEIGHTS);
  });

  it('returns DEFAULT_WEIGHTS when file is malformed JSON', () => {
    fs.writeFileSync(filePath, 'not json {{{');
    const loaded = loadWeights(filePath);
    expect(loaded).toEqual(DEFAULT_WEIGHTS);
  });

  it('returns DEFAULT_WEIGHTS when version is not 1', () => {
    fs.writeFileSync(filePath, JSON.stringify({ ...DEFAULT_WEIGHTS, version: 99 }));
    const loaded = loadWeights(filePath);
    expect(loaded).toEqual(DEFAULT_WEIGHTS);
  });

  it('returns DEFAULT_WEIGHTS when a required field is missing', () => {
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, base: 0.4 }));
    const loaded = loadWeights(filePath);
    expect(loaded).toEqual(DEFAULT_WEIGHTS);
  });

  it('saveWeights is atomic — no leftover .tmp file after success', () => {
    saveWeights(DEFAULT_WEIGHTS, filePath);
    const dirEntries = fs.readdirSync(tmpDir);
    // Only the final file should remain; any .tmp scratch file was renamed.
    expect(dirEntries).toEqual(['confidence_weights.json']);
  });
});
