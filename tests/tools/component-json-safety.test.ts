/**
 * Tests that getComponentTree does not crash when stored JSON fields are malformed.
 * This can happen if the DB is written by an older version or if data is corrupted.
 */
import { describe, it, expect } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { getComponentTree } from '../../src/tools/framework/components.js';

function setupWithCorruptedComponent() {
  const db = initializeDatabase(':memory:');
  const store = new Store(db);

  // Insert a file normally
  const fileId = store.insertFile('src/Broken.vue', 'vue', 'abc123', 100);

  // Insert a component with malformed JSON in all JSON fields, bypassing the Store API
  // to simulate corrupted data that could exist in older DBs
  db.prepare(`
    INSERT INTO components (file_id, name, kind, props, emits, slots, composables, framework)
    VALUES (?, 'Broken', 'component', ?, ?, ?, ?, 'vue')
  `).run(
    fileId,
    '{not valid json',       // malformed props
    '[also broken',          // malformed emits
    '{"slots": [broken}',   // malformed slots
    'not json at all',       // malformed composables
  );

  return { db, store };
}

describe('getComponentTree JSON.parse safety', () => {
  it('does not throw when component has malformed JSON fields', () => {
    const { store } = setupWithCorruptedComponent();

    expect(() => {
      getComponentTree(store, 'src/Broken.vue');
    }).not.toThrow();
  });

  it('returns ok result with empty parsed fields when JSON is malformed', () => {
    const { store } = setupWithCorruptedComponent();

    const result = getComponentTree(store, 'src/Broken.vue');
    expect(result.isOk()).toBe(true);

    const tree = result._unsafeUnwrap();
    expect(tree.root.name).toBe('Broken');

    // Malformed JSON → fields should be undefined (skipped), not throw
    expect(tree.root.props).toBeUndefined();
    expect(tree.root.emits).toBeUndefined();
    expect(tree.root.slots).toBeUndefined();
    expect(tree.root.composables).toBeUndefined();
  });

  it('still builds children when root JSON fields are corrupted', () => {
    const { db, store } = setupWithCorruptedComponent();

    // Add a child file + component with valid JSON
    const childFileId = store.insertFile('src/Child.vue', 'vue', 'def456', 100);
    store.insertComponent(
      { name: 'Child', kind: 'component', props: { label: 'string' }, emits: [], slots: [], composables: [], framework: 'vue' },
      childFileId,
    );

    // Result should still be ok (no crash) — children won't appear because
    // there are no renders_component edges, but the call itself must not throw
    const result = getComponentTree(store, 'src/Broken.vue');
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().root.children).toEqual([]);
  });
});
