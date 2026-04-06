# Development

## Setup

```bash
git clone https://github.com/nikolai-vysotskyi/trace-mcp.git
cd trace-mcp
npm install
npm run build
```

## Scripts

| Script | What it does |
|---|---|
| `npm run build` | TypeScript compilation via tsup |
| `npm run dev` | Watch mode (tsup --watch) |
| `npm test` | Run all tests (vitest) |
| `npm run test:watch` | Watch mode for tests |
| `npm run lint` | TypeScript type checking |
| `npm run serve` | Start MCP server (dev) |

## Tests

```bash
npm test                       # All tests (1668 tests, ~2s)
npm test -- --run <pattern>    # Run specific test files
npm run test:watch             # Watch mode
```

Test files live alongside source or in `tests/`:

```
tests/
├── ai/              # AI pipeline tests
├── ci/              # CI report generator and formatter tests
├── frameworks/      # Framework plugin tests (per-framework)
├── tools/           # MCP tool integration tests
├── integration/     # End-to-end indexing tests
├── e2e/             # CLI and protocol tests
├── db/              # Database layer tests
├── indexer/         # Indexing pipeline tests
├── parsers/         # Language parser tests
├── resolvers/       # Module resolver tests
├── scoring/         # Scoring algorithm tests
└── fixtures/        # Test fixtures (sample projects)
```

---

## Adding a new integration plugin

1. Create a directory under the appropriate category in `src/indexer/plugins/integration/`:

```
src/indexer/plugins/integration/framework/my-framework/
├── index.ts
└── helpers.ts (optional)
```

2. Implement `FrameworkPlugin`:

```typescript
import { FrameworkPlugin, PluginManifest } from '../../../../plugin-api/types.js';

const manifest: PluginManifest = {
  name: 'my-framework',
  version: '1.0.0',
  languages: ['typescript'],
  priority: 20,
};

export const MyFrameworkPlugin: FrameworkPlugin = {
  manifest,

  detect(ctx) {
    // Check package.json, config files, etc.
    return ctx.hasDependency('my-framework');
  },

  registerSchema() {
    return {
      nodeTypes: ['my_framework_route'],
      edgeTypes: ['my_framework_handles'],
    };
  },

  extractNodes(filePath, content, language) {
    // Parse file and return symbols
    return { symbols: [], edges: [] };
  },

  resolveEdges(ctx) {
    // Resolve cross-file relationships
    return [];
  },
};
```

3. Register the plugin in `src/indexer/plugins/integration/framework/index.ts` (or the appropriate category index).

4. Write tests in `tests/frameworks/my-framework.test.ts`.

---

## Adding a new language plugin

1. Create files in `src/indexer/plugins/language/my-lang/`:

```
src/indexer/plugins/language/my-lang/
├── index.ts
└── helpers.ts
```

2. Use tree-sitter for parsing. See existing plugins for patterns (e.g., `typescript/index.ts`).

3. Register in `src/indexer/plugins/language/index.ts`.

---

## Plugin test harness

The `src/plugin-api/test-harness.ts` module provides utilities for testing plugins in isolation:

```typescript
import { createTestHarness } from '../src/plugin-api/test-harness.js';

const harness = createTestHarness(MyPlugin);
const result = await harness.indexFile('test.ts', sourceCode);
expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'myFunction' }));
```
