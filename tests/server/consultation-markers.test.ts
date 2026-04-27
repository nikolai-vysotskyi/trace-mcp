import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { markToolConsultation } from '../../src/server/consultation-markers.js';
import { projectHash } from '../../src/global.js';

const TEST_ROOT = path.join(os.tmpdir(), `trace-mcp-test-consultation-${process.pid}`);

function getMarkerDir(): string {
  return path.join(os.tmpdir(), `trace-mcp-consulted-${projectHash(path.resolve(TEST_ROOT))}`);
}

function fileHash(filePath: string): string {
  return crypto.createHash('sha256').update(filePath).digest('hex');
}

afterEach(() => {
  // Clean up marker files
  const dir = getMarkerDir();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* may not exist */
  }
});

describe('markToolConsultation', () => {
  describe('file extraction from tool params', () => {
    it('marks file from get_outline path param', () => {
      markToolConsultation(TEST_ROOT, 'get_outline', { path: 'src/server.ts' });

      const dir = getMarkerDir();
      const marker = path.join(dir, fileHash('src/server.ts'));
      expect(fs.existsSync(marker)).toBe(true);
    });

    it('marks file from get_outline file_path param', () => {
      markToolConsultation(TEST_ROOT, 'get_complexity_report', { file_path: 'src/index.ts' });

      const dir = getMarkerDir();
      const marker = path.join(dir, fileHash('src/index.ts'));
      expect(fs.existsSync(marker)).toBe(true);
    });

    it('extracts file from symbol_id for get_symbol', () => {
      markToolConsultation(TEST_ROOT, 'get_symbol', {
        symbol_id: 'src/server/tool-gate.ts::installToolGate#function',
      });

      const dir = getMarkerDir();
      const marker = path.join(dir, fileHash('src/server/tool-gate.ts'));
      expect(fs.existsSync(marker)).toBe(true);
    });

    it('extracts file from fqn fallback for find_usages', () => {
      markToolConsultation(TEST_ROOT, 'find_usages', {
        fqn: 'src/config.ts::TraceMcpConfig#interface',
      });

      const dir = getMarkerDir();
      const marker = path.join(dir, fileHash('src/config.ts'));
      expect(fs.existsSync(marker)).toBe(true);
    });

    it('extracts files from get_context_bundle symbol_ids array', () => {
      markToolConsultation(TEST_ROOT, 'get_context_bundle', {
        symbol_ids: ['src/a.ts::Foo#class', 'src/b.ts::Bar#function'],
      });

      const dir = getMarkerDir();
      expect(fs.existsSync(path.join(dir, fileHash('src/a.ts')))).toBe(true);
      expect(fs.existsSync(path.join(dir, fileHash('src/b.ts')))).toBe(true);
    });

    it('extracts file from register_edit file_path', () => {
      markToolConsultation(TEST_ROOT, 'register_edit', { file_path: 'src/edited.ts' });

      const dir = getMarkerDir();
      expect(fs.existsSync(path.join(dir, fileHash('src/edited.ts')))).toBe(true);
    });

    it('does nothing for unknown tools', () => {
      markToolConsultation(TEST_ROOT, 'unknown_tool', { path: 'src/foo.ts' });

      const dir = getMarkerDir();
      // Directory may or may not exist, but no markers should be written
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        expect(files).toHaveLength(0);
      }
    });

    it('handles symbol_id without :: gracefully', () => {
      markToolConsultation(TEST_ROOT, 'get_symbol', { symbol_id: 'noColons' });

      const dir = getMarkerDir();
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        expect(files).toHaveLength(0);
      }
    });
  });
});
