import { describe, expect, it } from 'vitest';
import { AsyncDbPlugin } from '../../../src/indexer/plugins/integration/orm/async-db/index.js';

const plugin = new AsyncDbPlugin();

function extract(code: string, filePath = 'app/db.py') {
  const result = plugin.extractNodes(filePath, Buffer.from(code), 'python');
  if (!result.isOk()) {
    throw new Error(`AsyncDbPlugin failed: ${JSON.stringify(result._unsafeUnwrapErr())}`);
  }
  return result._unsafeUnwrap();
}

describe('AsyncDbPlugin', () => {
  it('has correct manifest', () => {
    expect(plugin.manifest.name).toBe('async-db');
    expect(plugin.manifest.category).toBe('orm');
  });

  it('skips non-Python files', () => {
    const result = plugin.extractNodes('app/db.ts', Buffer.from(''), 'typescript');
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().symbols!.length).toBe(0);
  });

  it('skips Python files without async DB imports', () => {
    const result = extract(`
import os

def get_config():
    return os.environ.get("DB_URL")
    `);
    expect(result.edges!.length).toBe(0);
  });

  // ─── asyncpg ───────────────────────────────────────────────

  describe('asyncpg', () => {
    it('extracts pool.fetch() queries', () => {
      const result = extract(`
import asyncpg

async def get_users(pool):
    rows = await pool.fetch("SELECT id, name, email FROM users WHERE active = $1", True)
    return rows
      `);
      const queryEdges = result.edges!.filter((e) => e.edgeType === 'async_db_query');
      expect(queryEdges.length).toBe(1);
      expect(queryEdges[0].metadata?.tables).toContain('users');
      expect(queryEdges[0].metadata?.driver).toBe('asyncpg');
    });

    it('extracts pool.fetchrow()', () => {
      const result = extract(`
import asyncpg

async def get_user(pool, user_id):
    return await pool.fetchrow("SELECT * FROM users WHERE id = $1", user_id)
      `);
      const edges = result.edges!.filter((e) => e.edgeType === 'async_db_query');
      expect(edges.length).toBeGreaterThanOrEqual(1);
      expect(edges[0].metadata?.tables).toContain('users');
    });

    it('extracts pool.execute() mutations', () => {
      const result = extract(`
import asyncpg

async def create_user(pool, name, email):
    await pool.execute(
        "INSERT INTO users (name, email) VALUES ($1, $2)",
        name, email,
    )
      `);
      const edges = result.edges!.filter((e) => e.edgeType === 'async_db_mutation');
      expect(edges.length).toBeGreaterThanOrEqual(1);
      expect(edges[0].metadata?.tables).toContain('users');
    });

    it('extracts conn.prepare()', () => {
      const result = extract(`
import asyncpg

async def batch_insert(conn):
    stmt = await conn.prepare("INSERT INTO events (type, data) VALUES ($1, $2)")
    await stmt.executemany(records)
      `);
      const edges = result.edges!.filter((e) => e.edgeType === 'async_db_mutation');
      expect(edges.length).toBeGreaterThanOrEqual(1);
      expect(edges[0].metadata?.tables).toContain('events');
    });

    it('extracts pool creation', () => {
      const result = extract(`
import asyncpg

async def init_db():
    pool = await asyncpg.create_pool(dsn="postgresql://localhost/mydb")
    return pool
      `);
      const poolEdges = result.edges!.filter((e) => e.edgeType === 'async_db_pool');
      expect(poolEdges.length).toBe(1);
      expect(result.frameworkRole).toBe('db_config');
    });

    it('extracts DDL statements', () => {
      const result = extract(`
import asyncpg

async def create_tables(conn):
    await conn.execute("CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT NOT NULL)")
      `);
      const edges = result.edges!.filter((e) => e.edgeType === 'async_db_schema');
      expect(edges.length).toBeGreaterThanOrEqual(1);
      expect(edges[0].metadata?.tables).toContain('users');
      expect(result.frameworkRole).toBe('db_schema');
    });

    it('extracts multiple table references from JOINs', () => {
      const result = extract(`
import asyncpg

async def get_user_orders(pool, user_id):
    return await pool.fetch(
        "SELECT u.name, o.total FROM users u JOIN orders o ON u.id = o.user_id WHERE u.id = $1",
        user_id,
    )
      `);
      const edges = result.edges!.filter((e) => e.edgeType === 'async_db_query');
      expect(edges.length).toBeGreaterThanOrEqual(1);
      expect(edges[0].metadata?.tables).toContain('users');
      expect(edges[0].metadata?.tables).toContain('orders');
    });
  });

  // ─── databases (encode/databases) ──────────────────────────

  describe('databases', () => {
    it('extracts database.fetch_all()', () => {
      const result = extract(`
from databases import Database

database = Database("postgresql://localhost/mydb")

async def list_posts():
    return await database.fetch_all("SELECT * FROM posts ORDER BY created_at DESC")
      `);
      const edges = result.edges!.filter((e) => e.edgeType === 'async_db_query');
      expect(edges.length).toBeGreaterThanOrEqual(1);
      expect(edges[0].metadata?.tables).toContain('posts');
      expect(edges[0].metadata?.driver).toBe('databases');
    });

    it('extracts database.execute()', () => {
      const result = extract(`
from databases import Database

async def update_post(database, post_id, title):
    await database.execute("UPDATE posts SET title = :title WHERE id = :id", {"title": title, "id": post_id})
      `);
      const edges = result.edges!.filter((e) => e.edgeType === 'async_db_mutation');
      expect(edges.length).toBeGreaterThanOrEqual(1);
      expect(edges[0].metadata?.tables).toContain('posts');
    });
  });

  // ─── aiosqlite ─────────────────────────────────────────────

  describe('aiosqlite', () => {
    it('extracts cursor.execute()', () => {
      const result = extract(`
import aiosqlite

async def get_items(db_path):
    async with aiosqlite.connect(db_path) as db:
        cursor = await db.execute("SELECT * FROM items WHERE active = 1")
        return await cursor.fetchall()
      `);
      const edges = result.edges!.filter((e) => e.edgeType === 'async_db_query');
      expect(edges.length).toBeGreaterThanOrEqual(1);
      expect(edges[0].metadata?.tables).toContain('items');
    });
  });

  // ─── Transaction detection ─────────────────────────────────

  describe('transactions', () => {
    it('detects transaction blocks', () => {
      const result = extract(`
import asyncpg

async def transfer(pool, from_id, to_id, amount):
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute("UPDATE accounts SET balance = balance - $1 WHERE id = $2", amount, from_id)
            await conn.execute("UPDATE accounts SET balance = balance + $1 WHERE id = $2", amount, to_id)
      `);
      const mutationEdges = result.edges!.filter((e) => e.edgeType === 'async_db_mutation');
      expect(mutationEdges.length).toBeGreaterThanOrEqual(2);
      expect(mutationEdges[0].metadata?.tables).toContain('accounts');
    });
  });

  // ─── Tortoise ORM ──────────────────────────────────────────

  describe('tortoise-orm', () => {
    it('extracts Model.filter() operations', () => {
      const result = extract(`
from tortoise.models import Model

class User(Model):
    pass

async def get_active_users():
    users = await User.filter(active=True).all()
    return users
      `);
      const edges = result.edges!.filter((e) => e.edgeType === 'tortoise_model_op');
      expect(edges.length).toBeGreaterThanOrEqual(1);
      expect(edges[0].metadata?.model).toBe('User');
      expect(edges[0].metadata?.operation).toBe('filter');
    });

    it('extracts Model.create()', () => {
      const result = extract(`
from tortoise.models import Model

async def create_user(name, email):
    user = await User.create(name=name, email=email)
    return user
      `);
      const edges = result.edges!.filter((e) => e.edgeType === 'tortoise_model_op');
      expect(edges.length).toBeGreaterThanOrEqual(1);
      expect(edges[0].metadata?.model).toBe('User');
      expect(edges[0].metadata?.operation).toBe('create');
    });
  });

  // ─── Metadata ──────────────────────────────────────────────

  describe('metadata', () => {
    it('collects referenced table names', () => {
      const result = extract(`
import asyncpg

async def complex_query(pool):
    await pool.fetch("SELECT * FROM users")
    await pool.fetch("SELECT * FROM orders")
    await pool.execute("INSERT INTO audit_log (action) VALUES ($1)", "query")
      `);
      const dbMeta = result.symbols!.find((s) => s.name === '__async_db__');
      expect(dbMeta).toBeDefined();
      const tables = dbMeta!.metadata?.tables as string[];
      expect(tables).toContain('users');
      expect(tables).toContain('orders');
      expect(tables).toContain('audit_log');
    });
  });
});
