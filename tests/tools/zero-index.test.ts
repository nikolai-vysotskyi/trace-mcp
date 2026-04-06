import { describe, test, expect, beforeEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createTestStore } from '../test-utils.js';
import { isIndexStale, fallbackSearch, fallbackOutline } from '../../src/tools/navigation/zero-index.js';

const TEST_DIR = path.join(tmpdir(), 'trace-mcp-zeroindex-test-' + process.pid);

function writeFile(relPath: string, content: string): void {
  const absPath = path.join(TEST_DIR, relPath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, content);
}

describe('Zero-index fallback', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  // -------------------------------------------------------------------
  // isIndexStale
  // -------------------------------------------------------------------

  describe('isIndexStale', () => {
    test('returns stale for empty index', () => {
      const store = createTestStore();
      const result = isIndexStale(store);
      expect(result.stale).toBe(true);
      expect(result.reason).toContain('empty');
    });

    test('returns not stale for fresh index', () => {
      const store = createTestStore();
      store.insertFile('src/a.ts', 'typescript', 'h1', 100);
      const result = isIndexStale(store);
      expect(result.stale).toBe(false);
    });

    test('returns stale for old index', () => {
      const store = createTestStore();
      // Manually insert with old timestamp
      store.db.prepare(
        "INSERT INTO files (path, language, content_hash, byte_length, indexed_at) VALUES (?, ?, ?, ?, datetime('now', '-120 minutes'))"
      ).run('src/old.ts', 'typescript', 'h1', 100);
      const result = isIndexStale(store, 60);
      expect(result.stale).toBe(true);
      expect(result.reason).toContain('minutes old');
    });
  });

  // -------------------------------------------------------------------
  // fallbackSearch
  // -------------------------------------------------------------------

  describe('fallbackSearch', () => {
    test('finds text matches in files', () => {
      writeFile('src/app.ts', `
export function handleRequest(req: Request) {
  const userId = req.params.id;
  return findUser(userId);
}
`);
      writeFile('src/utils.ts', `
export function findUser(id: string) {
  return db.query('SELECT * FROM users WHERE id = ?', [id]);
}
`);

      const result = fallbackSearch(TEST_DIR, 'findUser');
      expect(result.fallback).toBe(true);
      expect(result.matches.length).toBeGreaterThanOrEqual(1);
      expect(result.hint).toContain('reindex');
    });

    test('returns empty for no matches', () => {
      writeFile('src/empty.ts', 'const x = 1;');
      const result = fallbackSearch(TEST_DIR, 'nonexistent_symbol_xyz');
      expect(result.matches).toHaveLength(0);
    });

    test('respects maxResults', () => {
      // Create many files with matches
      for (let i = 0; i < 10; i++) {
        writeFile(`src/file${i}.ts`, `const match = 'findMe_${i}'; findMe();`);
      }
      const result = fallbackSearch(TEST_DIR, 'findMe', { maxResults: 3 });
      expect(result.matches.length).toBeLessThanOrEqual(3);
    });

    test('match has file, line, text fields', () => {
      writeFile('src/test.ts', 'const hello = "world";');
      const result = fallbackSearch(TEST_DIR, 'hello');
      if (result.matches.length > 0) {
        const m = result.matches[0];
        expect(m.file).toBeDefined();
        expect(m.line).toBeDefined();
        expect(typeof m.line).toBe('number');
        expect(m.text).toContain('hello');
      }
    });
  });

  // -------------------------------------------------------------------
  // fallbackOutline
  // -------------------------------------------------------------------

  describe('fallbackOutline', () => {
    test('extracts TypeScript symbols', () => {
      writeFile('src/models.ts', `
export class User {
  constructor(public name: string) {}
}

export interface UserRepository {
  findById(id: string): User;
}

export function createUser(name: string): User {
  return new User(name);
}

export const DEFAULT_NAME = 'anonymous';

export type UserId = string;

export enum Role {
  Admin,
  User,
}
`);

      const result = fallbackOutline(TEST_DIR, 'src/models.ts');
      expect(result.fallback).toBe(true);
      expect(result.file).toBe('src/models.ts');

      const names = result.symbols.map((s) => s.name);
      expect(names).toContain('User');
      expect(names).toContain('UserRepository');
      expect(names).toContain('createUser');
      expect(names).toContain('DEFAULT_NAME');
      expect(names).toContain('UserId');
      expect(names).toContain('Role');

      const userSym = result.symbols.find((s) => s.name === 'User');
      expect(userSym?.kind).toBe('class');
      expect(userSym?.line).toBeGreaterThan(0);
    });

    test('extracts Python symbols', () => {
      writeFile('src/app.py', `
class UserService:
    def get_user(self, user_id: str):
        pass

async def process_request(data):
    pass
`);

      const result = fallbackOutline(TEST_DIR, 'src/app.py');
      const names = result.symbols.map((s) => s.name);
      expect(names).toContain('UserService');
      expect(names).toContain('get_user');
      expect(names).toContain('process_request');
    });

    test('extracts Go symbols', () => {
      writeFile('src/main.go', `
package main

type UserService struct {
    db *sql.DB
}

func (s *UserService) GetUser(id string) (*User, error) {
    return nil, nil
}

func main() {
    fmt.Println("hello")
}
`);

      const result = fallbackOutline(TEST_DIR, 'src/main.go');
      const names = result.symbols.map((s) => s.name);
      expect(names).toContain('UserService');
      expect(names).toContain('GetUser');
      expect(names).toContain('main');
    });

    test('extracts Rust symbols', () => {
      writeFile('src/lib.rs', `
pub struct Config {
    port: u16,
}

pub enum Status {
    Active,
    Inactive,
}

pub trait Handler {
    fn handle(&self);
}

pub async fn serve(config: Config) {
    // ...
}
`);

      const result = fallbackOutline(TEST_DIR, 'src/lib.rs');
      const names = result.symbols.map((s) => s.name);
      expect(names).toContain('Config');
      expect(names).toContain('Status');
      expect(names).toContain('Handler');
      expect(names).toContain('serve');
    });

    test('symbols are sorted by line', () => {
      writeFile('src/sorted.ts', `
const A = 1;
function B() {}
class C {}
`);

      const result = fallbackOutline(TEST_DIR, 'src/sorted.ts');
      for (let i = 1; i < result.symbols.length; i++) {
        expect(result.symbols[i].line).toBeGreaterThanOrEqual(result.symbols[i - 1].line);
      }
    });

    test('hint suggests reindexing', () => {
      writeFile('src/x.ts', 'const x = 1;');
      const result = fallbackOutline(TEST_DIR, 'src/x.ts');
      expect(result.hint).toContain('reindex');
    });
  });
});
