/**
 * Lock-in tests for the cooperative-yield contract used by heavy MCP tools.
 *
 * These tests guard the canonical lesson from CRG v2.3.1: an MCP server that
 * runs a long sync handler blocks stdio and the client times out. We yield
 * cooperatively from CPU-bound loops so the event loop stays responsive.
 *
 * The tests below assert two invariants:
 *   1. `yieldToEventLoop()` actually crosses a macrotask boundary — pending
 *      `setImmediate` callbacks scheduled before the yield run before the
 *      yielded code resumes.
 *   2. Heavy tools (Leiden community detection, codemod scan) reference the
 *      yield helper in their source. This is a "did someone strip the yield
 *      out in a refactor?" canary, not a runtime check.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  _resetYieldCountForTests,
  getYieldCount,
  maybeYield,
  yieldToEventLoop,
} from '../../src/utils/event-loop.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

describe('yieldToEventLoop()', () => {
  it('crosses a macrotask boundary — pending setImmediate runs before resumption', async () => {
    const order: string[] = [];

    setImmediate(() => order.push('setImmediate-cb'));
    order.push('before-yield');
    await yieldToEventLoop();
    order.push('after-yield');

    expect(order).toEqual(['before-yield', 'setImmediate-cb', 'after-yield']);
  });

  it('increments the yield counter', async () => {
    _resetYieldCountForTests();
    expect(getYieldCount()).toBe(0);
    await yieldToEventLoop();
    await yieldToEventLoop();
    expect(getYieldCount()).toBe(2);
  });
});

describe('maybeYield(counter, every)', () => {
  it('does not yield when counter is 0', async () => {
    _resetYieldCountForTests();
    await maybeYield(0, 10);
    expect(getYieldCount()).toBe(0);
  });

  it('does not yield when counter is not a multiple of every', async () => {
    _resetYieldCountForTests();
    await maybeYield(7, 10);
    expect(getYieldCount()).toBe(0);
  });

  it('yields when counter % every === 0 and counter > 0', async () => {
    _resetYieldCountForTests();
    await maybeYield(10, 10);
    await maybeYield(20, 10);
    expect(getYieldCount()).toBe(2);
  });
});

describe('lock-in: heavy tools reference the yield helper', () => {
  // If someone removes the yield call from a heavy tool in a refactor, the
  // tool will silently start blocking stdio again. This guard fails the build
  // before that can happen — fix the symptom by re-adding the yield, not by
  // silencing the test.
  const heavyToolFiles = ['src/tools/analysis/communities.ts', 'src/tools/refactoring/refactor.ts'];

  for (const relPath of heavyToolFiles) {
    it(`${relPath} imports a yield helper`, () => {
      const source = readFileSync(resolve(repoRoot, relPath), 'utf-8');
      const importsYield =
        /from\s+['"][^'"]*utils\/event-loop[^'"]*['"]/.test(source) &&
        /(maybeYield|yieldToEventLoop)\b/.test(source);
      expect(importsYield).toBe(true);
    });

    it(`${relPath} actually calls the yield helper`, () => {
      const source = readFileSync(resolve(repoRoot, relPath), 'utf-8');
      // Must be an actual call — not just a comment.
      expect(/await\s+(maybeYield|yieldToEventLoop)\s*\(/.test(source)).toBe(true);
    });
  }
});
