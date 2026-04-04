/**
 * Tests for spatie/laravel-data extraction.
 * Covers: Data class fields, nested DTOs, DataCollection, fromModel(), Inertia props.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  extractDataClass,
  extractInertiaDataProps,
} from '../../../src/indexer/plugins/integration/laravel/laravel-data.js';

const FIXTURE = path.resolve(__dirname, '../../fixtures/laravel-data');

function read(rel: string) {
  return fs.readFileSync(path.join(FIXTURE, rel), 'utf-8');
}

// ─── UserData class ───────────────────────────────────────────

describe('laravel-data — UserData class', () => {
  const source = read('app/Data/UserData.php');
  const info = extractDataClass(source, 'app/Data/UserData.php');

  it('detects the Data class', () => {
    expect(info).not.toBeNull();
  });

  it('extracts class name and FQN', () => {
    expect(info!.className).toBe('UserData');
    expect(info!.fqn).toBe('App\\Data\\UserData');
  });

  it('extracts constructor field names', () => {
    const names = info!.fields.map((f) => f.name);
    expect(names).toContain('name');
    expect(names).toContain('email');
    expect(names).toContain('avatar');
    expect(names).toContain('role');
    expect(names).toContain('posts');
    expect(names).toContain('memberSince');
  });

  it('extracts field types', () => {
    const name = info!.fields.find((f) => f.name === 'name');
    expect(name?.type).toBe('string');
  });

  it('marks nullable fields', () => {
    const avatar = info!.fields.find((f) => f.name === 'avatar');
    expect(avatar?.nullable).toBe(true);
  });

  it('extracts #[MapFrom] attribute', () => {
    const memberSince = info!.fields.find((f) => f.name === 'memberSince');
    expect(memberSince?.mapFrom).toBe('created_at');
  });

  it('detects nested Data class (RoleData)', () => {
    expect(info!.nestedDataClasses).toContain('App\\Data\\RoleData');
  });

  it('detects DataCollection element type (PostData)', () => {
    expect(info!.collectedDataClasses).toContain('App\\Data\\PostData');
  });

  it('detects source model from fromModel(User $user)', () => {
    expect(info!.sourceModels).toContain('App\\Models\\User');
  });
});

// ─── Non-Data class returns null ──────────────────────────────

describe('extractDataClass — non-Data files', () => {
  it('returns null for plain PHP class', () => {
    const source = `<?php\nnamespace App\\Models;\nclass User extends Model {}`;
    expect(extractDataClass(source, 'app/Models/User.php')).toBeNull();
  });

  it('returns null for empty source', () => {
    expect(extractDataClass('', 'app/Data/Empty.php')).toBeNull();
  });
});

// ─── Inertia::render with Data props ─────────────────────────

describe('extractInertiaDataProps', () => {
  it('detects Data::from() prop', () => {
    const source = `<?php
use App\\Data\\UserData;
use App\\Data\\PostData;
use Inertia\\Inertia;

class UserController {
    public function show(User $user) {
        return Inertia::render('Users/Show', [
            'user' => UserData::from($user),
            'posts' => PostData::collect($user->posts),
        ]);
    }
}`;
    const props = extractInertiaDataProps(source);
    expect(props.length).toBe(2);

    const userProp = props.find((p) => p.propKey === 'user');
    expect(userProp).toBeDefined();
    expect(userProp!.dataClass).toBe('App\\Data\\UserData');
    expect(userProp!.isCollection).toBe(false);

    const postsProp = props.find((p) => p.propKey === 'posts');
    expect(postsProp).toBeDefined();
    expect(postsProp!.dataClass).toBe('App\\Data\\PostData');
    expect(postsProp!.isCollection).toBe(true);
  });

  it('returns empty array when no Data props present', () => {
    const source = `<?php
return Inertia::render('Home', ['title' => 'Hello']);`;
    expect(extractInertiaDataProps(source)).toHaveLength(0);
  });
});
