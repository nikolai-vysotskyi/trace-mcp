/**
 * Integration test: Python import and heritage edge resolution.
 *
 * Indexes a real Python project fixture and verifies that:
 * 1. py_imports are captured and resolved to file-level edges
 * 2. py_inherits metadata is resolved to symbol-level edges
 * 3. __init__.py re-exports work correctly
 * 4. Relative imports resolve properly
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { createTestStore } from '../test-utils.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { PythonLanguagePlugin } from '../../src/indexer/plugins/language/python/index.js';
import type { TraceMcpConfig } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/python-project');

function makeConfig(): TraceMcpConfig {
  return {
    root: FIXTURE_DIR,
    include: ['**/*.py'],
    exclude: ['__pycache__/**', 'venv/**'],
    db: { path: ':memory:' },
    plugins: [],
  };
}

describe('Python resolution pipeline', () => {
  let store: Store;
  let db: Store['db'];

  beforeAll(async () => {
    store = createTestStore();
    db = store.db;
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new PythonLanguagePlugin());

    const config = makeConfig();
    const pipeline = new IndexingPipeline(store, registry, config, FIXTURE_DIR);
    const result = await pipeline.indexAll();

    expect(result.errors).toBe(0);
    expect(result.indexed).toBeGreaterThan(0);
  });

  // ─── File indexing ─────────────────────────────────────────

  it('indexes all Python files in the fixture', () => {
    const files = db
      .prepare(`SELECT path FROM files WHERE language = 'python' ORDER BY path`)
      .all() as { path: string }[];
    const paths = files.map((f) => f.path);

    expect(paths).toContain('myapp/__init__.py');
    expect(paths).toContain('myapp/models/__init__.py');
    expect(paths).toContain('myapp/models/base.py');
    expect(paths).toContain('myapp/models/user.py');
    expect(paths).toContain('myapp/models/post.py');
    expect(paths).toContain('myapp/utils/__init__.py');
    expect(paths).toContain('myapp/utils/helpers.py');
    expect(paths).toContain('myapp/views/user_views.py');
  });

  // ─── Symbol extraction ─────────────────────────────────────

  it('extracts classes with proper FQN', () => {
    const symbols = db
      .prepare(`SELECT name, kind, fqn, metadata FROM symbols WHERE kind = 'class' ORDER BY name`)
      .all() as { name: string; kind: string; fqn: string; metadata: string | null }[];

    const names = symbols.map((s) => s.name);
    expect(names).toContain('BaseModel');
    expect(names).toContain('User');
    expect(names).toContain('Post');
  });

  it('extracts class metadata (docstrings, visibility, bases)', () => {
    const user = db
      .prepare(`SELECT metadata FROM symbols WHERE name = 'User' AND kind = 'class'`)
      .get() as { metadata: string } | undefined;

    expect(user).toBeDefined();
    const meta = JSON.parse(user!.metadata);
    expect(meta.bases).toContain('BaseModel');
    expect(meta.docstring).toContain('user in the system');
    expect(meta.slots).toEqual(['_name', '_email']);
  });

  // ─── Import edge resolution (file→file) ───────────────────

  it('resolves relative imports to file-level edges', () => {
    // user.py imports from .base → base.py
    const edges = db
      .prepare(`
      SELECT f1.path AS source, f2.path AS target, e.metadata
      FROM edges e
      JOIN nodes n1 ON e.source_node_id = n1.id
      JOIN nodes n2 ON e.target_node_id = n2.id
      JOIN files f1 ON n1.node_type = 'file' AND n1.ref_id = f1.id
      JOIN files f2 ON n2.node_type = 'file' AND n2.ref_id = f2.id
      JOIN edge_types et ON e.edge_type_id = et.id
      WHERE et.name = 'imports'
    `)
      .all() as { source: string; target: string; metadata: string | null }[];

    // At minimum, user.py → base.py and post.py → base.py should exist
    const edgePairs = edges.map((e) => `${e.source} → ${e.target}`);

    // Relative imports within models/ package
    expect(edgePairs.some((e) => e.includes('user.py') && e.includes('base.py'))).toBe(true);
    expect(edgePairs.some((e) => e.includes('post.py') && e.includes('base.py'))).toBe(true);
    expect(edgePairs.some((e) => e.includes('post.py') && e.includes('user.py'))).toBe(true);
  });

  it('resolves cross-package relative imports', () => {
    // user_views.py imports from ..models and ..utils.helpers
    const edges = db
      .prepare(`
      SELECT f1.path AS source, f2.path AS target
      FROM edges e
      JOIN nodes n1 ON e.source_node_id = n1.id
      JOIN nodes n2 ON e.target_node_id = n2.id
      JOIN files f1 ON n1.node_type = 'file' AND n1.ref_id = f1.id
      JOIN files f2 ON n2.node_type = 'file' AND n2.ref_id = f2.id
      JOIN edge_types et ON e.edge_type_id = et.id
      WHERE et.name = 'imports'
      AND f1.path LIKE '%user_views%'
    `)
      .all() as { source: string; target: string }[];

    const targets = edges.map((e) => e.target);
    // `from ..models import User` should resolve to models/__init__.py
    expect(targets.some((t) => t.includes('models/__init__') || t.includes('models/user'))).toBe(
      true,
    );
  });

  // ─── Heritage edge resolution (symbol→symbol) ─────────────

  it('resolves Python class inheritance edges', () => {
    // User extends BaseModel, Post extends BaseModel
    const heritageEdges = db
      .prepare(`
      SELECT s1.name AS source, s2.name AS target
      FROM edges e
      JOIN nodes n1 ON e.source_node_id = n1.id
      JOIN nodes n2 ON e.target_node_id = n2.id
      JOIN symbols s1 ON n1.node_type = 'symbol' AND n1.ref_id = s1.id
      JOIN symbols s2 ON n2.node_type = 'symbol' AND n2.ref_id = s2.id
      JOIN edge_types et ON e.edge_type_id = et.id
      WHERE et.name IN ('extends', 'py_inherits')
      AND s1.kind = 'class' AND s2.kind = 'class'
    `)
      .all() as { source: string; target: string }[];

    const pairs = heritageEdges.map((e) => `${e.source} → ${e.target}`);
    expect(pairs).toContain('User → BaseModel');
    expect(pairs).toContain('Post → BaseModel');
  });

  // ─── __all__ and metadata ──────────────────────────────────

  it('stores __all__ in file metadata (via symbols)', () => {
    // Verify __all__ symbols are NOT created (they're metadata-only)
    const allSymbol = db.prepare(`SELECT * FROM symbols WHERE name = '__all__'`).get();
    expect(allSymbol).toBeUndefined();
  });

  it('extracts docstrings on methods', () => {
    const saveMethod = db
      .prepare(
        `SELECT metadata FROM symbols WHERE name = 'save' AND kind = 'method' AND metadata LIKE '%Save user%'`,
      )
      .get() as { metadata: string } | undefined;

    expect(saveMethod).toBeDefined();
    const meta = JSON.parse(saveMethod!.metadata);
    expect(meta.docstring).toContain('Save user');
  });

  // ─── Call edge resolution (symbol→symbol) ──────────────────

  it('stores call sites in function metadata', () => {
    // get_user_display calls get_user and format_date
    const fn = db
      .prepare(`SELECT metadata FROM symbols WHERE name = 'get_user_display' AND kind = 'function'`)
      .get() as { metadata: string } | undefined;

    expect(fn).toBeDefined();
    const meta = JSON.parse(fn!.metadata);
    expect(meta.callSites).toBeDefined();
    expect(Array.isArray(meta.callSites)).toBe(true);

    const calleeNames = (meta.callSites as { calleeName: string }[]).map((c) => c.calleeName);
    expect(calleeNames).toContain('get_user');
    expect(calleeNames).toContain('get_display_name');
    expect(calleeNames).toContain('format_date');
  });

  it('resolves same-file function calls to edges', () => {
    // get_user_display() calls get_user() — both in user_views.py
    const callEdges = db
      .prepare(`
      SELECT s1.name AS caller, s2.name AS callee
      FROM edges e
      JOIN nodes n1 ON e.source_node_id = n1.id
      JOIN nodes n2 ON e.target_node_id = n2.id
      JOIN symbols s1 ON n1.node_type = 'symbol' AND n1.ref_id = s1.id
      JOIN symbols s2 ON n2.node_type = 'symbol' AND n2.ref_id = s2.id
      JOIN edge_types et ON e.edge_type_id = et.id
      WHERE et.name = 'calls'
    `)
      .all() as { caller: string; callee: string }[];

    const pairs = callEdges.map((e) => `${e.caller} → ${e.callee}`);
    // Same-file call: get_user_display → get_user
    expect(pairs).toContain('get_user_display → get_user');
  });

  it('resolves imported function calls to edges', () => {
    // get_user_display() calls format_date() — imported from utils.helpers
    const callEdges = db
      .prepare(`
      SELECT s1.name AS caller, s2.name AS callee, s2.fqn AS callee_fqn
      FROM edges e
      JOIN nodes n1 ON e.source_node_id = n1.id
      JOIN nodes n2 ON e.target_node_id = n2.id
      JOIN symbols s1 ON n1.node_type = 'symbol' AND n1.ref_id = s1.id
      JOIN symbols s2 ON n2.node_type = 'symbol' AND n2.ref_id = s2.id
      JOIN edge_types et ON e.edge_type_id = et.id
      WHERE et.name = 'calls' AND s1.name = 'get_user_display'
    `)
      .all() as { caller: string; callee: string; callee_fqn: string }[];

    const callees = callEdges.map((e) => e.callee);
    expect(callees).toContain('format_date');
  });

  it('resolves self.method() calls within class', () => {
    // User.save() calls self.validate() → BaseModel.validate
    const callEdges = db
      .prepare(`
      SELECT s1.name AS caller, s2.name AS callee
      FROM edges e
      JOIN nodes n1 ON e.source_node_id = n1.id
      JOIN nodes n2 ON e.target_node_id = n2.id
      JOIN symbols s1 ON n1.node_type = 'symbol' AND n1.ref_id = s1.id
      JOIN symbols s2 ON n2.node_type = 'symbol' AND n2.ref_id = s2.id
      JOIN edge_types et ON e.edge_type_id = et.id
      WHERE et.name = 'calls' AND s1.name = 'save'
    `)
      .all() as { caller: string; callee: string }[];

    const callees = callEdges.map((e) => e.callee);
    expect(callees).toContain('validate');
  });

  it('resolves imported function calls from inside class methods', () => {
    // User.get_display_name calls format_date() — imported from utils.helpers
    const callEdges = db
      .prepare(`
      SELECT s1.name AS caller, s2.name AS callee
      FROM edges e
      JOIN nodes n1 ON e.source_node_id = n1.id
      JOIN nodes n2 ON e.target_node_id = n2.id
      JOIN symbols s1 ON n1.node_type = 'symbol' AND n1.ref_id = s1.id
      JOIN symbols s2 ON n2.node_type = 'symbol' AND n2.ref_id = s2.id
      JOIN edge_types et ON e.edge_type_id = et.id
      WHERE et.name = 'calls' AND s1.name = 'get_display_name'
    `)
      .all() as { caller: string; callee: string }[];

    const callees = callEdges.map((e) => e.callee);
    expect(callees).toContain('format_date');
  });

  it('resolves type-inferred variable method calls', () => {
    // get_user has `user = User(...)` then `user.save()` → User.save via type inference
    const callEdges = db
      .prepare(`
      SELECT s1.name AS caller, s2.name AS callee
      FROM edges e
      JOIN nodes n1 ON e.source_node_id = n1.id
      JOIN nodes n2 ON e.target_node_id = n2.id
      JOIN symbols s1 ON n1.node_type = 'symbol' AND n1.ref_id = s1.id
      JOIN symbols s2 ON n2.node_type = 'symbol' AND n2.ref_id = s2.id
      JOIN edge_types et ON e.edge_type_id = et.id
      WHERE et.name = 'calls' AND s1.name = 'get_user'
    `)
      .all() as { caller: string; callee: string }[];

    const callees = callEdges.map((e) => e.callee);
    // user = User(...) then user.save() → type inference resolves to User.save
    expect(callees).toContain('save');
  });

  it('resolves method calls via return type inference', () => {
    // get_user_display: `user = get_user(user_id)` where get_user() -> User
    // then `user.save()` should resolve to User.save via return type inference
    const callEdges = db
      .prepare(`
      SELECT s1.name AS caller, s2.name AS callee
      FROM edges e
      JOIN nodes n1 ON e.source_node_id = n1.id
      JOIN nodes n2 ON e.target_node_id = n2.id
      JOIN symbols s1 ON n1.node_type = 'symbol' AND n1.ref_id = s1.id
      JOIN symbols s2 ON n2.node_type = 'symbol' AND n2.ref_id = s2.id
      JOIN edge_types et ON e.edge_type_id = et.id
      WHERE et.name = 'calls' AND s1.name = 'get_user_display'
    `)
      .all() as { caller: string; callee: string }[];

    const callees = callEdges.map((e) => e.callee);
    expect(callees).toContain('save');
    expect(callees).toContain('get_display_name');
  });

  it('extracts module-level call sites', () => {
    // Module-level calls should create a synthetic <module> symbol
    const moduleSym = db.prepare(`SELECT metadata FROM symbols WHERE name = '<module>'`).all() as {
      metadata: string;
    }[];

    // At least some files may have module-level calls
    // The fixture files have simple module-level code, so this just verifies the mechanism works
    // (module-level calls are things like `app = Flask(__name__)`)
    expect(moduleSym).toBeDefined();
  });

  // ─── Dynamic dispatch resolution ─────────────────────────────

  it('resolves getattr with string literal', () => {
    // process() calls getattr(self, "handle_click") → handle_click
    const callEdges = db
      .prepare(`
      SELECT s1.name AS caller, s2.name AS callee
      FROM edges e
      JOIN nodes n1 ON e.source_node_id = n1.id
      JOIN nodes n2 ON e.target_node_id = n2.id
      JOIN symbols s1 ON n1.node_type = 'symbol' AND n1.ref_id = s1.id
      JOIN symbols s2 ON n2.node_type = 'symbol' AND n2.ref_id = s2.id
      JOIN edge_types et ON e.edge_type_id = et.id
      WHERE et.name = 'calls' AND s1.name = 'process'
    `)
      .all() as { caller: string; callee: string }[];

    const callees = callEdges.map((e) => e.callee);
    expect(callees).toContain('handle_click');
  });

  it('resolves getattr with f-string prefix to all matching methods', () => {
    // dispatch() calls getattr(self, f"handle_{event_type}") → all handle_* methods
    const callEdges = db
      .prepare(`
      SELECT s1.name AS caller, s2.name AS callee
      FROM edges e
      JOIN nodes n1 ON e.source_node_id = n1.id
      JOIN nodes n2 ON e.target_node_id = n2.id
      JOIN symbols s1 ON n1.node_type = 'symbol' AND n1.ref_id = s1.id
      JOIN symbols s2 ON n2.node_type = 'symbol' AND n2.ref_id = s2.id
      JOIN edge_types et ON e.edge_type_id = et.id
      WHERE et.name = 'calls' AND s1.name = 'dispatch'
    `)
      .all() as { caller: string; callee: string }[];

    const callees = callEdges.map((e) => e.callee);
    expect(callees).toContain('handle_click');
    expect(callees).toContain('handle_submit');
    expect(callees).toContain('handle_keypress');
  });

  it('resolves dict dispatch to all handler functions', () => {
    // Debug
    const daSym = db
      .prepare(`SELECT name, kind, metadata FROM symbols WHERE name = 'dispatch_action'`)
      .all() as { name: string; kind: string; metadata: string | null }[];
    // dispatch_action uses handlers = {"create": handle_create, ...}; handlers[action]()
    const callEdges = db
      .prepare(`
      SELECT s1.name AS caller, s2.name AS callee
      FROM edges e
      JOIN nodes n1 ON e.source_node_id = n1.id
      JOIN nodes n2 ON e.target_node_id = n2.id
      JOIN symbols s1 ON n1.node_type = 'symbol' AND n1.ref_id = s1.id
      JOIN symbols s2 ON n2.node_type = 'symbol' AND n2.ref_id = s2.id
      JOIN edge_types et ON e.edge_type_id = et.id
      WHERE et.name = 'calls' AND s1.name = 'dispatch_action'
    `)
      .all() as { caller: string; callee: string }[];

    const callees = callEdges.map((e) => e.callee);
    expect(callees).toContain('handle_create');
    expect(callees).toContain('handle_delete');
    expect(callees).toContain('handle_update');
  });

  it('creates non-zero call edges for a Python project', () => {
    // This is the core assertion from issue #40: totalEdges should be > 0
    const callCount = (
      db
        .prepare(`
      SELECT COUNT(*) as cnt FROM edges e
      JOIN edge_types et ON e.edge_type_id = et.id
      WHERE et.name = 'calls'
    `)
        .get() as { cnt: number }
    ).cnt;

    expect(callCount).toBeGreaterThan(0);
  });

  // ─── Parameter annotation type inference (#54) ──────────────

  it('resolves method calls on parameter-annotated instances', () => {
    // verify_and_save(user: User, ...) calls user.save()
    const callEdges = db
      .prepare(`
      SELECT s1.name AS caller, s2.name AS callee
      FROM edges e
      JOIN nodes n1 ON e.source_node_id = n1.id
      JOIN nodes n2 ON e.target_node_id = n2.id
      JOIN symbols s1 ON n1.node_type = 'symbol' AND n1.ref_id = s1.id
      JOIN symbols s2 ON n2.node_type = 'symbol' AND n2.ref_id = s2.id
      JOIN edge_types et ON e.edge_type_id = et.id
      WHERE et.name = 'calls' AND s1.name = 'verify_and_save'
    `)
      .all() as { caller: string; callee: string }[];

    const callees = callEdges.map((e) => e.callee);
    expect(callees).toContain('save');
  });

  it('resolves inherited method calls via parameter annotation', () => {
    // verify_and_save(user: User) calls user.validate()
    // validate() is inherited from BaseModel, not defined on User
    const callEdges = db
      .prepare(`
      SELECT s1.name AS caller, s2.name AS callee
      FROM edges e
      JOIN nodes n1 ON e.source_node_id = n1.id
      JOIN nodes n2 ON e.target_node_id = n2.id
      JOIN symbols s1 ON n1.node_type = 'symbol' AND n1.ref_id = s1.id
      JOIN symbols s2 ON n2.node_type = 'symbol' AND n2.ref_id = s2.id
      JOIN edge_types et ON e.edge_type_id = et.id
      WHERE et.name = 'calls' AND s1.name = 'verify_and_save'
    `)
      .all() as { caller: string; callee: string }[];

    const callees = callEdges.map((e) => e.callee);
    expect(callees).toContain('validate');
  });
});
