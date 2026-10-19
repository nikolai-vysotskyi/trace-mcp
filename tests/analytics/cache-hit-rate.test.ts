import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AnalyticsStore } from '../../src/analytics/analytics-store.js';
import {
  CLAUDE_CACHE_HIT_BASELINE,
  LOCAL_CACHE_HIT_BASELINE,
  classifyCacheProviderFamily,
  computeCacheHitRate,
  isCacheRegression,
} from '../../src/analytics/cache-hit-rate.js';
import type { ParsedSession } from '../../src/analytics/log-parser.js';
import { getSessionAnalytics } from '../../src/analytics/session-analytics.js';
import { createTmpDir, removeTmpDir } from '../test-utils.js';

describe('cache-hit-rate unit tests (TRA-1681)', () => {
  describe('computeCacheHitRate', () => {
    it('returns 0 when total prompt tokens is 0', () => {
      expect(computeCacheHitRate({})).toBe(0);
      expect(
        computeCacheHitRate({ inputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 }),
      ).toBe(0);
    });

    it('reproduces the Qwen-MLX local sample hit rate (~30.3%)', () => {
      // 54.8M cache_read / (126M input + 54.8M cache_read) = 30.3097%
      const rate = computeCacheHitRate({
        inputTokens: 126_000_000,
        cacheReadTokens: 54_800_000,
        cacheCreateTokens: 0,
      });
      expect(rate).toBe(0.3031);
      expect((rate * 100).toFixed(1)).toBe('30.3');
    });

    it('reproduces the Claude Opus sample hit rate (~98.2%)', () => {
      // 455M cache_read vs ~4k input + ~8.3M cache_create
      const rate = computeCacheHitRate({
        inputTokens: 4_000,
        cacheReadTokens: 455_000_000,
        cacheCreateTokens: 8_300_000,
      });
      expect((rate * 100).toFixed(1)).toBe('98.2');
    });

    it('computes blended rate accurately across token aggregates', () => {
      // 250,800 cache_read / 380,800 total prompt tokens = 65.861% -> 65.9%
      const rate = computeCacheHitRate({
        inputTokens: 130_000,
        cacheReadTokens: 250_800,
        cacheCreateTokens: 0,
      });
      expect((rate * 100).toFixed(1)).toBe('65.9');
    });
  });

  describe('classifyCacheProviderFamily', () => {
    it('classifies Claude and Anthropic models as anthropic', () => {
      expect(classifyCacheProviderFamily('claude-opus-5')).toBe('anthropic');
      expect(classifyCacheProviderFamily('claude-sonnet-4-6')).toBe('anthropic');
      expect(classifyCacheProviderFamily('claude-haiku-4')).toBe('anthropic');
      expect(classifyCacheProviderFamily('anthropic/claude-3-5-sonnet')).toBe('anthropic');
      expect(classifyCacheProviderFamily('CLAUDE-3-OPUS')).toBe('anthropic');
    });

    it('classifies local models as local', () => {
      expect(classifyCacheProviderFamily('ddalcu/Qwen3.8-Flash-Next-MLX-Serve-mixed-4-8bit')).toBe(
        'local',
      );
      expect(classifyCacheProviderFamily('qwen2.5-coder-32b')).toBe('local');
      expect(classifyCacheProviderFamily('llama-3.1-8b')).toBe('local');
      expect(classifyCacheProviderFamily('ollama/codellama')).toBe('local');
      expect(classifyCacheProviderFamily('antigravity-mlx')).toBe('local');
      expect(classifyCacheProviderFamily('local-custom-model')).toBe('local');
    });

    it('classifies other/unknown models as other', () => {
      expect(classifyCacheProviderFamily('gpt-4o')).toBe('other');
      expect(classifyCacheProviderFamily('gemini-1.5-pro')).toBe('other');
      expect(classifyCacheProviderFamily(null)).toBe('other');
      expect(classifyCacheProviderFamily(undefined)).toBe('other');
      expect(classifyCacheProviderFamily('')).toBe('other');
    });
  });

  describe('isCacheRegression', () => {
    it('detects Anthropic hit-rate regressions against CLAUDE_CACHE_HIT_BASELINE', () => {
      expect(CLAUDE_CACHE_HIT_BASELINE).toBe(0.927);
      // Healthy: above baseline - 0.05
      expect(isCacheRegression('anthropic', 0.982)).toBe(false);
      expect(isCacheRegression('anthropic', 0.88)).toBe(false);
      // Regressed: below 0.927 - 0.05 = 0.877
      expect(isCacheRegression('anthropic', 0.85)).toBe(true);
      expect(isCacheRegression('anthropic', 0.7)).toBe(true);
    });

    it('scopes local providers to LOCAL_CACHE_HIT_BASELINE and avoids false alarms', () => {
      expect(LOCAL_CACHE_HIT_BASELINE).toBe(0.3);
      // Healthy for local (30.3% does not trip regression, whereas Anthropic baseline would)
      expect(isCacheRegression('local', 0.303)).toBe(false);
      expect(isCacheRegression('local', 0.28)).toBe(false);
      // Regressed for local: below 0.30 - 0.05 = 0.25
      expect(isCacheRegression('local', 0.2)).toBe(true);
    });

    it('returns false for other/untracked provider families', () => {
      expect(isCacheRegression('other', 0.1)).toBe(false);
    });

    it('accepts model name strings and classifies them automatically', () => {
      // Claude model name checks against Anthropic baseline (0.927)
      expect(isCacheRegression('claude-opus-5', 0.98)).toBe(false);
      expect(isCacheRegression('claude-sonnet-4-6', 0.85)).toBe(true);

      // Local model name checks against Local baseline (0.30)
      expect(isCacheRegression('ddalcu/Qwen3.8-Flash-Next-MLX-Serve-mixed-4-8bit', 0.303)).toBe(
        false,
      );
      expect(isCacheRegression('qwen2.5-coder-32b', 0.2)).toBe(true);

      // Untracked model name returns false
      expect(isCacheRegression('gpt-4o', 0.1)).toBe(false);
    });
  });
});

