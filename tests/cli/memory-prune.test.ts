import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DecisionStore } from '../../src/memory/decision-store.js';

describe('trace-mcp memory prune CLI (TRA-595)', () => {
  let tmpHome: string;
  let dbPath: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-mem-prune-'));
    vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
    dbPath = path.join(tmpHome, 'decisions.db');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('runs dry-run and reports stale roots without deleting', async () => {
    const store = new DecisionStore(dbPath);
    const deadDir = path.join(tmpHome, 'deleted-project');
    fs.mkdirSync(deadDir, { recursive: true });

    store.addDecision({
      title: 'Dead decision',
      content: 'Some dead content',
      type: 'tech_choice',
      project_root: deadDir,
    });
    store.close();

    // Delete folder
    fs.rmSync(deadDir, { recursive: true, force: true });

    const checkStore = new DecisionStore(dbPath);
    const stale = checkStore.findStale();
    expect(stale.staleRoots).toEqual([deadDir]);
    expect(stale.decisionsCount).toBe(1);

    // Dry-run prune does not delete
    const dryRunResult = { apply: false, ...stale };
    expect(dryRunResult.apply).toBe(false);
    expect(checkStore.queryDecisions({ project_root: deadDir })).toHaveLength(1);

    // Apply prune deletes
    const applyResult = checkStore.pruneStale();
    expect(applyResult.decisions).toBe(1);
    expect(checkStore.queryDecisions({ project_root: deadDir })).toHaveLength(0);
    checkStore.close();
  });

  describe('prune --low-quality (TRA-1619B)', () => {
    // The CLI resolves its database path at import time, so (like
    // env-overrides.test.ts) we drive it from a subprocess with a hermetic
    // TRACE_MCP_DATA_DIR instead of stubbing env in-process.
    it('reports fragments in JSON dry-run and invalidates with --apply', () => {
      // A real on-disk project root: --apply also runs the stale-root prune,
      // which would delete rows filed under a nonexistent root.
      const projDir = path.join(tmpHome, 'proj');
      fs.mkdirSync(projDir, { recursive: true });
      const script = `
        (async () => {
        const { DecisionStore } = await import('./src/memory/decision-store.ts');
        const { memoryCommand } = await import('./src/cli/memory.ts');
        const { DECISIONS_DB_PATH } = await import('./src/global.ts');
        if (!DECISIONS_DB_PATH.startsWith(process.env.TRACE_MCP_DATA_DIR)) {
          console.log('GUARD_FAIL:' + DECISIONS_DB_PATH);
          process.exit(2);
        }
        const PROJ = process.env.PROJ_DIR;
        const seed = new DecisionStore(DECISIONS_DB_PATH);
        seed.addDecision({ title: 'my changes', content: 'A real English summary long enough to pass the content-length floor here.', type: 'tech_choice', project_root: PROJ, source: 'mined', confidence: 0.8 });
        seed.addDecision({ title: 'Use PostgreSQL over MySQL for JSONB support', content: 'We chose PostgreSQL because its JSONB indexing fits our query patterns better than MySQL.', type: 'tech_choice', project_root: PROJ, source: 'mined', confidence: 0.85 });
        seed.close();
        const out = [];
        const orig = console.log;
        console.log = (...a) => { out.push(a.join(' ')); };
        await memoryCommand.parseAsync(['prune', '--low-quality', '--json'], { from: 'user' });
        orig('DRY:' + out.join('\\n'));
        out.length = 0;
        await memoryCommand.parseAsync(['prune', '--low-quality', '--apply', '--json'], { from: 'user' });
        orig('APPLIED:' + out.join('\\n'));
        const check = new DecisionStore(DECISIONS_DB_PATH);
        const gone = check.queryDecisions({ project_root: PROJ, include_invalidated: true });
        const live = check.queryDecisions({ project_root: PROJ });
        check.close();
        orig('VERIFY:' + JSON.stringify({ invalidated: gone.filter((d) => d.valid_until !== null).length, live: live.map((d) => d.title) }));
        })();
      `;
      const repoRoot = path.join(__dirname, '..', '..');
      // Cross-platform: run the in-repo node with the tsx ESM loader rather
      // than the node_modules/.bin/tsx shim (not directly executable on
      // Windows). `--input-type=module` pairs with `-e` like elsewhere. The
      // loader path must be a file:// URL — bare absolute paths are rejected
      // by the ESM loader on Windows (ERR_UNSUPPORTED_ESM_URL_SCHEME).
      const tsxLoader = pathToFileURL(
        path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs'),
      ).href;
      const res = execFileSync(
        process.execPath,
        ['--import', tsxLoader, '--input-type=module', '-e', script],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            TRACE_MCP_DATA_DIR: tmpHome,
            PROJ_DIR: projDir,
            NODE_OPTIONS: '',
          },
          encoding: 'utf-8',
        },
      );
      expect(res).not.toMatch(/GUARD_FAIL/);
      // The CLI pretty-prints JSON, so a marker block spans lines: accumulate
      // until the top-level closing brace (column 0 — nested closes indent).
      function extractBlock(
        output: string,
        marker: string,
      ): {
        apply: boolean;
        low_quality: { scanned: number; invalidated: number; rows: unknown[] };
      } {
        const lines = output.split('\n');
        const start = lines.findIndex((l) => l.startsWith(marker));
        if (start === -1) throw new Error(`marker ${marker} missing in CLI output`);
        const buf = [lines[start].slice(marker.length)];
        for (let i = start + 1; i < lines.length; i++) {
          buf.push(lines[i]);
          if (lines[i] === '}') break;
        }
        return JSON.parse(buf.join('\n')) as {
          apply: boolean;
          low_quality: { scanned: number; invalidated: number; rows: unknown[] };
        };
      }
      const dry = extractBlock(res, 'DRY:');
      expect(dry.apply).toBe(false);
      expect(dry.low_quality.scanned).toBe(2);
      expect(dry.low_quality.invalidated).toBe(0);
      expect(dry.low_quality.rows).toHaveLength(1);

      const applied = extractBlock(res, 'APPLIED:');
      expect(applied.apply).toBe(true);
      expect(applied.low_quality.invalidated).toBe(1);

      const verifyLine = res.split('\n').find((l) => l.startsWith('VERIFY:'))!;
      const verify = JSON.parse(verifyLine.slice('VERIFY:'.length)) as {
        invalidated: number;
        live: string[];
      };
      expect(verify.invalidated).toBe(1);
      expect(verify.live).toEqual(['Use PostgreSQL over MySQL for JSONB support']);
    });
  });
});
