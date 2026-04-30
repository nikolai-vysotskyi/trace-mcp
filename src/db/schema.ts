import Database from 'better-sqlite3';
import { logger } from '../logger.js';

const SCHEMA_VERSION = 24;

const DDL = `
-- ============================================================
-- UNIFIED ADDRESS SPACE
-- ============================================================

CREATE TABLE IF NOT EXISTS node_types (
    id    INTEGER PRIMARY KEY,
    name  TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS edge_types (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    category    TEXT NOT NULL,
    directed    INTEGER NOT NULL DEFAULT 1,
    description TEXT
);

CREATE TABLE IF NOT EXISTS nodes (
    id          INTEGER PRIMARY KEY,
    node_type   TEXT NOT NULL REFERENCES node_types(name),
    ref_id      INTEGER NOT NULL,
    UNIQUE(node_type, ref_id)
);

-- ============================================================
-- CONCRETE ENTITY TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS files (
    id              INTEGER PRIMARY KEY,
    path            TEXT NOT NULL UNIQUE,
    language        TEXT,
    framework_role  TEXT,
    status          TEXT DEFAULT 'ok',
    content_hash    TEXT,
    byte_length     INTEGER,
    indexed_at      TEXT NOT NULL,
    metadata        TEXT,
    workspace       TEXT,
    gitignored      INTEGER NOT NULL DEFAULT 0,
    mtime_ms        INTEGER
);

CREATE TABLE IF NOT EXISTS symbols (
    id          INTEGER PRIMARY KEY,
    file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    symbol_id   TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL,
    fqn         TEXT,
    parent_id   INTEGER REFERENCES symbols(id),
    signature   TEXT,
    summary     TEXT,
    byte_start  INTEGER NOT NULL,
    byte_end    INTEGER NOT NULL,
    line_start  INTEGER,
    line_end    INTEGER,
    metadata    TEXT,
    cyclomatic  INTEGER,
    max_nesting INTEGER,
    param_count INTEGER
);

CREATE TABLE IF NOT EXISTS routes (
    id                      INTEGER PRIMARY KEY,
    method                  TEXT NOT NULL,
    uri                     TEXT NOT NULL,
    name                    TEXT,
    handler                 TEXT,
    controller_symbol_id    INTEGER REFERENCES symbols(id),
    middleware              TEXT,
    metadata                TEXT,
    file_id                 INTEGER REFERENCES files(id),
    line                    INTEGER
);

CREATE TABLE IF NOT EXISTS components (
    id          INTEGER PRIMARY KEY,
    file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL,
    props       TEXT,
    emits       TEXT,
    slots       TEXT,
    composables TEXT,
    framework   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS migrations (
    id          INTEGER PRIMARY KEY,
    file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    table_name  TEXT NOT NULL,
    operation   TEXT NOT NULL,
    columns     TEXT,
    indices     TEXT,
    timestamp   TEXT
);

-- ============================================================
-- ORM MODELS (Mongoose + Sequelize)
-- ============================================================

CREATE TABLE IF NOT EXISTS orm_models (
    id                  INTEGER PRIMARY KEY,
    file_id             INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    orm                 TEXT NOT NULL,
    collection_or_table TEXT,
    fields              TEXT,
    options             TEXT,
    metadata            TEXT
);

CREATE TABLE IF NOT EXISTS orm_associations (
    id                  INTEGER PRIMARY KEY,
    source_model_id     INTEGER NOT NULL REFERENCES orm_models(id) ON DELETE CASCADE,
    target_model_id     INTEGER REFERENCES orm_models(id),
    target_model_name   TEXT,
    kind                TEXT NOT NULL,
    options             TEXT,
    file_id             INTEGER REFERENCES files(id),
    line                INTEGER
);

-- ============================================================
-- REACT NATIVE SCREENS
-- ============================================================

CREATE TABLE IF NOT EXISTS rn_screens (
    id              INTEGER PRIMARY KEY,
    file_id         INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    component_path  TEXT,
    navigator_type  TEXT,
    options         TEXT,
    deep_link       TEXT,
    metadata        TEXT
);

-- ============================================================
-- ENV VARS (keys only — values are never stored)
-- ============================================================

CREATE TABLE IF NOT EXISTS env_vars (
    id              INTEGER PRIMARY KEY,
    file_id         INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    key             TEXT NOT NULL,
    value_type      TEXT NOT NULL,
    value_format    TEXT,
    comment         TEXT,
    quoted          INTEGER NOT NULL DEFAULT 0,
    line            INTEGER
);

CREATE INDEX IF NOT EXISTS idx_env_vars_file ON env_vars(file_id);
CREATE INDEX IF NOT EXISTS idx_env_vars_key  ON env_vars(key);

-- ============================================================
-- UNIFIED EDGES
-- ============================================================

CREATE TABLE IF NOT EXISTS edges (
    id              INTEGER PRIMARY KEY,
    source_node_id  INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    target_node_id  INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    edge_type_id    INTEGER NOT NULL REFERENCES edge_types(id),
    resolved        INTEGER NOT NULL DEFAULT 1,
    metadata        TEXT,
    is_cross_ws     INTEGER NOT NULL DEFAULT 0,
    resolution_tier TEXT NOT NULL DEFAULT 'ast_resolved',
    UNIQUE(source_node_id, target_node_id, edge_type_id)
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_node_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_node_id);
CREATE INDEX IF NOT EXISTS idx_edges_type   ON edges(edge_type_id);
CREATE INDEX IF NOT EXISTS idx_edges_src_tgt_type ON edges(source_node_id, target_node_id, edge_type_id);
CREATE INDEX IF NOT EXISTS idx_edges_resolution_tier ON edges(resolution_tier);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
CREATE INDEX IF NOT EXISTS idx_symbols_fqn  ON symbols(fqn);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_nodes_type   ON nodes(node_type);
CREATE INDEX IF NOT EXISTS idx_orm_models_name ON orm_models(name);
CREATE INDEX IF NOT EXISTS idx_symbols_has_heritage ON symbols(file_id)
  WHERE metadata IS NOT NULL
    AND (json_extract(metadata, '$.extends') IS NOT NULL
      OR json_extract(metadata, '$.implements') IS NOT NULL);
-- idx_files_workspace and idx_edges_cross_ws created in migration v9

-- ============================================================
-- FTS5 FULL-TEXT SEARCH
-- ============================================================

CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
    name, fqn, signature, summary,
    content=symbols, content_rowid=id
);

-- ============================================================
-- FTS5 TRIGGERS (keep in sync)
-- ============================================================

CREATE TRIGGER IF NOT EXISTS symbols_ai AFTER INSERT ON symbols BEGIN
    INSERT INTO symbols_fts(rowid, name, fqn, signature, summary)
    VALUES (new.id, new.name, new.fqn, new.signature, new.summary);
END;

CREATE TRIGGER IF NOT EXISTS symbols_ad AFTER DELETE ON symbols BEGIN
    INSERT INTO symbols_fts(symbols_fts, rowid, name, fqn, signature, summary)
    VALUES ('delete', old.id, old.name, old.fqn, old.signature, old.summary);
END;

CREATE TRIGGER IF NOT EXISTS symbols_au AFTER UPDATE ON symbols BEGIN
    INSERT INTO symbols_fts(symbols_fts, rowid, name, fqn, signature, summary)
    VALUES ('delete', old.id, old.name, old.fqn, old.signature, old.summary);
    INSERT INTO symbols_fts(rowid, name, fqn, signature, summary)
    VALUES (new.id, new.name, new.fqn, new.signature, new.summary);
END;

-- ============================================================
-- AI EMBEDDINGS (optional, for Phase 7)
-- ============================================================

CREATE TABLE IF NOT EXISTS symbol_embeddings (
    symbol_id INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
    embedding BLOB NOT NULL
);

-- Tracks which embedding model + dimensionality produced the vectors in
-- symbol_embeddings. EmbeddingPipeline checks this on every run; a mismatch
-- with the current AI config triggers reindexAll so we never mix spaces.
CREATE TABLE IF NOT EXISTS embedding_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- ============================================================
-- AI INFERENCE CACHE (optional, for cached summarization)
-- ============================================================

CREATE TABLE IF NOT EXISTS inference_cache (
    cache_key   TEXT PRIMARY KEY,
    model       TEXT NOT NULL,
    prompt_hash TEXT NOT NULL,
    response    TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    ttl_days    INTEGER DEFAULT 90
);
CREATE INDEX IF NOT EXISTS idx_inference_cache_model ON inference_cache(model);

-- ============================================================
-- GRAPH SNAPSHOTS (Time Machine)
-- ============================================================

CREATE TABLE IF NOT EXISTS graph_snapshots (
    id              INTEGER PRIMARY KEY,
    commit_hash     TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    snapshot_type   TEXT NOT NULL,
    file_path       TEXT,
    data            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gs_type ON graph_snapshots(snapshot_type);
CREATE INDEX IF NOT EXISTS idx_gs_commit ON graph_snapshots(commit_hash);
CREATE INDEX IF NOT EXISTS idx_gs_file ON graph_snapshots(file_path);
CREATE INDEX IF NOT EXISTS idx_gs_created ON graph_snapshots(created_at);

-- ============================================================
-- TRIGRAM INDEX (fuzzy search)
-- ============================================================

CREATE TABLE IF NOT EXISTS symbol_trigrams (
    symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
    trigram   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trigrams_tri ON symbol_trigrams(trigram);
CREATE INDEX IF NOT EXISTS idx_trigrams_sym ON symbol_trigrams(symbol_id);

-- ============================================================
-- CO-CHANGE ANALYSIS (git temporal coupling)
-- ============================================================

CREATE TABLE IF NOT EXISTS co_changes (
    file_a TEXT NOT NULL,
    file_b TEXT NOT NULL,
    co_change_count INTEGER NOT NULL,
    total_changes_a INTEGER NOT NULL,
    total_changes_b INTEGER NOT NULL,
    confidence REAL NOT NULL,
    last_co_change TEXT,
    window_days INTEGER NOT NULL DEFAULT 180,
    PRIMARY KEY (file_a, file_b)
);
CREATE INDEX IF NOT EXISTS idx_co_changes_a ON co_changes(file_a);
CREATE INDEX IF NOT EXISTS idx_co_changes_b ON co_changes(file_b);

-- ============================================================
-- COMMUNITY DETECTION (Leiden algorithm)
-- ============================================================

CREATE TABLE IF NOT EXISTS communities (
    id INTEGER PRIMARY KEY,
    label TEXT,
    file_count INTEGER,
    cohesion REAL,
    internal_edges INTEGER,
    external_edges INTEGER,
    computed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS community_members (
    community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    PRIMARY KEY (community_id, file_path)
);
CREATE INDEX IF NOT EXISTS idx_cm_community ON community_members(community_id);

-- ============================================================
-- PROGRESS & SERVER STATE
-- ============================================================

CREATE TABLE IF NOT EXISTS indexing_progress (
    pipeline TEXT PRIMARY KEY,
    phase TEXT NOT NULL DEFAULT 'idle',
    processed INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL DEFAULT 0,
    completed_at INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS server_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- ============================================================
-- SCHEMA VERSION
-- ============================================================

CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Applied migration log (one row per migration that has been run)
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    applied_at  TEXT NOT NULL
);

-- Repo-level metadata (git HEAD at index time, etc.). Distinct from schema_meta
-- which is purely about schema version management.
CREATE TABLE IF NOT EXISTS repo_metadata (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`;

