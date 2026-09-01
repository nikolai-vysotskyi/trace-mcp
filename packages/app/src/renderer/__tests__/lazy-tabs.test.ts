import { describe, expect, it } from 'vitest';

// App.tsx pulls AskTab in through `lazy(() => import(...).then(m => ({ default: m.AskTab })))`
// to keep react-markdown out of the entry chunk. That wrapper names the export as a
// string, so renaming or defaulting it type-checks fine and only breaks when a user
// clicks the tab. This asserts the name the wrapper depends on still exists.
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
});
