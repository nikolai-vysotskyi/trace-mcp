/**
 * P2.5 — computeConfidence picks up learned weights from disk when present.
 * Reroutes TRACE_MCP_DATA_DIR to a per-test tmp before importing the
 * confidence/tuner modules so the test never reads or writes the real
 * ~/.trace-mcp/confidence_weights.json.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

const sharedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-tuned-home-'));
process.env.TRACE_MCP_DATA_DIR = sharedHome;

const { computeConfidence, computeConfidenceLegacy, resetCachedWeights, setWeightTuningEnabled } =
  await import('../../src/memory/decision-confidence.js');
const { saveWeights, WEIGHTS_PATH } = await import('../../src/memory/confidence-tuner.js');

describe('computeConfidence with learned weights', () => {
  beforeEach(() => {
    if (fs.existsSync(WEIGHTS_PATH)) fs.unlinkSync(WEIGHTS_PATH);
    resetCachedWeights();
    setWeightTuningEnabled(true);
  });

  afterEach(() => {
    if (fs.existsSync(WEIGHTS_PATH)) fs.unlinkSync(WEIGHTS_PATH);
    resetCachedWeights();
  });

  afterAll(() => {
    fs.rmSync(sharedHome, { recursive: true, force: true });
  });

  it('matches the legacy scorer when no weights file exists', () => {
    const input = {
      title: 't',
      content: 'a'.repeat(50),
      type: 'preference' as const,
      file_path: 'src/foo.ts',
    };
    expect(computeConfidence(input)).toBe(computeConfidenceLegacy(input));
  });

  it('uses learned weights when a tuned file is on disk', () => {
    // Synthetic weights: zero out every signal except a giant code-ref bonus.
    saveWeights({
      base: 0.1,
      codeRef: 1.0,
      length: 0,
      tags: 0,
      typeHighSignal: 0,
      service: 0,
      version: 1,
    });
    resetCachedWeights();
    const withCodeRef = computeConfidence({
      title: 't',
      content: 'short',
      type: 'preference',
      file_path: 'src/foo.ts',
    });
    const withoutCodeRef = computeConfidence({
      title: 't',
      content: 'short',
      type: 'preference',
    });
    // Tuned scorer: 0.1 + 1.0 = 1.1 -> clamped to 1.0
    expect(withCodeRef).toBeCloseTo(1.0, 5);
    // Tuned scorer: 0.1 + 0 = 0.1 — far below the legacy 0.4
    expect(withoutCodeRef).toBeCloseTo(0.1, 5);
    // And the gap differs from the legacy gap of 0.2 (BASE 0.4 vs 0.4 + W_CODE_REF 0.2).
    expect(withCodeRef - withoutCodeRef).toBeGreaterThan(0.5);
  });

  it('resetCachedWeights forces a fresh read on next call', () => {
    // Start with default behaviour
    const first = computeConfidence({
      title: 't',
      content: 'a',
      type: 'preference',
    });
    // Plant a wildly different weight set, but skip resetCachedWeights —
    // the in-memory cache should still serve the old value during the
    // first-minute refresh window (mtime check is gated to once/minute).
    saveWeights({
      base: 0.99,
      codeRef: 0,
      length: 0,
      tags: 0,
      typeHighSignal: 0,
      service: 0,
      version: 1,
    });
    // resetCachedWeights forces the next call to re-read from disk.
    resetCachedWeights();
    const second = computeConfidence({
      title: 't',
      content: 'a',
      type: 'preference',
    });
    expect(second).not.toBe(first);
    expect(second).toBeCloseTo(0.99, 5);
  });

  it('honours setWeightTuningEnabled(false) by falling back to legacy', () => {
    saveWeights({
      base: 0.99,
      codeRef: 0,
      length: 0,
      tags: 0,
      typeHighSignal: 0,
      service: 0,
      version: 1,
    });
    resetCachedWeights();
    setWeightTuningEnabled(false);
    const input = {
      title: 't',
      content: 'a',
      type: 'preference' as const,
    };
    // With tuning disabled, the legacy 0.4 baseline wins regardless of the file.
    expect(computeConfidence(input)).toBe(computeConfidenceLegacy(input));
  });
});