const SEED_NODE_TYPES = [
  'symbol',
  'file',
  'route',
  'component',
  'migration',
  'orm_model',
  'rn_screen',
  'service',
];

const SEED_EDGE_TYPES = [
  // Core edges (added in v2 migration, must also be in seed for fresh DBs)
  { name: 'calls', category: 'core', description: 'Direct function/method call' },
  { name: 'instantiates', category: 'core', description: 'Class instantiation via `new`' },
  { name: 'accesses_property', category: 'core', description: 'Property read/write' },
  {
    name: 'accesses_constant',
    category: 'core',
    description: 'Class constant or enum case access',
  },
  {
    name: 'member_of',
    category: 'core',
    description: 'Symbol is a member of a container (method/property of class, case of enum)',
  },
  { name: 'references', category: 'core', description: 'Symbol reference (read/write)' },
  {
    name: 'embeds',
    category: 'markdown',
    description: 'Markdown embed (![[X]]) — note transcludes another note',
  },
  {
    name: 'tagged',
    category: 'markdown',
    description: 'Note is tagged with a #tag (frontmatter or inline)',
  },
  { name: 'unresolved', category: 'core', description: 'Phantom edge for unresolved targets' },
  { name: 'test_covers', category: 'core', description: 'Test file covers a symbol or file' },
  { name: 'esm_imports', category: 'core', description: 'ESM import (file→file)' },
  {
    name: 'graphql_resolves',
    category: 'graphql',
    description: 'Resolver implements a GraphQL field',
  },
  {
    name: 'graphql_references_type',
    category: 'graphql',
    description: 'Resolver/field references a GraphQL type',
  },
  // PHP language edges
  { name: 'imports', category: 'php', description: 'PHP use/import statement' },
  { name: 'extends', category: 'php', description: 'Class/interface extends' },
  { name: 'implements', category: 'php', description: 'Class implements interface' },
  { name: 'uses_trait', category: 'php', description: 'Class uses trait' },
  // TypeScript language edges
  { name: 'ts_extends', category: 'typescript', description: 'TypeScript class/interface extends' },
  {
    name: 'ts_implements',
    category: 'typescript',
    description: 'TypeScript class implements interface',
  },
  // Laravel framework edges
  { name: 'routes_to', category: 'laravel', description: 'Route -> Controller' },
  { name: 'has_many', category: 'laravel', description: 'Eloquent hasMany' },
  { name: 'belongs_to', category: 'laravel', description: 'Eloquent belongsTo' },
  { name: 'belongs_to_many', category: 'laravel', description: 'Eloquent belongsToMany' },
  { name: 'has_one', category: 'laravel', description: 'Eloquent hasOne' },
  { name: 'morphs_to', category: 'laravel', description: 'Eloquent morphTo' },
  { name: 'validates_with', category: 'laravel', description: 'Controller -> FormRequest' },
  { name: 'dispatches', category: 'laravel', description: 'Dispatches event/job' },
  { name: 'listens_to', category: 'laravel', description: 'Listener -> Event' },
  { name: 'middleware_guards', category: 'laravel', description: 'Route -> Middleware' },
  { name: 'migrates', category: 'laravel', description: 'Migration -> table' },
  // Vue framework edges
  {
    name: 'renders_component',
    category: 'vue',
    description: 'Parent component renders child in template',
  },
  {
    name: 'uses_composable',
    category: 'vue',
    description: 'Component calls a composable function',
  },
  { name: 'provides_slot', category: 'vue', description: 'Component provides a named slot' },
  // Inertia edges
  {
    name: 'inertia_renders',
    category: 'inertia',
    description: 'Controller renders Vue page via Inertia',
  },
  { name: 'passes_props', category: 'inertia', description: 'Controller passes props to Vue page' },
  // Nuxt edges
  { name: 'nuxt_auto_imports', category: 'nuxt', description: 'Auto-imported composable' },
  { name: 'api_calls', category: 'nuxt', description: 'fetch/useFetch API call' },
  {
    name: 'nuxt_shared_import',
    category: 'nuxt',
    description: 'Auto-imported shared utility or type',
  },
  // Blade edges
  { name: 'blade_extends', category: 'blade', description: '@extends directive' },
  { name: 'blade_includes', category: 'blade', description: '@include directive' },
  { name: 'blade_component', category: 'blade', description: '<x-component> or @component' },
  {
    name: 'uses_asset',
    category: 'blade',
    description: '<script src> / <link href> asset reference',
  },
  // Nova edges
  { name: 'nova_resource_for', category: 'nova', description: 'Nova Resource → Eloquent Model' },
  {
    name: 'nova_field_relationship',
    category: 'nova',
    description: 'Nova Resource → related Nova Resource via field',
  },
  { name: 'nova_action_on', category: 'nova', description: 'Action → Resource' },
  { name: 'nova_filter_on', category: 'nova', description: 'Filter → Resource' },
  { name: 'nova_lens_on', category: 'nova', description: 'Lens → Resource' },
  { name: 'nova_metric_queries', category: 'nova', description: 'Metric → Eloquent Model' },
  // Filament edges
  { name: 'filament_resource_for', category: 'filament', description: 'Resource → Eloquent Model' },
  {
    name: 'filament_relation_manager',
    category: 'filament',
    description: 'Resource → RelationManager',
  },
  {
    name: 'filament_form_relationship',
    category: 'filament',
    description: 'Form field →relationship() → Model',
  },
  { name: 'filament_page_for', category: 'filament', description: 'Page registered on Resource' },
  {
    name: 'filament_panel_registers',
    category: 'filament',
    description: 'PanelProvider → Resource/Page/Widget',
  },
  { name: 'filament_widget_queries', category: 'filament', description: 'Widget → Eloquent Model' },
  // Livewire edges
  { name: 'livewire_renders', category: 'livewire', description: 'Component class → Blade view' },
  { name: 'livewire_dispatches', category: 'livewire', description: 'Component dispatches event' },
  { name: 'livewire_listens', category: 'livewire', description: 'Component listens for event' },
  {
    name: 'livewire_child_of',
    category: 'livewire',
    description: 'Blade <livewire:child/> → Component',
  },
  { name: 'livewire_uses_model', category: 'livewire', description: 'Component → Eloquent Model' },
  { name: 'livewire_form', category: 'livewire', description: 'Component → Form class (v3)' },
  { name: 'livewire_action', category: 'livewire', description: 'wire:click → Component method' },
  // NestJS edges
  { name: 'nest_module_imports', category: 'nestjs', description: 'Module imports another module' },
  { name: 'nest_provides', category: 'nestjs', description: 'Module provides a service' },
  { name: 'nest_injects', category: 'nestjs', description: 'Constructor dependency injection' },
  { name: 'nest_guards', category: 'nestjs', description: 'UseGuards on controller/method' },
  { name: 'nest_pipes', category: 'nestjs', description: 'UsePipes on controller/method' },
  {
    name: 'nest_interceptors',
    category: 'nestjs',
    description: 'UseInterceptors on controller/method',
  },
  {
    name: 'nest_gateway_event',
    category: 'nestjs',
    description: 'WebSocket gateway @SubscribeMessage handler',
  },
  {
    name: 'nest_message_pattern',
    category: 'nestjs',
    description: 'Microservice @MessagePattern handler',
  },
  {
    name: 'nest_event_pattern',
    category: 'nestjs',
    description: 'Microservice @EventPattern handler',
  },
  // Next.js edges
  {
    name: 'next_entry_point',
    category: 'nextjs',
    description:
      'Next.js file-based auto-loaded entry point (page, layout, route, loading, error, metadata files, etc.)',
  },
  { name: 'next_renders_page', category: 'nextjs', description: 'Layout renders page' },
  {
    name: 'next_renders_loading',
    category: 'nextjs',
    description: 'Layout renders loading boundary',
  },
  { name: 'next_renders_error', category: 'nextjs', description: 'Layout renders error boundary' },
  {
    name: 'next_renders_not_found',
    category: 'nextjs',
    description: 'Layout renders not-found boundary',
  },
  { name: 'next_server_action', category: 'nextjs', description: 'Server action reference' },
  { name: 'next_middleware', category: 'nextjs', description: 'Middleware applies to routes' },
  { name: 'next_parallel_slot', category: 'nextjs', description: 'Parallel route slot' },
  { name: 'next_intercepting', category: 'nextjs', description: 'Intercepting route' },
  {
    name: 'next_data_fetching',
    category: 'nextjs',
    description: 'Pages Router data fetching function',
  },
  {
    name: 'next_template',
    category: 'nextjs',
    description: 'Template component for route segment',
  },
  // Express edges
  { name: 'express_route', category: 'express', description: 'Express route handler' },
  { name: 'express_middleware', category: 'express', description: 'Express middleware' },
  { name: 'express_mounts', category: 'express', description: 'Router mount via app.use' },
  {
    name: 'express_error_handler',
    category: 'express',
    description: '4-arg error handling middleware',
  },
  {
    name: 'express_param_handler',
    category: 'express',
    description: 'app.param() route parameter handler',
  },
  // Mongoose edges
  {
    name: 'mongoose_references',
    category: 'mongoose',
    description: 'ObjectId ref to another model',
  },
  { name: 'mongoose_has_virtual', category: 'mongoose', description: 'Schema virtual field' },
  { name: 'mongoose_has_middleware', category: 'mongoose', description: 'Schema pre/post hook' },
  { name: 'mongoose_has_method', category: 'mongoose', description: 'Schema instance method' },
  { name: 'mongoose_has_static', category: 'mongoose', description: 'Schema static method' },
  { name: 'mongoose_discriminates', category: 'mongoose', description: 'Model discriminator' },
  { name: 'mongoose_has_index', category: 'mongoose', description: 'Schema index' },
  { name: 'mongoose_uses_plugin', category: 'mongoose', description: 'Schema plugin' },
  // Sequelize edges
  {
    name: 'sequelize_has_many',
    category: 'sequelize',
    description: 'Sequelize hasMany association',
  },
  {
    name: 'sequelize_belongs_to',
    category: 'sequelize',
    description: 'Sequelize belongsTo association',
  },
  {
    name: 'sequelize_belongs_to_many',
    category: 'sequelize',
    description: 'Sequelize belongsToMany association',
  },
  { name: 'sequelize_has_one', category: 'sequelize', description: 'Sequelize hasOne association' },
  { name: 'sequelize_has_hook', category: 'sequelize', description: 'Sequelize lifecycle hook' },
  { name: 'sequelize_has_scope', category: 'sequelize', description: 'Sequelize named scope' },
  {
    name: 'sequelize_migrates',
    category: 'sequelize',
    description: 'Migration changes table schema',
  },
  // React Native edges
  {
    name: 'rn_navigates_to',
    category: 'react-native',
    description: 'navigation.navigate() to screen',
  },
  {
    name: 'rn_screen_in_navigator',
    category: 'react-native',
    description: 'Screen registered in navigator',
  },
  {
    name: 'rn_uses_native_module',
    category: 'react-native',
    description: 'Uses NativeModules/TurboModuleRegistry',
  },
  {
    name: 'rn_platform_specific',
    category: 'react-native',
    description: 'Platform-specific file variant',
  },
  { name: 'rn_deep_links_to', category: 'react-native', description: 'Deep link maps to screen' },
  { name: 'expo_route', category: 'expo-router', description: 'Expo Router file-based route' },
  { name: 'expo_layout', category: 'expo-router', description: 'Expo Router layout file' },
  // Python language edges
  { name: 'py_imports', category: 'python', description: 'Python import statement' },
  { name: 'py_reexports', category: 'python', description: '__init__.py re-export' },
  { name: 'py_param_type', category: 'python', description: 'Function parameter type annotation' },
  { name: 'py_return_type', category: 'python', description: 'Function return type annotation' },
  { name: 'py_inherits', category: 'python', description: 'Class inheritance' },
  { name: 'py_uses_decorator', category: 'python', description: 'Function/class uses decorator' },
  // pytest edges
  {
    name: 'pytest_fixture_used',
    category: 'pytest',
    description: 'Test function uses a pytest fixture',
  },
  {
    name: 'pytest_parametrize',
    category: 'pytest',
    description: 'Test parametrized with @pytest.mark.parametrize',
  },
  // Django edges
  { name: 'django_url_routes_to', category: 'django', description: 'URL pattern routes to view' },
  { name: 'django_includes_urls', category: 'django', description: 'include() sub-URL config' },
  { name: 'django_view_uses_model', category: 'django', description: 'View references model' },
  { name: 'django_view_template', category: 'django', description: 'View renders template' },
  { name: 'django_signal_receiver', category: 'django', description: '@receiver signal handler' },
  { name: 'django_admin_registers', category: 'django', description: 'Admin registers model' },
  { name: 'django_form_meta_model', category: 'django', description: 'ModelForm Meta.model' },
  { name: 'django_migrates', category: 'django', description: 'Django migration operation' },
  // FastAPI edges
  { name: 'fastapi_route', category: 'fastapi', description: 'FastAPI route decorator' },
  { name: 'fastapi_depends', category: 'fastapi', description: 'Depends() dependency injection' },
  {
    name: 'fastapi_request_model',
    category: 'fastapi',
    description: 'Request body Pydantic model',
  },
  { name: 'fastapi_response_model', category: 'fastapi', description: 'response_model parameter' },
  { name: 'fastapi_router_mounts', category: 'fastapi', description: 'include_router() mount' },
  // Flask edges
  { name: 'flask_route', category: 'flask', description: 'Flask @app.route decorator' },
  { name: 'flask_blueprint_mounts', category: 'flask', description: 'register_blueprint() mount' },
  { name: 'flask_before_request', category: 'flask', description: '@before_request hook' },
  { name: 'flask_error_handler', category: 'flask', description: '@errorhandler hook' },
  // SQLAlchemy edges
  { name: 'sqla_relationship', category: 'sqlalchemy', description: 'SQLAlchemy relationship()' },
  { name: 'sqla_fk', category: 'sqlalchemy', description: 'ForeignKey reference' },
  { name: 'sqla_migrates', category: 'sqlalchemy', description: 'Alembic migration operation' },
  // DRF edges
  { name: 'drf_serializer_model', category: 'drf', description: 'ModelSerializer Meta.model' },
  { name: 'drf_viewset_serializer', category: 'drf', description: 'ViewSet serializer_class' },
  { name: 'drf_router_registers', category: 'drf', description: 'router.register() ViewSet' },
  { name: 'drf_permission_guards', category: 'drf', description: 'permission_classes on ViewSet' },
  // Pydantic edges
  {
    name: 'pydantic_field_type',
    category: 'pydantic',
    description: 'BaseModel field type reference',
  },
  {
    name: 'pydantic_from_orm',
    category: 'pydantic',
    description: 'Model with from_attributes → ORM model',
  },
  // Async DB edges (asyncpg, databases, aiosqlite, psycopg, tortoise-orm)
  { name: 'async_db_query', category: 'async-db', description: 'Async DB query (SELECT/fetch)' },
  {
    name: 'async_db_mutation',
    category: 'async-db',
    description: 'Async DB mutation (INSERT/UPDATE/DELETE)',
  },
  {
    name: 'async_db_schema',
    category: 'async-db',
    description: 'Async DB DDL (CREATE/ALTER/DROP)',
  },
  { name: 'async_db_pool', category: 'async-db', description: 'Connection pool creation' },
  { name: 'tortoise_model_op', category: 'async-db', description: 'Tortoise ORM model operation' },
  // Celery edges
  {
    name: 'celery_task_registered',
    category: 'celery',
    description: '@app.task / @shared_task registration',
  },
  { name: 'celery_beat_schedule', category: 'celery', description: 'Beat schedule task entry' },
  {
    name: 'celery_dispatches',
    category: 'celery',
    description: '.delay() / .apply_async() dispatch',
  },
  // Pennant (feature flags) edges
  {
    name: 'feature_defined_in',
    category: 'pennant',
    description: 'Feature flag defined via Feature::define()',
  },
  {
    name: 'feature_checked_by',
    category: 'pennant',
    description: 'Feature flag checked in PHP/Blade',
  },
  {
    name: 'feature_gates_route',
    category: 'pennant',
    description: 'Route protected by features middleware',
  },
  // Broadcasting / Reverb edges
  { name: 'broadcasts_on', category: 'broadcasting', description: 'Event broadcasts on a channel' },
  {
    name: 'channel_authorized_by',
    category: 'broadcasting',
    description: 'Channel authorization callback or class',
  },
  { name: 'broadcast_as', category: 'broadcasting', description: 'Event broadcast name override' },
  // laravel-data edges
  {
    name: 'data_wraps',
    category: 'laravel-data',
    description: 'Data class wraps an Eloquent model',
  },
  {
    name: 'data_property_type',
    category: 'laravel-data',
    description: 'Data class property references another Data class',
  },
  {
    name: 'data_collection',
    category: 'laravel-data',
    description: 'DataCollection<T> references a Data class',
  },
  // State management (Zustand / Redux Toolkit)
  { name: 'zustand_store', category: 'state-management', description: 'Zustand store definition' },
  {
    name: 'redux_slice',
    category: 'state-management',
    description: 'Redux Toolkit slice definition',
  },
  {
    name: 'dispatches_action',
    category: 'state-management',
    description: 'Component dispatches a Redux/Zustand action',
  },
  {
    name: 'selects_state',
    category: 'state-management',
    description: 'Component selects state from store',
  },
  // tRPC edges
  { name: 'trpc_procedure', category: 'trpc', description: 'Procedure defined in router' },
  // Fastify edges
  { name: 'fastify_route', category: 'fastify', description: 'Route handler' },
  { name: 'fastify_hook', category: 'fastify', description: 'Lifecycle hook' },
  { name: 'fastify_plugin', category: 'fastify', description: 'Plugin registration' },
  // Socket.io edges
  { name: 'socketio_event', category: 'socketio', description: 'Event listener/emitter' },
  { name: 'socketio_namespace', category: 'socketio', description: 'Namespace definition' },
  // React (standalone) edges
  {
    name: 'react_renders',
    category: 'react',
    description: 'Parent component renders child via JSX',
  },
  { name: 'react_context_provides', category: 'react', description: 'Context.Provider usage' },
  { name: 'react_context_consumes', category: 'react', description: 'useContext() or use() call' },
  { name: 'react_lazy_loads', category: 'react', description: 'React.lazy(() => import("./X"))' },
  {
    name: 'react_custom_hook_uses',
    category: 'react',
    description: 'Component calls a custom hook',
  },
  { name: 'react_use_client', category: 'react', description: "'use client' directive (React 19)" },
  { name: 'react_use_server', category: 'react', description: "'use server' directive (React 19)" },
  // Hono edges
  { name: 'hono_route', category: 'hono', description: 'Hono route handler' },
  { name: 'hono_middleware', category: 'hono', description: 'Hono middleware usage' },
  // Data fetching (React Query / SWR) edges
  {
    name: 'fetches_endpoint',
    category: 'data-fetching',
    description: 'useQuery/useSWR call referencing an API endpoint',
  },
  // Zod edges
  { name: 'zod_schema', category: 'zod', description: 'Zod schema definition' },
  // Testing framework edges
  {
    name: 'test_covers_route',
    category: 'testing',
    description: 'Test file visits/requests an API route',
  },
  {
    name: 'test_covers_component',
    category: 'testing',
    description: 'Test file mounts/renders a component',
  },
  {
    name: 'test_imports_module',
    category: 'testing',
    description: 'Test file imports the module under test',
  },
  // Workspace edges
  { name: 'workspace_import', category: 'workspace', description: 'Cross-workspace import' },
  { name: 'api_call', category: 'workspace', description: 'Cross-workspace API call' },
  { name: 'type_import', category: 'workspace', description: 'Cross-workspace type import' },
  // Runtime Intelligence edges (from OTel traces)
  {
    name: 'runtime_calls',
    category: 'runtime',
    description: 'Observed runtime call between symbols',
  },
  {
    name: 'runtime_routes_to',
    category: 'runtime',
    description: 'Observed HTTP request to route handler',
  },
  {
    name: 'runtime_queries',
    category: 'runtime',
    description: 'Runtime DB query from code to database service',
  },
  {
    name: 'runtime_calls_service',
    category: 'runtime',
    description: 'Runtime call to external service',
  },
  {
    name: 'runtime_publishes',
    category: 'runtime',
    description: 'Runtime message publish to queue/topic',
  },
  {
    name: 'runtime_consumes',
    category: 'runtime',
    description: 'Runtime message consumption from queue/topic',
  },
];

