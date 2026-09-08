import { describe, expect, it } from 'vitest';

// App.tsx pulls secondary tabs in through `lazy(() => import(...).then(m => ({ default: m.<Tab> })))`
// to keep non-default views and their dependencies out of the startup entry chunk.
// That wrapper names the export as a string, so renaming or defaulting it type-checks
// fine and only breaks when a user clicks the tab. This asserts the names the wrappers
// depend on still exist.
describe('lazily loaded tabs', () => {
  // 30s, not the 5s default: this import pulls in the whole markdown/micromark stack —
  // the suite's single heaviest — and blows the default budget on a loaded machine.
  it(
    'AskTab is still a named export',
    async () => {
      const mod = await import('../tabs/AskTab');
      expect(typeof mod.AskTab).toBe('function');
    },
    30_000,
  );

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

  it('Savings is still a named export', async () => {
    const mod = await import('../tabs/Savings');
    expect(typeof mod.Savings).toBe('function');
  });

  it('GraphExplorerGPU is still a named export', async () => {
    const mod = await import('../tabs/GraphExplorerGPU');
    // React.forwardRef returns an object, standard functional components return a function.
    expect(['function', 'object']).toContain(typeof mod.GraphExplorerGPU);
    expect(mod.GraphExplorerGPU).toBeTruthy();
  });

  it('retries focus until focusNode returns true', async () => {
    let callCount = 0;
    const fakeHandle = {
      focusNode: (_path: string) => {
        callCount++;
        return callCount >= 3;
      },
    };
    let resolved = false;
    const focus = (retries = 30) => {
      if (fakeHandle.focusNode('foo.ts')) {
        resolved = true;
        return;
      }
      if (retries > 0) {
        setTimeout(() => focus(retries - 1), 5);
      }
    };
    focus();
    await new Promise((r) => setTimeout(r, 50));
    expect(resolved).toBe(true);
    expect(callCount).toBe(3);
  });
});
