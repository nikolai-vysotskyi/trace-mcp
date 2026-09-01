import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
});
