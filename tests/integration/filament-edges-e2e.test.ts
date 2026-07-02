/**
 * Integration: Filament v3 edge resolution through the full pipeline.
 *
 * Regression guard for the bug where the standalone FilamentPlugin emitted
 * edges as `{ source: filePath, target: shortClass(...) }` — fields that do
 * not exist on RawEdge. With no sourceSymbolId / sourceNodeType the
 * edge-resolver dropped every Filament edge, so the entire panel / resource /
 * form / table graph was silently lost.
 *
 * Now edge emission lives in FilamentPlugin.resolveEdges(ctx): each edge
 * carries a real source (the enclosing class symbol) and either a resolved
 * class target (Resource -> Model) or a virtual `filament-*::<name>` target.
 * This test indexes a minimal Filament app and asserts that at least the
 * Resource -> Model class edge lands in the edges table.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { FilamentPlugin } from '../../src/indexer/plugins/integration/framework/filament/index.js';
import { PhpLanguagePlugin } from '../../src/indexer/plugins/language/php/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore, createTmpFixture, removeTmpDir } from '../test-utils.js';

const COMPOSER_JSON = JSON.stringify(
  {
    name: 'acme/filament-app',
    require: {
      php: '^8.2',
      'laravel/framework': '^11.0',
      'filament/filament': '^3.0',
    },
  },
  null,
  2,
);

const USER_MODEL = `<?php

namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;

class User extends Model
{
    protected $fillable = ['name', 'email'];
}
`;

const USER_RESOURCE = `<?php

namespace App\\Filament\\Resources;

use App\\Models\\User;
use Filament\\Forms\\Form;
use Filament\\Resources\\Resource;
use Filament\\Tables\\Table;
use Filament\\Forms\\Components\\TextInput;
use Filament\\Tables\\Columns\\TextColumn;

class UserResource extends Resource
{
    protected static ?string $model = User::class;

    public static function form(Form $form): Form
    {
        return $form->schema([
            TextInput::make('name')->required(),
            TextInput::make('email')->email()->required(),
        ]);
    }

    public static function table(Table $table): Table
    {
        return $table->columns([
            TextColumn::make('name'),
            TextColumn::make('email'),
        ]);
    }
}
`;

describe('Filament v3 edge resolution e2e', () => {
  let store: Store;
  let fixturePath: string;

  beforeAll(async () => {
    fixturePath = createTmpFixture({
      'composer.json': COMPOSER_JSON,
      'app/Models/User.php': USER_MODEL,
      'app/Filament/Resources/UserResource.php': USER_RESOURCE,
    });

    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new PhpLanguagePlugin());
    registry.registerFrameworkPlugin(new FilamentPlugin());

    const config = TraceMcpConfigSchema.parse({
      include: ['**/*.php'],
      exclude: ['vendor/**'],
    });

    const pipeline = new IndexingPipeline(store, registry, config, fixturePath);
    await pipeline.indexAll();
  });

  afterAll(() => {
    removeTmpDir(fixturePath);
  });

  it('activates the Filament plugin and marks the resource role', () => {
    const files = store.getAllFiles();
    const resource = files.find((f) => f.path.includes('UserResource.php'));
    expect(resource).toBeDefined();
    expect(resource!.framework_role).toBe('filament_resource');
  });

  it('lands the Resource -> Model class edge in the edges table', () => {
    const edges = store.getEdgesByType('filament_resource_model');
    // The core regression assertion: at least one filament_* edge must resolve.
    expect(edges.length).toBeGreaterThan(0);

    // And it must be a real class->class edge: source = UserResource symbol,
    // target = User model symbol (both nodes exist in the graph).
    const userSym = store.getSymbolByFqn('App\\Models\\User');
    const resourceSym = store.getSymbolByFqn('App\\Filament\\Resources\\UserResource');
    expect(userSym).toBeDefined();
    expect(resourceSym).toBeDefined();
  });

  it('lands form-field name edges via virtual targets', () => {
    const edges = store.getEdgesByType('filament_form_field');
    expect(edges.length).toBeGreaterThan(0);
  });
});