/**
 * Incremental migrations, keyed by target schema version.
 * Each entry runs exactly once, in version order.
 * Add new entries here whenever the schema changes.
 */
const MIGRATIONS: Record<number, (db: Database.Database) => void> = {
  2: (db) => {
    // v2: add schema_migrations table (already in DDL via CREATE TABLE IF NOT EXISTS,
    // but mark it as applied for all future installs)
    db.exec(`
      INSERT OR IGNORE INTO edge_types (name, category, directed, description)
      VALUES
        ('calls',         'core', 1, 'Direct function/method call'),
        ('references',    'core', 1, 'Symbol reference (read/write)'),
        ('test_covers',   'core', 1, 'Test file covers a symbol or file'),
        ('graphql_resolves', 'graphql', 1, 'Resolver implements a GraphQL field'),
        ('graphql_references_type', 'graphql', 1, 'Resolver/field references a GraphQL type');
    `);
  },
  3: (db) => {
    // v3: TypeScript heritage edges — enables find_usages for extends/implements
    db.exec(`
      INSERT OR IGNORE INTO edge_types (name, category, directed, description)
      VALUES
        ('ts_extends',    'typescript', 1, 'TypeScript class/interface extends'),
        ('ts_implements', 'typescript', 1, 'TypeScript class implements interface');
    `);
  },
  4: (db) => {
    // v4: AI inference cache for summarization pipeline
    db.exec(`
      CREATE TABLE IF NOT EXISTS inference_cache (
        cache_key   TEXT PRIMARY KEY,
        model       TEXT NOT NULL,
        prompt_hash TEXT NOT NULL,
        response    TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        ttl_days    INTEGER DEFAULT 90
      );
      CREATE INDEX IF NOT EXISTS idx_inference_cache_model ON inference_cache(model);
    `);
  },
  5: (db) => {
    // v5: env_vars table — stores .env keys with type metadata, never stores values
    db.exec(`
      CREATE TABLE IF NOT EXISTS env_vars (
          id              INTEGER PRIMARY KEY,
          file_id         INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
          key             TEXT NOT NULL,
          value_type      TEXT NOT NULL,
          value_format    TEXT,
          comment         TEXT,
          quoted          INTEGER NOT NULL DEFAULT 0,
          line            INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_env_vars_file ON env_vars(file_id);
      CREATE INDEX IF NOT EXISTS idx_env_vars_key  ON env_vars(key);
    `);
  },
  6: (db) => {
    // v6: complexity metrics on symbols — cyclomatic, max_nesting, param_count
    db.exec(`
      ALTER TABLE symbols ADD COLUMN cyclomatic   INTEGER;
      ALTER TABLE symbols ADD COLUMN max_nesting  INTEGER;
      ALTER TABLE symbols ADD COLUMN param_count  INTEGER;
    `);
  },
  7: (db) => {
    // v7: gitignored flag on files — indexed for graph metadata,
    // but source content not served to AI models
    db.exec(`ALTER TABLE files ADD COLUMN gitignored INTEGER NOT NULL DEFAULT 0;`);
  },
  8: (db) => {
    // v8: Predictive Intelligence — bug prediction, drift detection, tech debt scoring
    db.exec(`
      CREATE TABLE IF NOT EXISTS pi_snapshots (
          id              INTEGER PRIMARY KEY,
          snapshot_type   TEXT NOT NULL,
          created_at      TEXT NOT NULL DEFAULT (datetime('now')),
          git_head        TEXT,
          config_hash     TEXT,
          file_count      INTEGER,
          duration_ms     INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_pi_snapshots_type ON pi_snapshots(snapshot_type);

      CREATE TABLE IF NOT EXISTS pi_bug_scores (
          id              INTEGER PRIMARY KEY,
          snapshot_id     INTEGER NOT NULL REFERENCES pi_snapshots(id) ON DELETE CASCADE,
          file_id         INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
          score           REAL NOT NULL,
          churn_signal    REAL,
          fix_ratio_signal REAL,
          complexity_signal REAL,
          coupling_signal REAL,
          pagerank_signal REAL,
          author_signal   REAL,
          factors         TEXT,
          UNIQUE(snapshot_id, file_id)
      );
      CREATE INDEX IF NOT EXISTS idx_pi_bug_scores_snapshot ON pi_bug_scores(snapshot_id);
      CREATE INDEX IF NOT EXISTS idx_pi_bug_scores_score ON pi_bug_scores(score DESC);

      CREATE TABLE IF NOT EXISTS pi_co_changes (
          id              INTEGER PRIMARY KEY,
          snapshot_id     INTEGER NOT NULL REFERENCES pi_snapshots(id) ON DELETE CASCADE,
          file_a_id       INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
          file_b_id       INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
          co_change_count INTEGER NOT NULL,
          total_a         INTEGER NOT NULL,
          total_b         INTEGER NOT NULL,
          confidence      REAL NOT NULL,
          same_module     INTEGER NOT NULL,
          UNIQUE(snapshot_id, file_a_id, file_b_id)
      );
      CREATE INDEX IF NOT EXISTS idx_pi_co_changes_snapshot ON pi_co_changes(snapshot_id);

      CREATE TABLE IF NOT EXISTS pi_tech_debt (
          id              INTEGER PRIMARY KEY,
          snapshot_id     INTEGER NOT NULL REFERENCES pi_snapshots(id) ON DELETE CASCADE,
          module_path     TEXT NOT NULL,
          score           REAL NOT NULL,
          complexity_score REAL,
          coupling_score  REAL,
          test_gap_score  REAL,
          churn_score     REAL,
          recommendations TEXT,
          UNIQUE(snapshot_id, module_path)
      );
      CREATE INDEX IF NOT EXISTS idx_pi_tech_debt_snapshot ON pi_tech_debt(snapshot_id);

      CREATE TABLE IF NOT EXISTS pi_health_history (
          id              INTEGER PRIMARY KEY,
          file_path       TEXT NOT NULL,
          recorded_at     TEXT NOT NULL DEFAULT (datetime('now')),
          bug_score       REAL,
          complexity_avg  REAL,
          coupling_ce     REAL,
          churn_per_week  REAL,
          test_coverage   REAL
      );
      CREATE INDEX IF NOT EXISTS idx_pi_health_file ON pi_health_history(file_path);
      CREATE INDEX IF NOT EXISTS idx_pi_health_date ON pi_health_history(recorded_at);
    `);
  },
  9: (db) => {
    // v9: Workspace columns + indices for cross-workspace queries
    // Add columns first (they're in the DDL for new databases, but existing ones need ALTER)
    const filesCols = db.pragma('table_info(files)') as { name: string }[];
    if (!filesCols.some((c) => c.name === 'workspace')) {
      db.exec(`ALTER TABLE files ADD COLUMN workspace TEXT`);
    }
    const edgesCols = db.pragma('table_info(edges)') as { name: string }[];
    if (!edgesCols.some((c) => c.name === 'is_cross_ws')) {
      db.exec(`ALTER TABLE edges ADD COLUMN is_cross_ws INTEGER NOT NULL DEFAULT 0`);
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_files_workspace ON files(workspace);
      CREATE INDEX IF NOT EXISTS idx_edges_cross_ws ON edges(is_cross_ws) WHERE is_cross_ws = 1;
    `);
  },
  10: (db) => {
    // v10: Missing indexes for indexing pipeline performance.
    // - symbols(name): heritage resolution, findImplementors, getSymbolByName
    // - orm_models(name): ORM association target resolution
    // - edges compound: edge existence checks during batch insert
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
      CREATE INDEX IF NOT EXISTS idx_orm_models_name ON orm_models(name);
      CREATE INDEX IF NOT EXISTS idx_edges_src_tgt_type ON edges(source_node_id, target_node_id, edge_type_id);
    `);
  },
  11: (db) => {
    // v11: Intent Layer — business domain mapping
    db.exec(`
      CREATE TABLE IF NOT EXISTS domains (
          id          INTEGER PRIMARY KEY,
          name        TEXT NOT NULL,
          parent_id   INTEGER REFERENCES domains(id) ON DELETE SET NULL,
          description TEXT,
          path_hints  TEXT,
          confidence  REAL NOT NULL DEFAULT 1.0,
          is_manual   INTEGER NOT NULL DEFAULT 0,
          metadata    TEXT,
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(name, parent_id)
      );
      CREATE INDEX IF NOT EXISTS idx_domains_parent ON domains(parent_id);

      CREATE TABLE IF NOT EXISTS symbol_domains (
          id          INTEGER PRIMARY KEY,
          symbol_id   INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
          domain_id   INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
          relevance   REAL NOT NULL DEFAULT 1.0,
          is_manual   INTEGER NOT NULL DEFAULT 0,
          inferred_by TEXT NOT NULL DEFAULT 'heuristic',
          metadata    TEXT,
          UNIQUE(symbol_id, domain_id)
      );
      CREATE INDEX IF NOT EXISTS idx_symbol_domains_symbol ON symbol_domains(symbol_id);
      CREATE INDEX IF NOT EXISTS idx_symbol_domains_domain ON symbol_domains(domain_id);

      CREATE TABLE IF NOT EXISTS file_domains (
          id          INTEGER PRIMARY KEY,
          file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
          domain_id   INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
          relevance   REAL NOT NULL DEFAULT 1.0,
          is_manual   INTEGER NOT NULL DEFAULT 0,
          inferred_by TEXT NOT NULL DEFAULT 'heuristic',
          UNIQUE(file_id, domain_id)
      );
      CREATE INDEX IF NOT EXISTS idx_file_domains_file ON file_domains(file_id);
      CREATE INDEX IF NOT EXISTS idx_file_domains_domain ON file_domains(domain_id);

      CREATE TABLE IF NOT EXISTS domain_embeddings (
          domain_id   INTEGER PRIMARY KEY REFERENCES domains(id) ON DELETE CASCADE,
          embedding   BLOB NOT NULL
      );
    `);
  },
  12: (db) => {
    // v12: Runtime Intelligence — OTel trace ingestion, span mapping, aggregates
    db.exec(`
      INSERT OR IGNORE INTO node_types (name) VALUES ('service');

      INSERT OR IGNORE INTO edge_types (name, category, directed, description) VALUES
        ('runtime_calls', 'runtime', 1, 'Observed runtime call between symbols'),
        ('runtime_routes_to', 'runtime', 1, 'Observed HTTP request to route handler'),
        ('runtime_queries', 'runtime', 1, 'Runtime DB query from code to database service'),
        ('runtime_calls_service', 'runtime', 1, 'Runtime call to external service'),
        ('runtime_publishes', 'runtime', 1, 'Runtime message publish to queue/topic'),
        ('runtime_consumes', 'runtime', 1, 'Runtime message consumption from queue/topic');

      CREATE TABLE IF NOT EXISTS runtime_traces (
          id              INTEGER PRIMARY KEY,
          trace_id        TEXT NOT NULL UNIQUE,
          root_service    TEXT,
          root_operation  TEXT,
          started_at      TEXT NOT NULL,
          duration_us     INTEGER,
          status          TEXT DEFAULT 'ok',
          ingested_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_rt_traces_started ON runtime_traces(started_at);

      CREATE TABLE IF NOT EXISTS runtime_spans (
          id              INTEGER PRIMARY KEY,
          trace_id        INTEGER NOT NULL REFERENCES runtime_traces(id) ON DELETE CASCADE,
          span_id         TEXT NOT NULL,
          parent_span_id  TEXT,
          service_name    TEXT NOT NULL,
          operation       TEXT NOT NULL,
          kind            TEXT NOT NULL,
          started_at      TEXT NOT NULL,
          duration_us     INTEGER NOT NULL,
          status_code     INTEGER DEFAULT 0,
          status_message  TEXT,
          attributes      TEXT,
          mapped_node_id  INTEGER REFERENCES nodes(id),
          mapping_method  TEXT,
          UNIQUE(trace_id, span_id)
      );
      CREATE INDEX IF NOT EXISTS idx_rs_trace ON runtime_spans(trace_id);
      CREATE INDEX IF NOT EXISTS idx_rs_mapped_node ON runtime_spans(mapped_node_id);
      CREATE INDEX IF NOT EXISTS idx_rs_service ON runtime_spans(service_name);
      CREATE INDEX IF NOT EXISTS idx_rs_started ON runtime_spans(started_at);

      CREATE TABLE IF NOT EXISTS runtime_services (
          id              INTEGER PRIMARY KEY,
          name            TEXT NOT NULL UNIQUE,
          kind            TEXT,
          first_seen_at   TEXT NOT NULL,
          last_seen_at    TEXT NOT NULL,
          metadata        TEXT
      );

      CREATE TABLE IF NOT EXISTS runtime_aggregates (
          id              INTEGER PRIMARY KEY,
          node_id         INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
          bucket          TEXT NOT NULL,
          call_count      INTEGER NOT NULL DEFAULT 0,
          error_count     INTEGER NOT NULL DEFAULT 0,
          total_duration_us INTEGER NOT NULL DEFAULT 0,
          min_duration_us INTEGER,
          max_duration_us INTEGER,
          percentiles     TEXT,
          UNIQUE(node_id, bucket)
      );
      CREATE INDEX IF NOT EXISTS idx_ra_node ON runtime_aggregates(node_id);
      CREATE INDEX IF NOT EXISTS idx_ra_bucket ON runtime_aggregates(bucket);
      CREATE INDEX IF NOT EXISTS idx_rs_trace_parent ON runtime_spans(trace_id, parent_span_id);
    `);
  },
  13: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS graph_snapshots (
          id              INTEGER PRIMARY KEY,
          commit_hash     TEXT,
          created_at      TEXT NOT NULL DEFAULT (datetime('now')),
          snapshot_type   TEXT NOT NULL,
          file_path       TEXT,
          data            TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_gs_type ON graph_snapshots(snapshot_type);
      CREATE INDEX IF NOT EXISTS idx_gs_commit ON graph_snapshots(commit_hash);
      CREATE INDEX IF NOT EXISTS idx_gs_file ON graph_snapshots(file_path);
      CREATE INDEX IF NOT EXISTS idx_gs_created ON graph_snapshots(created_at);
    `);
  },
  14: (db) => {
    // v14: Trigram index for fuzzy search
    db.exec(`
      CREATE TABLE IF NOT EXISTS symbol_trigrams (
          symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
          trigram   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trigrams_tri ON symbol_trigrams(trigram);
      CREATE INDEX IF NOT EXISTS idx_trigrams_sym ON symbol_trigrams(symbol_id);

      CREATE TABLE IF NOT EXISTS co_changes (
          file_a TEXT NOT NULL,
          file_b TEXT NOT NULL,
          co_change_count INTEGER NOT NULL,
          total_changes_a INTEGER NOT NULL,
          total_changes_b INTEGER NOT NULL,
          confidence REAL NOT NULL,
          last_co_change TEXT,
          window_days INTEGER NOT NULL DEFAULT 180,
          PRIMARY KEY (file_a, file_b)
      );
      CREATE INDEX IF NOT EXISTS idx_co_changes_a ON co_changes(file_a);
      CREATE INDEX IF NOT EXISTS idx_co_changes_b ON co_changes(file_b);

      CREATE TABLE IF NOT EXISTS communities (
          id INTEGER PRIMARY KEY,
          label TEXT,
          file_count INTEGER,
          cohesion REAL,
          internal_edges INTEGER,
          external_edges INTEGER,
          computed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS community_members (
          community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
          file_path TEXT NOT NULL,
          PRIMARY KEY (community_id, file_path)
      );
      CREATE INDEX IF NOT EXISTS idx_cm_community ON community_members(community_id);
    `);
  },
  15: (db) => {
    // Add mtime_ms column for fast-path skip (avoids reading + hashing unchanged files)
    db.exec(`ALTER TABLE files ADD COLUMN mtime_ms INTEGER`);
  },
  16: (db) => {
    // Partial index for symbols with heritage metadata (extends/implements).
    // Speeds up getSymbolsWithHeritage() — avoids full table scan + json_extract on all rows.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_symbols_has_heritage
      ON symbols(file_id)
      WHERE metadata IS NOT NULL
        AND (json_extract(metadata, '$.extends') IS NOT NULL
          OR json_extract(metadata, '$.implements') IS NOT NULL)
    `);
  },
  17: (db) => {
    // Progress tracking table for indexing, summarization, and embedding pipelines.
    // Read by CLI `status` command and MCP `get_index_health` tool.
    db.exec(`
      CREATE TABLE IF NOT EXISTS indexing_progress (
        pipeline TEXT PRIMARY KEY,
        phase TEXT NOT NULL DEFAULT 'idle',
        processed INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL DEFAULT 0,
        completed_at INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        updated_at INTEGER NOT NULL DEFAULT 0
      )
    `);
    // Pre-seed rows for all three pipelines
    db.exec(`
      INSERT OR IGNORE INTO indexing_progress (pipeline) VALUES ('indexing');
      INSERT OR IGNORE INTO indexing_progress (pipeline) VALUES ('summarization');
      INSERT OR IGNORE INTO indexing_progress (pipeline) VALUES ('embedding');
    `);
  },
  18: (db) => {
    // Server state tracking — allows CLI `status` to detect if serve is running.
    db.exec(`
      CREATE TABLE IF NOT EXISTS server_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  },
  19: (db) => {
    // LSP enrichment — 4-tier resolution confidence on edges.
    const cols = (db.pragma('table_info(edges)') as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes('resolution_tier')) {
      db.exec(`ALTER TABLE edges ADD COLUMN resolution_tier TEXT NOT NULL DEFAULT 'ast_resolved'`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_edges_resolution_tier ON edges(resolution_tier)`);
  },
  20: (db) => {
    // Backfill every edge type declared in SEED_EDGE_TYPES.
    //
    // Historical bug: `seedDatabase` only runs for fresh DBs, and several core
    // edge types (member_of, instantiates, accesses_property, accesses_constant)
    // were added to the seed list without a matching migration. Existing DBs
    // never got them, so `resolveMemberOfEdges` et al. silently returned early,
    // leaving ~1200 method→class structural edges unrecorded and symbol-level
    // graph clustering broken.
    //
    // This migration idempotently inserts every seed edge type so the live
    // `edge_types` table is always a superset of code expectations. Any future
    // additions to SEED_EDGE_TYPES will also be picked up without needing a
    // dedicated migration.
    const insert = db.prepare(
      'INSERT OR IGNORE INTO edge_types (name, category, directed, description) VALUES (?, ?, 1, ?)',
    );
    for (const et of SEED_EDGE_TYPES) {
      insert.run(et.name, et.category, et.description);
    }
  },
  21: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS embedding_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  },
  22: (db) => {
    // Markdown knowledge-graph: register the `embeds` edge type for ![[X]] transclusions.
    db.exec(`
      INSERT OR IGNORE INTO edge_types (name, category, directed, description)
      VALUES ('embeds', 'markdown', 1, 'Markdown embed (![[X]]) — note transcludes another note');
    `);
  },
  23: (db) => {
    // Markdown knowledge-graph: `tagged` edge from note → canonical tag symbol.
    // Enables `find_usages` on `tag:foo` to return every note carrying that tag.
    db.exec(`
      INSERT OR IGNORE INTO edge_types (name, category, directed, description)
      VALUES ('tagged', 'markdown', 1, 'Note is tagged with a #tag (frontmatter or inline)');
    `);
  },
  24: (db) => {
    // Phase 1 follow-up: repo_metadata captures the git HEAD at index time so the
    // freshness module can flag results pointing at a stale snapshot of the repo.
    db.exec(`
      CREATE TABLE IF NOT EXISTS repo_metadata (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  },
};

function runMigrations(db: Database.Database, fromVersion: number): void {
  const versions = Object.keys(MIGRATIONS)
    .map(Number)
    .filter((v) => v > fromVersion)
    .sort((a, b) => a - b);

  if (versions.length === 0) return;

  const insertMigration = db.prepare(
    'INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)',
  );
  const updateVersion = db.prepare(
    "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', ?)",
  );

  for (const version of versions) {
    logger.info({ version }, 'Running schema migration');
    db.transaction(() => {
      MIGRATIONS[version](db);
      insertMigration.run(version, new Date().toISOString());
      updateVersion.run(String(version));
    })();
    logger.info({ version }, 'Schema migration applied');
  }
}

export function initializeDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  // WAL mode for concurrent reads + write performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  // NORMAL is safe in WAL mode (data survives process crash, not OS crash) and
  // avoids an fsync per transaction — major win for batched indexing.
  db.pragma('synchronous = NORMAL');
  // 64 MB page cache (default is ~2 MB) — keeps hot pages in memory during indexing
  db.pragma('cache_size = -65536');
  // 256 MB mmap — lets SQLite access pages via mmap instead of read() syscalls
  db.pragma('mmap_size = 268435456');

  db.exec(DDL);

  // Check schema version and run any pending migrations
  const versionRow = db
    .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;

  if (!versionRow) {
    // Fresh database — seed and stamp with current version
    seedDatabase(db);
    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)").run(
      String(SCHEMA_VERSION),
    );
    // Mark all migrations as already applied (they're baked into seed/DDL)
    const insertMigration = db.prepare(
      'INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)',
    );
    const now = new Date().toISOString();
    for (const v of Object.keys(MIGRATIONS).map(Number)) {
      insertMigration.run(v, now);
    }
  } else {
    const currentVersion = parseInt(versionRow.value, 10);
    if (currentVersion < SCHEMA_VERSION) {
      logger.info({ from: currentVersion, to: SCHEMA_VERSION }, 'Schema upgrade required');
      runMigrations(db, currentVersion);
    }
  }

  logger.debug({ dbPath, schemaVersion: SCHEMA_VERSION }, 'Database initialized');
  return db;
}

function seedDatabase(db: Database.Database): void {
  const insertNodeType = db.prepare('INSERT OR IGNORE INTO node_types (name) VALUES (?)');
  for (const name of SEED_NODE_TYPES) {
    insertNodeType.run(name);
  }

  const insertEdgeType = db.prepare(
    'INSERT OR IGNORE INTO edge_types (name, category, directed, description) VALUES (?, ?, 1, ?)',
  );
  for (const et of SEED_EDGE_TYPES) {
    insertEdgeType.run(et.name, et.category, et.description);
  }

  // Indexes that depend on columns added in migrations (v9) —
  // for fresh databases the columns are in the DDL, but the indexes
  // were removed from DDL to avoid errors on existing databases.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_files_workspace ON files(workspace);
    CREATE INDEX IF NOT EXISTS idx_edges_cross_ws ON edges(is_cross_ws) WHERE is_cross_ws = 1;
  `);

  // Pre-seed progress rows for all three pipelines (mirrors migration 17)
  db.exec(`
    INSERT OR IGNORE INTO indexing_progress (pipeline) VALUES ('indexing');
    INSERT OR IGNORE INTO indexing_progress (pipeline) VALUES ('summarization');
    INSERT OR IGNORE INTO indexing_progress (pipeline) VALUES ('embedding');
  `);
}

/**
 * Disable FTS5 triggers on symbols table during batch inserts.
 * Call rebuildFts5 after all inserts are done.
 */
export function disableFts5Triggers(db: Database.Database): void {
  db.exec('DROP TRIGGER IF EXISTS symbols_ai');
  db.exec('DROP TRIGGER IF EXISTS symbols_ad');
  db.exec('DROP TRIGGER IF EXISTS symbols_au');
}

/**
 * Re-enable FTS5 triggers and rebuild the FTS5 index from scratch.
 * This is faster than per-row trigger fires during batch inserts.
 */
export function enableFts5Triggers(db: Database.Database): void {
  // Rebuild FTS5 index from current symbols table content
  db.exec("INSERT INTO symbols_fts(symbols_fts) VALUES('rebuild')");

  // Restore triggers for subsequent single-row operations
  db.exec(`CREATE TRIGGER IF NOT EXISTS symbols_ai AFTER INSERT ON symbols BEGIN
    INSERT INTO symbols_fts(rowid, name, fqn, signature, summary)
    VALUES (new.id, new.name, new.fqn, new.signature, new.summary);
  END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS symbols_ad AFTER DELETE ON symbols BEGIN
    INSERT INTO symbols_fts(symbols_fts, rowid, name, fqn, signature, summary)
    VALUES ('delete', old.id, old.name, old.fqn, old.signature, old.summary);
  END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS symbols_au AFTER UPDATE ON symbols BEGIN
    INSERT INTO symbols_fts(symbols_fts, rowid, name, fqn, signature, summary)
    VALUES ('delete', old.id, old.name, old.fqn, old.signature, old.summary);
    INSERT INTO symbols_fts(rowid, name, fqn, signature, summary)
    VALUES (new.id, new.name, new.fqn, new.signature, new.summary);
  END`);
}

export function getTableNames(db: Database.Database): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

function _getVirtualTableNames(db: Database.Database): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%VIRTUAL%' ORDER BY name",
    )
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}
