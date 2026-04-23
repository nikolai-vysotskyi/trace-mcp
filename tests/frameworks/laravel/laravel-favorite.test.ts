import { describe, it, expect } from 'vitest';
import {
  extractLaravelFavoriteModel,
  buildLaravelFavoriteEdges,
  buildLaravelFavoriteSymbols,
} from '../../../src/indexer/plugins/integration/framework/laravel/laravel-favorite.js';

describe('laravel-favorite', () => {
  describe('extractLaravelFavoriteModel', () => {
    it('detects Favoriter trait on a User model', () => {
      const source = `<?php
namespace App\\Models;
use Overtrue\\LaravelFavorite\\Traits\\Favoriter;

class User extends Model
{
    use Favoriter;
}
      `;
      const info = extractLaravelFavoriteModel(source, 'app/Models/User.php');
      expect(info).not.toBeNull();
      expect(info!.role).toBe('favoriter');
      expect(info!.fqn).toBe('App\\Models\\User');
    });

    it('detects Favoriteable trait on a Post model', () => {
      const source = `<?php
namespace App\\Models;
use Overtrue\\LaravelFavorite\\Traits\\Favoriteable;

class Post extends Model
{
    use Favoriteable;
}
      `;
      const info = extractLaravelFavoriteModel(source, 'app/Models/Post.php');
      expect(info!.role).toBe('favoriteable');
      expect(info!.fqn).toBe('App\\Models\\Post');
    });

    it('detects both traits ("both" role)', () => {
      const source = `<?php
namespace App\\Models;
use Overtrue\\LaravelFavorite\\Traits\\Favoriter;
use Overtrue\\LaravelFavorite\\Traits\\Favoriteable;

class Comment extends Model
{
    use Favoriter, Favoriteable;
}
      `;
      const info = extractLaravelFavoriteModel(source, 'app/Models/Comment.php');
      expect(info!.role).toBe('both');
    });

    it('returns null when trait short-name is unrelated to the package', () => {
      // A different package using the same short name — no Overtrue namespace anywhere.
      const source = `<?php
namespace App\\Traits;

trait Favoriteable {
    public function favorite() {}
}

class CustomModel { use Favoriteable; }
      `;
      expect(extractLaravelFavoriteModel(source, 'app/Models/Custom.php')).toBeNull();
    });

    it('returns null for files without favorite traits', () => {
      const source = `<?php
namespace App\\Models;
class Boring extends Model {}
      `;
      expect(extractLaravelFavoriteModel(source, 'app/Models/Boring.php')).toBeNull();
    });
  });

  describe('buildLaravelFavoriteEdges', () => {
    it('builds favorites() edge for favoriter', () => {
      const edges = buildLaravelFavoriteEdges({
        className: 'User',
        fqn: 'App\\Models\\User',
        role: 'favoriter',
      });
      expect(edges).toHaveLength(1);
      expect(edges[0].edgeType).toBe('belongs_to_many');
      expect(edges[0].metadata!.relation).toBe('favorites');
    });

    it('builds favoriters() edge for favoriteable', () => {
      const edges = buildLaravelFavoriteEdges({
        className: 'Post',
        fqn: 'App\\Models\\Post',
        role: 'favoriteable',
      });
      expect(edges[0].metadata!.relation).toBe('favoriters');
    });

    it('builds both edges for "both" role', () => {
      const edges = buildLaravelFavoriteEdges({
        className: 'C',
        fqn: 'App\\Models\\C',
        role: 'both',
      });
      const relations = edges.map((e) => e.metadata!.relation);
      expect(relations).toContain('favorites');
      expect(relations).toContain('favoriters');
    });
  });

  describe('buildLaravelFavoriteSymbols', () => {
    it('emits relation methods as symbols', () => {
      const symbols = buildLaravelFavoriteSymbols({
        className: 'User',
        fqn: 'App\\Models\\User',
        role: 'both',
      });
      const names = symbols.map((s) => s.name);
      expect(names).toContain('favorites');
      expect(names).toContain('favoriters');
      expect(symbols.every((s) => s.kind === 'method')).toBe(true);
    });
  });
});
