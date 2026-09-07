import { describe, expect, it } from 'vitest';
import { createTestStore } from '../test-utils.js';

describe('DomainRepository routes', () => {
  it('round-trips a route and looks it up by uri+method', () => {
    const store = createTestStore();
    const fileId = store.insertFile('src/routes.ts', 'typescript', 'h', 10, null, null);

    const id = store.insertRoute(
      { method: 'GET', uri: '/users/{id}', name: 'users.show', middleware: ['auth'] },
      fileId,
    );

    const row = store.getRouteByUriAndMethod('/users/{id}', 'GET');
    expect(row?.id).toBe(id);
    expect(row?.name).toBe('users.show');
    expect(JSON.parse(row!.middleware!)).toEqual({ middleware: ['auth'] });
  });

  it('findRouteByPattern replaces {param} with a wildcard and matches stored uris', () => {
    const store = createTestStore();
    const fileId = store.insertFile('src/routes.ts', 'typescript', 'h', 10, null, null);
    store.insertRoute({ method: 'GET', uri: '/users/new' }, fileId);
    store.insertRoute({ method: 'GET', uri: '/users/42' }, fileId);

    // Two stored routes both match the `/users/%` LIKE pattern; with no exact
    // match among them, the first one found wins.
    expect(store.findRouteByPattern('/users/{id}', 'GET')?.uri).toBe('/users/new');
    // A literal uri that is itself stored is preferred over any other match.
    expect(store.findRouteByPattern('/users/42', 'GET')?.uri).toBe('/users/42');
  });

  it('updateRouteUri rewrites the served uri in place', () => {
    const store = createTestStore();
    const fileId = store.insertFile('src/routes.ts', 'typescript', 'h', 10, null, null);
    const id = store.insertRoute({ method: 'GET', uri: '/old' }, fileId);

    store.updateRouteUri(id, '/new');

    expect(store.getRouteByUriAndMethod('/old', 'GET')).toBeUndefined();
    expect(store.getRouteByUriAndMethod('/new', 'GET')?.id).toBe(id);
  });
});

describe('DomainRepository components', () => {
  it('round-trips a component and looks it up by name and by file', () => {
    const store = createTestStore();
    const fileId = store.insertFile('src/Button.tsx', 'typescript', 'h', 10, null, null);

    const id = store.insertComponent(
      { name: 'Button', kind: 'component', framework: 'react', props: { label: 'string' } },
      fileId,
    );

    expect(store.getComponentByFileId(fileId)?.id).toBe(id);
    expect(store.getComponentByName('Button')?.id).toBe(id);
    expect(JSON.parse(store.getComponentByName('Button')!.props!)).toEqual({ label: 'string' });
  });
});

describe('DomainRepository migrations', () => {
  it('orders migrations for a table by timestamp ascending', () => {
    const store = createTestStore();
    const fileId = store.insertFile('src/migrations.ts', 'typescript', 'h', 10, null, null);

    store.insertMigration(
      { tableName: 'users', operation: 'alter', timestamp: '2026-02-01' },
      fileId,
    );
    store.insertMigration(
      { tableName: 'users', operation: 'create', timestamp: '2026-01-01' },
      fileId,
    );
    store.insertMigration(
      { tableName: 'posts', operation: 'create', timestamp: '2026-01-15' },
      fileId,
    );

    const rows = store.getMigrationsByTable('users');
    expect(rows.map((r) => r.operation)).toEqual(['create', 'alter']);
    expect(store.getAllMigrations().map((r) => r.table_name)).toEqual(['users', 'posts', 'users']);
  });
});

describe('DomainRepository ORM models and associations', () => {
  it('round-trips an ORM model and finds it by name and by orm', () => {
    const store = createTestStore();
    const fileId = store.insertFile('src/User.ts', 'typescript', 'h', 10, null, null);

    const id = store.insertOrmModel(
      { name: 'User', orm: 'sequelize', collectionOrTable: 'users' },
      fileId,
    );

    expect(store.getOrmModelByName('User')?.id).toBe(id);
    expect(store.getOrmModelsByOrm('sequelize').map((r) => r.id)).toEqual([id]);
    expect(store.getOrmModelsByOrm('mongoose')).toEqual([]);
  });

  it('scopes getAllOrmAssociations by fileIds, including unresolved associations targeting a model in that file', () => {
    const store = createTestStore();
    const fileA = store.insertFile('src/User.ts', 'typescript', 'h', 10, null, null);
    const fileB = store.insertFile('src/Post.ts', 'typescript', 'h', 10, null, null);

    const userId = store.insertOrmModel({ name: 'User', orm: 'sequelize' }, fileA);
    const postId = store.insertOrmModel({ name: 'Post', orm: 'sequelize' }, fileB);

    // Already resolved (target_model_id set) and declared in fileB — out of
    // scope for fileA: it doesn't need re-resolving, the edge already exists.
    store.insertOrmAssociation(postId, userId, 'User', 'belongsTo', undefined, fileB);
    // Unresolved (no target_model_id, no file_id) but its target name matches
    // a model that lives in fileA — must surface when scoped to fileA so a
    // reindex of fileA can re-link it.
    store.insertOrmAssociation(postId, null, 'User', 'hasMany', undefined, undefined);
    // Unrelated: neither declared in, nor targeting, the scoped files.
    const fileC = store.insertFile('src/Comment.ts', 'typescript', 'h', 10, null, null);
    const commentId = store.insertOrmModel({ name: 'Comment', orm: 'sequelize' }, fileC);
    store.insertOrmAssociation(commentId, null, 'Other', 'hasMany', undefined, fileC);

    const scoped = store.getAllOrmAssociations([fileA]);
    expect(scoped.map((r) => r.kind).sort()).toEqual(['hasMany']);

    expect(store.getAllOrmAssociations()).toHaveLength(3);
    expect(
      store
        .getOrmAssociationsByModel(postId)
        .map((r) => r.kind)
        .sort(),
    ).toEqual(['belongsTo', 'hasMany']);
  });
});

describe('DomainRepository React Native screens', () => {
  it('round-trips a screen and looks it up by name', () => {
    const store = createTestStore();
    const fileId = store.insertFile('src/HomeScreen.tsx', 'typescript', 'h', 10, null, null);

    const id = store.insertRnScreen(
      { name: 'Home', navigatorType: 'stack', deepLink: 'app://home' },
      fileId,
    );

    const row = store.getRnScreenByName('Home');
    expect(row?.id).toBe(id);
    expect(row?.navigator_type).toBe('stack');
    expect(store.getAllRnScreens().map((r) => r.id)).toEqual([id]);
  });
});
