import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { projectHash, STATUS_DIR } from '../../src/global.js';
import {
  __resetConsultationMarkersForTests,
  canonicalMarkerKey,
  markToolConsultation,
} from '../../src/server/consultation-markers.js';

const TEST_ROOT = path.join(os.tmpdir(), `trace-mcp-test-consultation-${process.pid}`);

function markerDirName(): string {
  return `trace-mcp-consulted-${projectHash(path.resolve(TEST_ROOT))}`;
}

function getMarkerDir(): string {
  return path.join(os.tmpdir(), markerDirName());
}

/** Where a current server writes markers — see STATUS_DIR (TRA-869). */
function getStateHomeMarkerDir(): string {
  return path.join(STATUS_DIR, markerDirName());
}

function fileHash(filePath: string): string {
  return crypto.createHash('sha256').update(filePath).digest('hex');
}

afterEach(() => {
  // Clean up marker files — both locations the server writes.
  for (const dir of [getMarkerDir(), getStateHomeMarkerDir()]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* may not exist */
    }
  }
  // Reset the per-process dedup caches so the next test re-creates the wiped dir.
  __resetConsultationMarkersForTests();
});

describe('markToolConsultation', () => {
  // TRA-869: the guard hook reads these markers from a process that does not
  // share the server's $TMPDIR, so a marker written only there is invisible and
  // the guard denies a Read the agent already consulted trace-mcp about.
  it('writes the marker under the state home as well as $TMPDIR', () => {
    markToolConsultation(TEST_ROOT, 'get_outline', { path: 'src/cross-tmpdir.ts' });
    const name = fileHash('src/cross-tmpdir.ts');
    expect(fs.existsSync(path.join(getStateHomeMarkerDir(), name))).toBe(true);
    expect(fs.existsSync(path.join(getMarkerDir(), name))).toBe(true);
  });

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

  // TRA-1737: the server hashed the raw params.path while the guard hook
  // hashed its own spelling — `./x`, absolute, and root-dirname-prefixed
  // variants of one file never matched. Both sides now canonicalize.
  describe('canonicalMarkerKey', () => {
    const base = path.basename(TEST_ROOT);

    it('folds ./, absolute, and root-dirname-prefixed spellings to one key', () => {
      const canonical = canonicalMarkerKey('src/a.ts', TEST_ROOT);
      expect(canonical).toBe('src/a.ts');
      expect(canonicalMarkerKey('./src/a.ts', TEST_ROOT)).toBe(canonical);
      expect(canonicalMarkerKey(path.join(TEST_ROOT, 'src/a.ts'), TEST_ROOT)).toBe(canonical);
      expect(canonicalMarkerKey(`${base}/src/a.ts`, TEST_ROOT)).toBe(canonical);
    });

    it('leaves outside-root paths untouched for downstream guards', () => {
      expect(canonicalMarkerKey('/other/x.ts', TEST_ROOT)).toBe('/other/x.ts');
      expect(canonicalMarkerKey('../evil.ts', TEST_ROOT)).toBe('../evil.ts');
    });

    it('markToolConsultation writes the canonical key for an absolute path', () => {
      markToolConsultation(TEST_ROOT, 'get_outline', {
        path: path.join(TEST_ROOT, 'src/abs.ts'),
      });

      const dir = getMarkerDir();
      expect(fs.existsSync(path.join(dir, fileHash('src/abs.ts')))).toBe(true);
    });

    it('markToolConsultation collapses the root-dirname prefix', () => {
      markToolConsultation(TEST_ROOT, 'get_outline', { path: `${base}/src/prefixed.ts` });

      const dir = getMarkerDir();
      expect(fs.existsSync(path.join(dir, fileHash('src/prefixed.ts')))).toBe(true);
    });

    it('markToolConsultation strips ./ spellings', () => {
      markToolConsultation(TEST_ROOT, 'get_outline', { path: './src/dotted.ts' });

      const dir = getMarkerDir();
      expect(fs.existsSync(path.join(dir, fileHash('src/dotted.ts')))).toBe(true);
    });
  });

  // TRA-2426: when running on a root session ('/') or container root, markers must
  // be recorded for the actual target project root and any intermediate directory with a sentinel
  describe('multi-root and container consultation targets (TRA-2426)', () => {
    it('writes markers to registered ancestor and child project', async () => {
      const { registerProject, unregisterProject } = await import('../../src/registry.js');
      const parentDir = path.join(os.tmpdir(), `trace-parent-${process.pid}`);
      const childDir = path.join(parentDir, 'my-subproject');
      fs.mkdirSync(childDir, { recursive: true });
      const testFile = path.join(childDir, 'deep.ts');
      fs.writeFileSync(testFile, 'export const a = 1;');

      registerProject(parentDir);
      registerProject(childDir);

      try {
        markToolConsultation(parentDir, 'get_outline', {
          path: 'my-subproject/deep.ts',
        });

        // Parent should have marker for my-subproject/deep.ts
        const parentMarkerDir = path.join(
          STATUS_DIR,
          `trace-mcp-consulted-${projectHash(parentDir)}`,
        );
        expect(fs.existsSync(path.join(parentMarkerDir, fileHash('my-subproject/deep.ts')))).toBe(
          true,
        );

        // Child should have marker for deep.ts
        const childMarkerDir = path.join(
          STATUS_DIR,
          `trace-mcp-consulted-${projectHash(childDir)}`,
        );
        expect(fs.existsSync(path.join(childMarkerDir, fileHash('deep.ts')))).toBe(true);
      } finally {
        unregisterProject(childDir);
        unregisterProject(parentDir);
        fs.rmSync(parentDir, { recursive: true, force: true });
        for (const dir of [
          path.join(STATUS_DIR, `trace-mcp-consulted-${projectHash(parentDir)}`),
          path.join(STATUS_DIR, `trace-mcp-consulted-${projectHash(childDir)}`),
        ]) {
          try {
            fs.rmSync(dir, { recursive: true, force: true });
          } catch {}
        }
      }
    });

    it('writes markers to child project when called from a root session with absolute path', async () => {
      const { registerProject, unregisterProject } = await import('../../src/registry.js');
      const projDir = path.join(os.tmpdir(), `trace-root-session-target-${process.pid}`);
      fs.mkdirSync(projDir, { recursive: true });
      const testFile = path.join(projDir, 'index.ts');
      fs.writeFileSync(testFile, 'export const b = 2;');

      registerProject(projDir);

      try {
        markToolConsultation('/', 'get_outline', {
          path: testFile,
        });

        const targetMarkerDir = path.join(
          STATUS_DIR,
          `trace-mcp-consulted-${projectHash(projDir)}`,
        );
        expect(fs.existsSync(path.join(targetMarkerDir, fileHash('index.ts')))).toBe(true);
      } finally {
        unregisterProject(projDir);
        fs.rmSync(projDir, { recursive: true, force: true });
        try {
          fs.rmSync(path.join(STATUS_DIR, `trace-mcp-consulted-${projectHash(projDir)}`), {
            recursive: true,
            force: true,
          });
        } catch {}
      }
    });

    it('writes markers for intermediate directory with active sentinel', async () => {
      const { registerProject, unregisterProject } = await import('../../src/registry.js');
      const topDir = path.join(os.tmpdir(), `trace-sentinel-top-${process.pid}`);
      const midDir = path.join(topDir, 'mid-dir');
      const subDir = path.join(midDir, 'sub-dir');
      fs.mkdirSync(subDir, { recursive: true });
      const testFile = path.join(subDir, 'app.vue');
      fs.writeFileSync(testFile, '<template></template>');

      registerProject(topDir);

      // Create an active sentinel in midDir
      const midHash = projectHash(midDir);
      const sentinelPath = path.join(STATUS_DIR, `trace-mcp-alive-${midHash}`);
      fs.writeFileSync(sentinelPath, String(Date.now()));

      try {
        markToolConsultation(topDir, 'get_outline', {
          path: path.join('mid-dir', 'sub-dir', 'app.vue'),
        });

        // midDir had a sentinel, so it should receive a marker for canonical path sub-dir/app.vue
        const midMarkerDir = path.join(STATUS_DIR, `trace-mcp-consulted-${midHash}`);
        expect(fs.existsSync(path.join(midMarkerDir, fileHash('sub-dir/app.vue')))).toBe(true);
      } finally {
        unregisterProject(topDir);
        fs.rmSync(sentinelPath, { force: true });
        fs.rmSync(topDir, { recursive: true, force: true });
        try {
          fs.rmSync(path.join(STATUS_DIR, `trace-mcp-consulted-${midHash}`), {
            recursive: true,
            force: true,
          });
        } catch {}
      }
    });
  });
});
