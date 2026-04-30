import { describe, expect, it } from 'vitest';
import { renderItemsMarkdown, renderSectionsMarkdown } from '../../src/scoring/markdown-render.js';

describe('renderItemsMarkdown', () => {
  it('handles an empty list with a placeholder', () => {
    const md = renderItemsMarkdown([], { title: 'Title' });
    expect(md).toContain('# Title');
    expect(md).toContain('_No items._');
  });

  it('renders heading + code fence with auto-detected language', () => {
    const md = renderItemsMarkdown([
      { name: 'getUser', file: 'src/auth.ts', source: 'function getUser() { return 1; }' },
    ]);
    expect(md).toContain('### `getUser` — src/auth.ts');
    expect(md).toContain('```typescript');
    expect(md).toContain('function getUser()');
    expect(md).toContain('```');
  });

  it('falls back to bullet for items without source', () => {
    const md = renderItemsMarkdown([{ name: 'foo', symbol_id: 'src/x.ts::foo' }]);
    expect(md).not.toContain('```');
    expect(md).toContain('_src/x.ts::foo_');
  });

  it('uses "Context" as default section title', () => {
    const md = renderItemsMarkdown([{ name: 'a', file: 'a.py', source: 'pass' }]);
    expect(md).toContain('## Context');
    expect(md).toContain('```python');
  });
});

describe('renderSectionsMarkdown', () => {
  it('omits empty groups entirely', () => {
    const md = renderSectionsMarkdown({
      title: 'Doc',
      groups: [
        { title: 'Symbols', items: [{ name: 'foo', file: 'a.ts', source: 'x' }] },
        { title: 'Tests', items: [] },
      ],
    });
    expect(md).toContain('## Symbols');
    expect(md).not.toContain('## Tests');
  });

  it('renders subtitle below title', () => {
    const md = renderSectionsMarkdown({
      title: 'Task',
      subtitle: '_intent: bugfix_',
      groups: [{ title: 'X', items: [{ name: 'a', file: 'a.go', source: 'pkg' }] }],
    });
    expect(md.indexOf('# Task')).toBeLessThan(md.indexOf('_intent: bugfix_'));
    expect(md).toContain('```go');
  });

  it('handles all-empty groups gracefully', () => {
    const md = renderSectionsMarkdown({ title: 'T', groups: [{ title: 'X', items: [] }] });
    expect(md).toContain('# T');
  });
});
