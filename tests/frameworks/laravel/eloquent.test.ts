import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractEloquentModel } from '../../../src/indexer/plugins/integration/framework/laravel/eloquent.js';

const L10_FIXTURE = path.resolve(__dirname, '../../fixtures/laravel-10');

describe('Eloquent model extraction', () => {
  describe('User model', () => {
    const source = fs.readFileSync(path.join(L10_FIXTURE, 'app/Models/User.php'), 'utf-8');
    const model = extractEloquentModel(source, 'app/Models/User.php');

    it('detects Model class', () => {
      expect(model).not.toBeNull();
      expect(model!.className).toBe('User');
      expect(model!.fqn).toBe('App\\Models\\User');
      expect(model!.extendsModel).toBe(true);
    });

    it('extracts $fillable', () => {
      expect(model!.fillable).toEqual(['name', 'email', 'password']);
    });

    it('extracts $casts', () => {
      expect(model!.casts).toEqual({
        email_verified_at: 'datetime',
        password: 'hashed',
      });
    });

    it('extracts hasMany relationship', () => {
      const hasMany = model!.relationships.find((r) => r.type === 'hasMany');
      expect(hasMany).toBeDefined();
      expect(hasMany!.methodName).toBe('posts');
      expect(hasMany!.relatedClass).toBe('App\\Models\\Post');
      expect(hasMany!.edgeType).toBe('has_many');
    });

    it('extracts belongsToMany relationship', () => {
      const btm = model!.relationships.find((r) => r.type === 'belongsToMany');
      expect(btm).toBeDefined();
      expect(btm!.methodName).toBe('roles');
      expect(btm!.edgeType).toBe('belongs_to_many');
    });

    it('extracts scopes', () => {
      expect(model!.scopes).toContain('active');
    });
  });

  describe('Post model', () => {
    const source = fs.readFileSync(path.join(L10_FIXTURE, 'app/Models/Post.php'), 'utf-8');
    const model = extractEloquentModel(source, 'app/Models/Post.php');

    it('detects belongsTo relationship', () => {
      expect(model).not.toBeNull();
      const bt = model!.relationships.find((r) => r.type === 'belongsTo');
      expect(bt).toBeDefined();
      expect(bt!.methodName).toBe('user');
      expect(bt!.relatedClass).toBe('App\\Models\\User');
      expect(bt!.edgeType).toBe('belongs_to');
    });

    it('extracts fillable', () => {
      expect(model!.fillable).toEqual(['title', 'body', 'user_id']);
    });
  });

  describe('non-model class', () => {
    it('returns null for non-model PHP file', () => {
      const source = `<?php
namespace App\\Http\\Controllers;

class UserController extends Controller
{
    public function index() {}
}`;
      const model = extractEloquentModel(source, 'app/Http/Controllers/UserController.php');
      expect(model).toBeNull();
    });
  });
});