describe('cache-hit-rate store integration & smoke test (TRA-1681)', () => {
  let tmpDir: string;
  let dbPath: string;
  let store: AnalyticsStore;

  beforeEach(() => {
    tmpDir = createTmpDir('cache-hit-rate-test-');
    dbPath = path.join(tmpDir, 'analytics.db');
    store = new AnalyticsStore(dbPath);
  });

  afterEach(() => {
    store.close();
    removeTmpDir(tmpDir);
  });

  function seedTestSession(session: {
    id: string;
    startedAt: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
  }): void {
    const parsed: ParsedSession = {
      summary: {
        sessionId: session.id,
        projectPath: '/projects/test-repo',
        startedAt: session.startedAt,
        endedAt: session.startedAt,
        model: session.model,
        usage: {
          inputTokens: session.inputTokens,
          outputTokens: session.outputTokens,
          cacheReadTokens: session.cacheReadTokens,
          cacheCreateTokens: session.cacheCreateTokens,
        },
        toolCallCount: 1,
      },
      toolCalls: [],
      toolResults: new Map(),
    };
    store.storeSession(parsed);
  }

  it('smoke test: mixed day reading blended 65.9% while Anthropic sits at 98.0% and Local at 30.3%', () => {
    const today = new Date().toISOString();

    // 1. Anthropic session: 196k cache_read / 200k prompt tokens = 98.0%
    seedTestSession({
      id: 'sess-claude',
      startedAt: today,
      model: 'claude-opus-5',
      inputTokens: 4_000,
      outputTokens: 500,
      cacheReadTokens: 196_000,
      cacheCreateTokens: 0,
    });

    // 2. Local session: 54.8k cache_read / 180.8k prompt tokens = 30.3%
    seedTestSession({
      id: 'sess-qwen',
      startedAt: today,
      model: 'ddalcu/Qwen3.8-Flash-Next-MLX-Serve-mixed-4-8bit',
      inputTokens: 126_000,
      outputTokens: 500,
      cacheReadTokens: 54_800,
      cacheCreateTokens: 0,
    });

    // Test getSessionAnalytics
    const analytics = store.getSessionAnalytics({ period: 'all' });
    expect(analytics.sessions_count).toBe(2);

    // Blended rate across both sessions: 250,800 / 380,800 = 65.86% -> 65.9%
    expect((analytics.cache_hit_rate.blended * 100).toFixed(1)).toBe('65.9');

    // Per-provider breakdown clearly separates anthropic and local
    expect(analytics.cache_hit_rate.by_provider.anthropic).toBeDefined();
    expect(analytics.cache_hit_rate.by_provider.local).toBeDefined();
    expect((analytics.cache_hit_rate.by_provider.anthropic * 100).toFixed(1)).toBe('98.0');
    expect((analytics.cache_hit_rate.by_provider.local * 100).toFixed(1)).toBe('30.3');

    // Per-model breakdown
    expect((analytics.cache_hit_rate.by_model['claude-opus-5'] * 100).toFixed(1)).toBe('98.0');
    expect(
      (
        analytics.cache_hit_rate.by_model['ddalcu/Qwen3.8-Flash-Next-MLX-Serve-mixed-4-8bit'] * 100
      ).toFixed(1),
    ).toBe('30.3');

    // Test getUsageTrends
    const trends = store.getUsageTrends(7);
    expect(trends.length).toBe(1);
    const day = trends[0];
    expect((day.cache_hit_rate * 100).toFixed(1)).toBe('65.9');
    expect((day.cache_hit_rate_by_provider.anthropic * 100).toFixed(1)).toBe('98.0');
    expect((day.cache_hit_rate_by_provider.local * 100).toFixed(1)).toBe('30.3');

    // Test session-analytics getSessionAnalytics (camelCase wrapper)
    const sessionAnalytics = getSessionAnalytics(store, { period: 'all' });
    expect(sessionAnalytics.sessionsCount).toBe(2);
    expect((sessionAnalytics.cacheHitRate.blended * 100).toFixed(1)).toBe('65.9');
    expect((sessionAnalytics.cacheHitRate.byProvider.anthropic * 100).toFixed(1)).toBe('98.0');
    expect((sessionAnalytics.cacheHitRate.byProvider.local * 100).toFixed(1)).toBe('30.3');
    expect((sessionAnalytics.cacheHitRate.byModel['claude-opus-5'] * 100).toFixed(1)).toBe('98.0');
    expect(
      (
        sessionAnalytics.cacheHitRate.byModel['ddalcu/Qwen3.8-Flash-Next-MLX-Serve-mixed-4-8bit'] *
        100
      ).toFixed(1),
    ).toBe('30.3');
  });
});
