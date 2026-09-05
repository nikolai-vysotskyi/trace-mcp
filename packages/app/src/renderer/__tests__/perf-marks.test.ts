// @vitest-environment jsdom
/**
 * Guard: every screen still declares its first useful paint (TRA-934).
 *
 * The per-screen numbers in `docs/perf/screens.json` are produced by
 * `scripts/perf-screens.mjs` reading these marks. A screen that quietly loses
 * its `useUsefulPaint` call does not fail anything — it just disappears from
 * the report, and the next run reads a shorter table as good news.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { markUseful, resetUsefulPaints } from '../perf';

const RENDERER = path.resolve(__dirname, '..');

/** screen id → the file that must mark it. */
const SCREENS: Record<string, string> = {
  workspace: 'workspace/Workspace.tsx',
  clients: 'tabs/Clients.tsx',
  overview: 'tabs/ProjectOverview.tsx',
  ask: 'tabs/AskTab.tsx',
  activity: 'tabs/ToolActivity.tsx',
  memory: 'tabs/MemoryExplorer.tsx',
  notebook: 'tabs/Notebook.tsx',
  insights: 'tabs/Insights.tsx',
  graph: 'tabs/GraphExplorerGPU.tsx',
};

describe('useful-paint instrumentation', () => {
  it.each(Object.entries(SCREENS))('%s marks its first useful paint', (screen, file) => {
    const src = fs.readFileSync(path.join(RENDERER, file), 'utf-8');
    // Multi-line call sites are fine; the screen id is what must be there.
    expect(src).toMatch(new RegExp(`useUsefulPaint\\(\\s*'${screen}'`));
  });

  it('records a screen once and only once', () => {
    resetUsefulPaints();
    markUseful('overview');
    const first = window.__traceUseful?.overview;
    markUseful('overview');
    expect(window.__traceUseful?.overview).toBe(first);
    expect(typeof first).toBe('number');
  });
});
