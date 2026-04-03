import Database from 'better-sqlite3';
import { logger } from '../logger.js';

const SCHEMA_VERSION = 2;

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
    workspace       TEXT
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
    metadata    TEXT
);

CREATE TABLE IF NOT EXISTS routes (
    id                      INTEGER PRIMARY KEY,
    method                  TEXT NOT NULL,
    uri                     TEXT NOT NULL,
    name                    TEXT,
    controller_symbol_id    INTEGER REFERENCES symbols(id),
    middleware              TEXT,
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
    UNIQUE(source_node_id, target_node_id, edge_type_id)
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_node_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_node_id);
CREATE INDEX IF NOT EXISTS idx_edges_type   ON edges(edge_type_id);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
CREATE INDEX IF NOT EXISTS idx_symbols_fqn  ON symbols(fqn);
CREATE INDEX IF NOT EXISTS idx_nodes_type   ON nodes(node_type);

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
`;

const SEED_NODE_TYPES = ['symbol', 'file', 'route', 'component', 'migration', 'orm_model', 'rn_screen'];

const SEED_EDGE_TYPES = [
  { name: 'imports', category: 'php', description: 'PHP use/import statement' },
  { name: 'extends', category: 'php', description: 'Class/interface extends' },
  { name: 'implements', category: 'php', description: 'Class implements interface' },
  { name: 'uses_trait', category: 'php', description: 'Class uses trait' },
  { name: 'unresolved', category: 'core', description: 'Phantom edge for unresolved targets' },
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
  { name: 'renders_component', category: 'vue', description: 'Parent component renders child in template' },
  { name: 'uses_composable', category: 'vue', description: 'Component calls a composable function' },
  { name: 'provides_slot', category: 'vue', description: 'Component provides a named slot' },
  // Inertia edges
  { name: 'inertia_renders', category: 'inertia', description: 'Controller renders Vue page via Inertia' },
  { name: 'passes_props', category: 'inertia', description: 'Controller passes props to Vue page' },
  // Nuxt edges
  { name: 'nuxt_auto_imports', category: 'nuxt', description: 'Auto-imported composable' },
  { name: 'api_calls', category: 'nuxt', description: 'fetch/useFetch API call' },
  // Blade edges
  { name: 'blade_extends', category: 'blade', description: '@extends directive' },
  { name: 'blade_includes', category: 'blade', description: '@include directive' },
  { name: 'blade_component', category: 'blade', description: '<x-component> or @component' },
  // Nova edges
  { name: 'nova_resource_for', category: 'nova', description: 'Nova Resource → Eloquent Model' },
  { name: 'nova_field_relationship', category: 'nova', description: 'Nova Resource → related Nova Resource via field' },
  { name: 'nova_action_on', category: 'nova', description: 'Action → Resource' },
  { name: 'nova_filter_on', category: 'nova', description: 'Filter → Resource' },
  { name: 'nova_lens_on', category: 'nova', description: 'Lens → Resource' },
  { name: 'nova_metric_queries', category: 'nova', description: 'Metric → Eloquent Model' },
  // Filament edges
  { name: 'filament_resource_for', category: 'filament', description: 'Resource → Eloquent Model' },
  { name: 'filament_relation_manager', category: 'filament', description: 'Resource → RelationManager' },
  { name: 'filament_form_relationship', category: 'filament', description: 'Form field →relationship() → Model' },
  { name: 'filament_page_for', category: 'filament', description: 'Page registered on Resource' },
  { name: 'filament_panel_registers', category: 'filament', description: 'PanelProvider → Resource/Page/Widget' },
  { name: 'filament_widget_queries', category: 'filament', description: 'Widget → Eloquent Model' },
  // Livewire edges
  { name: 'livewire_renders', category: 'livewire', description: 'Component class → Blade view' },
  { name: 'livewire_dispatches', category: 'livewire', description: 'Component dispatches event' },
  { name: 'livewire_listens', category: 'livewire', description: 'Component listens for event' },
  { name: 'livewire_child_of', category: 'livewire', description: 'Blade <livewire:child/> → Component' },
  { name: 'livewire_uses_model', category: 'livewire', description: 'Component → Eloquent Model' },
  { name: 'livewire_form', category: 'livewire', description: 'Component → Form class (v3)' },
  { name: 'livewire_action', category: 'livewire', description: 'wire:click → Component method' },
  // NestJS edges
  { name: 'nest_module_imports', category: 'nestjs', description: 'Module imports another module' },
  { name: 'nest_provides', category: 'nestjs', description: 'Module provides a service' },
  { name: 'nest_injects', category: 'nestjs', description: 'Constructor dependency injection' },
  { name: 'nest_guards', category: 'nestjs', description: 'UseGuards on controller/method' },
  { name: 'nest_pipes', category: 'nestjs', description: 'UsePipes on controller/method' },
  { name: 'nest_interceptors', category: 'nestjs', description: 'UseInterceptors on controller/method' },
  { name: 'nest_gateway_event', category: 'nestjs', description: 'WebSocket gateway @SubscribeMessage handler' },
  { name: 'nest_message_pattern', category: 'nestjs', description: 'Microservice @MessagePattern handler' },
  { name: 'nest_event_pattern', category: 'nestjs', description: 'Microservice @EventPattern handler' },
  // Next.js edges
  { name: 'next_renders_page', category: 'nextjs', description: 'Layout renders page' },
  { name: 'next_server_action', category: 'nextjs', description: 'Server action reference' },
  { name: 'next_middleware', category: 'nextjs', description: 'Middleware applies to routes' },
  // Express edges
  { name: 'express_route', category: 'express', description: 'Express route handler' },
  { name: 'express_middleware', category: 'express', description: 'Express middleware' },
  { name: 'express_mounts', category: 'express', description: 'Router mount via app.use' },
  { name: 'express_error_handler', category: 'express', description: '4-arg error handling middleware' },
  { name: 'express_param_handler', category: 'express', description: 'app.param() route parameter handler' },
  // Mongoose edges
  { name: 'mongoose_references', category: 'mongoose', description: 'ObjectId ref to another model' },
  { name: 'mongoose_has_virtual', category: 'mongoose', description: 'Schema virtual field' },
  { name: 'mongoose_has_middleware', category: 'mongoose', description: 'Schema pre/post hook' },
  { name: 'mongoose_has_method', category: 'mongoose', description: 'Schema instance method' },
  { name: 'mongoose_has_static', category: 'mongoose', description: 'Schema static method' },
  { name: 'mongoose_discriminates', category: 'mongoose', description: 'Model discriminator' },
  { name: 'mongoose_has_index', category: 'mongoose', description: 'Schema index' },
  { name: 'mongoose_uses_plugin', category: 'mongoose', description: 'Schema plugin' },
  // Sequelize edges
  { name: 'sequelize_has_many', category: 'sequelize', description: 'Sequelize hasMany association' },
  { name: 'sequelize_belongs_to', category: 'sequelize', description: 'Sequelize belongsTo association' },
  { name: 'sequelize_belongs_to_many', category: 'sequelize', description: 'Sequelize belongsToMany association' },
  { name: 'sequelize_has_one', category: 'sequelize', description: 'Sequelize hasOne association' },
  { name: 'sequelize_has_hook', category: 'sequelize', description: 'Sequelize lifecycle hook' },
  { name: 'sequelize_has_scope', category: 'sequelize', description: 'Sequelize named scope' },
  { name: 'sequelize_migrates', category: 'sequelize', description: 'Migration changes table schema' },
  // React Native edges
  { name: 'rn_navigates_to', category: 'react-native', description: 'navigation.navigate() to screen' },
  { name: 'rn_screen_in_navigator', category: 'react-native', description: 'Screen registered in navigator' },
  { name: 'rn_uses_native_module', category: 'react-native', description: 'Uses NativeModules/TurboModuleRegistry' },
  { name: 'rn_platform_specific', category: 'react-native', description: 'Platform-specific file variant' },
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
  { name: 'fastapi_request_model', category: 'fastapi', description: 'Request body Pydantic model' },
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
  { name: 'pydantic_field_type', category: 'pydantic', description: 'BaseModel field type reference' },
  { name: 'pydantic_from_orm', category: 'pydantic', description: 'Model with from_attributes → ORM model' },
  // Celery edges
  { name: 'celery_task_registered', category: 'celery', description: '@app.task / @shared_task registration' },
  { name: 'celery_beat_schedule', category: 'celery', description: 'Beat schedule task entry' },
  { name: 'celery_dispatches', category: 'celery', description: '.delay() / .apply_async() dispatch' },
  // Pennant (feature flags) edges
  { name: 'feature_defined_in', category: 'pennant', description: 'Feature flag defined via Feature::define()' },
  { name: 'feature_checked_by', category: 'pennant', description: 'Feature flag checked in PHP/Blade' },
  { name: 'feature_gates_route', category: 'pennant', description: 'Route protected by features middleware' },
  // Broadcasting / Reverb edges
  { name: 'broadcasts_on', category: 'broadcasting', description: 'Event broadcasts on a channel' },
  { name: 'channel_authorized_by', category: 'broadcasting', description: 'Channel authorization callback or class' },
  { name: 'broadcast_as', category: 'broadcasting', description: 'Event broadcast name override' },
  // laravel-data edges
  { name: 'data_wraps', category: 'laravel-data', description: 'Data class wraps an Eloquent model' },
  { name: 'data_property_type', category: 'laravel-data', description: 'Data class property references another Data class' },
  { name: 'data_collection', category: 'laravel-data', description: 'DataCollection<T> references a Data class' },
  // Workspace edges
  { name: 'workspace_import', category: 'workspace', description: 'Cross-workspace import' },
  { name: 'api_call', category: 'workspace', description: 'Cross-workspace API call' },
  { name: 'type_import', category: 'workspace', description: 'Cross-workspace type import' },
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
};

function runMigrations(db: Database.Database, fromVersion: number): void {
  const versions = Object.keys(MIGRATIONS)
    .map(Number)
    .filter((v) => v > fromVersion)
    .sort((a, b) => a - b);

  if (versions.length === 0) return;

  const insertMigration = db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
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

  // WAL mode for concurrent reads
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  db.exec(DDL);

  // Check schema version and run any pending migrations
  const versionRow = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string } | undefined;

  if (!versionRow) {
    // Fresh database — seed and stamp with current version
    seedDatabase(db);
    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
    // Mark all migrations as already applied (they're baked into seed/DDL)
    const insertMigration = db.prepare(
      "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
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
}

export function getTableNames(db: Database.Database): string[] {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as { name: string }[];
  return rows.map((r) => r.name);
}

export function getVirtualTableNames(db: Database.Database): string[] {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%VIRTUAL%' ORDER BY name",
  ).all() as { name: string }[];
  return rows.map((r) => r.name);
}
