import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  extractMigrations,
  extractTimestamp,
} from '../../../src/indexer/plugins/integration/framework/laravel/migrations.js';

const L10_FIXTURE = path.resolve(__dirname, '../../fixtures/laravel-10');

describe('Laravel migration parsing', () => {
  describe('Schema::create (users table)', () => {
    const source = fs.readFileSync(
      path.join(L10_FIXTURE, 'database/migrations/2024_01_01_000000_create_users_table.php'),
      'utf-8',
    );
    const { migrations } = extractMigrations(
      source,
      'database/migrations/2024_01_01_000000_create_users_table.php',
    );

    it('extracts create operation', () => {
      expect(migrations).toHaveLength(1);
      expect(migrations[0].tableName).toBe('users');
      expect(migrations[0].operation).toBe('create');
    });

    it('extracts columns', () => {
      const columns = migrations[0].columns!;
      expect(columns.length).toBeGreaterThan(0);

      const idCol = columns.find((c) => (c as any).name === 'id');
      expect(idCol).toBeDefined();

      const nameCol = columns.find((c) => (c as any).name === 'name');
      expect(nameCol).toBeDefined();
      expect((nameCol as any).type).toBe('varchar');

      const emailCol = columns.find((c) => (c as any).name === 'email');
      expect(emailCol).toBeDefined();
      expect((emailCol as any).unique).toBe(true);

      const passwordCol = columns.find((c) => (c as any).name === 'password');
      expect(passwordCol).toBeDefined();
    });

    it('extracts timestamp columns', () => {
      const columns = migrations[0].columns!;
      const createdAt = columns.find((c) => (c as any).name === 'created_at');
      const updatedAt = columns.find((c) => (c as any).name === 'updated_at');
      expect(createdAt).toBeDefined();
      expect(updatedAt).toBeDefined();
    });

    it('extracts nullable columns', () => {
      const columns = migrations[0].columns!;
      const emailVerified = columns.find((c) => (c as any).name === 'email_verified_at');
      expect(emailVerified).toBeDefined();
      expect((emailVerified as any).nullable).toBe(true);
    });

    it('extracts timestamp from filename', () => {
      expect(migrations[0].timestamp).toBe('2024_01_01_000000');
    });
  });

  describe('Schema::create (posts table)', () => {
    const source = fs.readFileSync(
      path.join(L10_FIXTURE, 'database/migrations/2024_01_02_000000_create_posts_table.php'),
      'utf-8',
    );
    const { migrations } = extractMigrations(
      source,
      'database/migrations/2024_01_02_000000_create_posts_table.php',
    );

    it('extracts posts table', () => {
      expect(migrations).toHaveLength(1);
      expect(migrations[0].tableName).toBe('posts');
    });

    it('extracts foreign key column', () => {
      const columns = migrations[0].columns!;
      const userId = columns.find((c) => (c as any).name === 'user_id');
      expect(userId).toBeDefined();
      expect((userId as any).foreign).toBe(true);
    });
  });

  describe('Schema::table (alter)', () => {
    it('parses alter table migration', () => {
      const source = `<?php
return new class extends Migration {
    public function up(): void {
        Schema::table('users', function (Blueprint $table) {
            $table->string('phone')->nullable();
            $table->boolean('active')->default(true);
        });
    }
};`;
      const { migrations } = extractMigrations(
        source,
        'database/migrations/2024_02_01_000000_add_phone_to_users.php',
      );
      expect(migrations).toHaveLength(1);
      expect(migrations[0].operation).toBe('alter');
      expect(migrations[0].tableName).toBe('users');

      const columns = migrations[0].columns!;
      const phone = columns.find((c) => (c as any).name === 'phone');
      expect(phone).toBeDefined();
      expect((phone as any).nullable).toBe(true);
    });
  });

  describe('Schema::drop', () => {
    it('parses drop table', () => {
      const source = `<?php
return new class extends Migration {
    public function up(): void {
        Schema::dropIfExists('temp_data');
    }
};`;
      const { migrations } = extractMigrations(
        source,
        'database/migrations/2024_03_01_000000_drop_temp_data.php',
      );
      expect(migrations).toHaveLength(1);
      expect(migrations[0].operation).toBe('drop');
      expect(migrations[0].tableName).toBe('temp_data');
    });
  });

  describe('extractTimestamp()', () => {
    it('extracts timestamp from standard migration filename', () => {
      expect(extractTimestamp('database/migrations/2024_01_15_143022_create_users_table.php')).toBe(
        '2024_01_15_143022',
      );
    });

    it('returns undefined for non-migration filename', () => {
      expect(extractTimestamp('app/Models/User.php')).toBeUndefined();
    });
  });
});
