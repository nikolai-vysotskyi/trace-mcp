import { describe, it, expect } from 'vitest';
import { SortablePlugin } from '../../../src/indexer/plugins/integration/view/sortable/index.js';
import type { ProjectContext, ResolveContext } from '../../../src/plugin-api/types.js';

const plugin = new SortablePlugin();

function extract(code: string, filePath: string, language: string) {
  const result = plugin.extractNodes(filePath, Buffer.from(code), language);
  if (!result.isOk()) {
    throw new Error(`SortablePlugin failed: ${JSON.stringify(result._unsafeUnwrapErr())}`);
  }
  return result._unsafeUnwrap();
}

function ctx(deps: Record<string, string>): ProjectContext {
  return {
    rootPath: '/nonexistent-root-for-detect-test',
    packageJson: { dependencies: deps },
    detectedVersions: [],
    allDependencies: [],
    configFiles: [],
  } as unknown as ProjectContext;
}

describe('SortablePlugin', () => {
  describe('manifest', () => {
    it('declares correct identity', () => {
      expect(plugin.manifest.name).toBe('sortable');
      expect(plugin.manifest.category).toBe('view');
    });
  });

  describe('detect', () => {
    it('detects sortablejs', () => {
      expect(plugin.detect(ctx({ sortablejs: '^1.15.0' }))).toBe(true);
    });
    it('detects sortablejs-vue3', () => {
      expect(plugin.detect(ctx({ 'sortablejs-vue3': '^1.0.0' }))).toBe(true);
    });
    it('detects vue-draggable-next', () => {
      expect(plugin.detect(ctx({ 'vue-draggable-next': '^2.0.0' }))).toBe(true);
    });
    it('detects vuedraggable (vue 2)', () => {
      expect(plugin.detect(ctx({ vuedraggable: '^2.24.0' }))).toBe(true);
    });
    it('returns false when no sortable package present', () => {
      expect(plugin.detect(ctx({ react: '^18.0.0' }))).toBe(false);
    });
  });

  describe('extractNodes — vanilla sortablejs', () => {
    it('extracts onEnd handler from new Sortable()', () => {
      const result = extract(
        `
import Sortable from 'sortablejs';

const list = document.getElementById('items');
new Sortable(list, {
  group: 'shared',
  handle: '.drag-handle',
  onEnd: handleEnd,
  onUpdate: handleUpdate,
});
        `,
        'app/list.ts',
        'typescript',
      );
      const events = result.edges!.filter((e) => e.edgeType === 'sortable_event');
      expect(events.map((e) => e.metadata!.event)).toEqual(['onEnd', 'onUpdate']);
      expect(events[0].metadata!.handler).toBe('handleEnd');
      const groups = result.edges!.filter((e) => e.edgeType === 'sortable_group');
      expect(groups[0].metadata!.group).toBe('shared');
      expect(result.frameworkRole).toBe('sortable_consumer');
    });

    it('extracts handlers from Sortable.create()', () => {
      const result = extract(
        `
import Sortable from 'sortablejs';
Sortable.create(el, { onAdd: onAddItem, onRemove: onRemoveItem });
        `,
        'app/create.ts',
        'typescript',
      );
      const events = result.edges!.filter((e) => e.edgeType === 'sortable_event');
      expect(events.map((e) => e.metadata!.event).sort()).toEqual(['onAdd', 'onRemove']);
    });

    it('extracts group from object form { name: "x" }', () => {
      const result = extract(
        `
import Sortable from 'sortablejs';
new Sortable(el, { group: { name: 'tasks', pull: true, put: true }, onEnd: fn });
        `,
        'app/board.ts',
        'typescript',
      );
      const groups = result.edges!.filter((e) => e.edgeType === 'sortable_group');
      expect(groups[0].metadata!.group).toBe('tasks');
    });
  });

  describe('extractNodes — Vue draggable', () => {
    it('extracts events and group from <draggable> tag', () => {
      const result = extract(
        `
<template>
  <draggable v-model="items" :group="'kanban'" @end="onEnd" @update="onUpdate" handle=".grip">
    <div v-for="i in items">{{ i }}</div>
  </draggable>
</template>
<script setup>
import draggable from 'vue-draggable-next';
</script>
        `,
        'components/Board.vue',
        'vue',
      );
      const events = result.edges!.filter((e) => e.edgeType === 'sortable_event');
      expect(events.map((e) => e.metadata!.event).sort()).toEqual(['onEnd', 'onUpdate']);
      const groups = result.edges!.filter((e) => e.edgeType === 'sortable_group');
      expect(groups[0].metadata!.group).toBe('kanban');
    });

    it('extracts group from object syntax in vue template', () => {
      const result = extract(
        `
<template>
  <Sortable :options="{ group: { name: 'cards' } }" @end="onMove" />
</template>
<script setup>
import { Sortable } from 'sortablejs-vue3';
</script>
        `,
        'components/Cards.vue',
        'vue',
      );
      const groups = result.edges!.filter((e) => e.edgeType === 'sortable_group');
      expect(groups[0].metadata!.group).toBe('cards');
    });
  });

  describe('extractNodes — non-target files', () => {
    it('skips non-supported languages', () => {
      const result = extract('whatever', 'styles.css', 'css');
      expect(result.symbols.length).toBe(0);
      expect(result.edges).toBeUndefined();
    });

    it('skips files without sortable imports or tags', () => {
      const result = extract(
        `
const x = 1;
function foo() { return x; }
        `,
        'app/util.ts',
        'typescript',
      );
      expect(result.symbols.length).toBe(0);
      expect(result.edges).toBeUndefined();
    });
  });

  describe('resolveEdges — shared group', () => {
    it('emits sortable_shared_group between two files using the same group', () => {
      const sourceA = `import Sortable from 'sortablejs'; new Sortable(a, { group: 'kanban' });`;
      const sourceB = `<template><draggable :group="'kanban'" /></template>`;

      const files = [
        { id: 1, path: 'a.ts', language: 'typescript' },
        { id: 2, path: 'b.vue', language: 'vue' },
      ];

      const ctx: ResolveContext = {
        rootPath: '/x',
        getAllFiles: () => files,
        getSymbolsByFile: () => [],
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 0,
        readFile: (p) => (p === 'a.ts' ? sourceA : p === 'b.vue' ? sourceB : undefined),
      } as unknown as ResolveContext;

      const result = plugin.resolveEdges(ctx);
      expect(result.isOk()).toBe(true);
      const edges = result._unsafeUnwrap();
      const shared = edges.filter((e) => e.edgeType === 'sortable_shared_group');
      expect(shared).toHaveLength(1);
      expect(shared[0].metadata!.group).toBe('kanban');
      expect(shared[0].metadata!.fileA).toBe('a.ts');
      expect(shared[0].metadata!.fileB).toBe('b.vue');
    });

    it('does not emit shared edge for a single participant', () => {
      const ctx: ResolveContext = {
        rootPath: '/x',
        getAllFiles: () => [{ id: 1, path: 'a.ts', language: 'typescript' }],
        getSymbolsByFile: () => [],
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 0,
        readFile: () => `import Sortable from 'sortablejs'; new Sortable(el, { group: 'lonely' });`,
      } as unknown as ResolveContext;

      const result = plugin.resolveEdges(ctx);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().filter((e) => e.edgeType === 'sortable_shared_group')).toHaveLength(0);
    });
  });
});
