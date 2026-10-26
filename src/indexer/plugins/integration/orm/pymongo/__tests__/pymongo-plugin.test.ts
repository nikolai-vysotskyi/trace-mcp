import { describe, expect, it } from 'vitest';
import { classifyMongoOp, getLiteralString, parsePyMongoSource, PyMongoPlugin } from '../index.js';

describe('PyMongoPlugin Unit Tests', () => {
  const plugin = new PyMongoPlugin();

  describe('operation classification', () => {
    it('classifies read operations correctly', () => {
      expect(classifyMongoOp('find')).toBe('read');
      expect(classifyMongoOp('find_one')).toBe('read');
      expect(classifyMongoOp('aggregate')).toBe('read');
      expect(classifyMongoOp('count_documents')).toBe('read');
      expect(classifyMongoOp('distinct')).toBe('read');
    });

    it('classifies write operations correctly', () => {
      expect(classifyMongoOp('insert_one')).toBe('write');
      expect(classifyMongoOp('insert_many')).toBe('write');
      expect(classifyMongoOp('update_one')).toBe('write');
      expect(classifyMongoOp('update_many')).toBe('write');
      expect(classifyMongoOp('replace_one')).toBe('write');
      expect(classifyMongoOp('delete_one')).toBe('write');
      expect(classifyMongoOp('delete_many')).toBe('write');
      expect(classifyMongoOp('bulk_write')).toBe('write');
      expect(classifyMongoOp('find_one_and_delete')).toBe('write');
      expect(classifyMongoOp('find_one_and_replace')).toBe('write');
      expect(classifyMongoOp('find_one_and_update')).toBe('write');
    });

    it('returns null for non-mongo or unknown methods', () => {
      expect(classifyMongoOp('get')).toBeNull();
      expect(classifyMongoOp('items')).toBeNull();
      expect(classifyMongoOp('close')).toBeNull();
      expect(classifyMongoOp('ping')).toBeNull();
    });
  });

  describe('plugin schema and detection', () => {
    it('declares pymongo_reads and pymongo_writes edge types', () => {
      const schema = plugin.registerSchema();
      expect(schema.edgeTypes).toBeDefined();
      const names = schema.edgeTypes!.map((e) => e.name);
      expect(names).toContain('pymongo_reads');
      expect(names).toContain('pymongo_writes');
    });

    it('detects pymongo in requirements.txt or pyproject.toml', () => {
      const ctxWithDep = {
        rootPath: '/tmp/test',
        requirementsTxt: ['pymongo'],
        detectedVersions: [],
        allDependencies: [],
        configFiles: [],
      };
      expect(plugin.detect(ctxWithDep)).toBe(true);

      const ctxWithoutDep = {
        rootPath: '/tmp/test',
        requirementsTxt: ['requests'],
        detectedVersions: [],
        allDependencies: [],
        configFiles: [],
      };
      expect(plugin.detect(ctxWithoutDep)).toBe(false);
    });
  });

  describe('source parsing edge cases', () => {
    it('handles single-quoted, double-quoted and triple-quoted collection names', async () => {
      const code = `
def test_quotes():
    db['single'].find()
    db["double"].insert_one({})
    db["""triple"""].find_one()
`;
      const result = await parsePyMongoSource(code);
      expect(Array.from(result.collections).sort()).toEqual(['double', 'single', 'triple']);
      expect(result.operations).toHaveLength(3);
    });

    it('ignores dynamic names and expressions', async () => {
      const code = `
def test_dynamic(name):
    var = "orders"
    db[var].find()
    db[name].insert_one({})
    db.get_collection(name).find()
    f_str = f"prefix_{name}"
    db[f_str].find()
`;
      const result = await parsePyMongoSource(code);
      // var is not a string literal in the subscript
      expect(result.collections.size).toBe(0);
      expect(result.operations).toHaveLength(0);
    });

    it('handles custom local helper returning collection', async () => {
      const code = `
def my_col_helper(cname):
    return db[cname]

def worker():
    col = my_col_helper("tasks")
    col.update_one({"id": 1}, {"$set": {"done": True}})
`;
      const result = await parsePyMongoSource(code);
      expect(result.collections.has('tasks')).toBe(true);
      expect(result.operations).toHaveLength(1);
      expect(result.operations[0].collection).toBe('tasks');
      expect(result.operations[0].op).toBe('write');
      expect(result.operations[0].method).toBe('update_one');
    });
  });
});
