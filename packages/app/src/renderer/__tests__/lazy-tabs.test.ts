import { describe, expect, it } from 'vitest';

// App.tsx pulls secondary tabs in through `lazy(() => import(...).then(m => ({ default: m.<Tab> })))`
// to keep non-default views and their dependencies out of the startup entry chunk.
// That wrapper names the export as a string, so renaming or defaulting it type-checks
// fine and only breaks when a user clicks the tab. This asserts the names the wrappers
// depend on still exist.
describe('lazily loaded tabs', () => {
  it('AskTab is still a named export', async () => {
    const mod = await import('../tabs/AskTab');
    expect(typeof mod.AskTab).toBe('function');
  });

  it('Activity is still a named export', async () => {
    const mod = await import('../tabs/Activity');
    expect(typeof mod.Activity).toBe('function');
  });

  it('Insights is still a named export', async () => {
    const mod = await import('../tabs/Insights');
    expect(typeof mod.Insights).toBe('function');
  });

  it('MemoryExplorer is still a named export', async () => {
    const mod = await import('../tabs/MemoryExplorer');
    expect(typeof mod.MemoryExplorer).toBe('function');
  });

  it('Notebook is still a named export', async () => {
    const mod = await import('../tabs/Notebook');
    expect(typeof mod.Notebook).toBe('function');
  });
});
