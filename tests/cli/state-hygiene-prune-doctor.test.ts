import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('state hygiene prune & doctor integration (TRA-1259)', () => {
  let tmpHome: string;
  let globalConfigPath: string;
  let pruneModule: typeof import('../../src/cli/prune.js');
  let doctorModule: typeof import('../../src/cli/doctor.js');
  const DAY_MS = 24 * 60 * 60 * 1000;

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-state-hygiene-'));
    vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
    vi.resetModules();
    const globalMod = await import('../../src/global.js');
    globalConfigPath = globalMod.GLOBAL_CONFIG_PATH;
    pruneModule = await import('../../src/cli/prune.js');
    doctorModule = await import('../../src/cli/doctor.js');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function writeConfig(projects: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
    fs.writeFileSync(globalConfigPath, JSON.stringify({ projects }, null, 2));
  }

  function readConfig(): { projects?: Record<string, unknown> } {
    if (!fs.existsSync(globalConfigPath)) return {};
    return JSON.parse(fs.readFileSync(globalConfigPath, 'utf-8'));
  }

  function createOldTmpFile(subDir: string, name: string): string {
    const dir = path.join(tmpHome, subDir);
    fs.mkdirSync(dir, { recursive: true });
    const full = path.join(dir, name);
    fs.writeFileSync(full, 'stale tmp');
    const oldTime = (Date.now() - 2 * DAY_MS) / 1000;
    fs.utimesSync(full, oldTime, oldTime);
    return full;
  }

  it('prune: scans and cleans dead project config sections', () => {
    const deadRoot = path.join(tmpHome, 'dead-project');
    writeConfig({
      [deadRoot]: { ai: { enabled: true } },
    });

    // Dry-run
    const dry = pruneModule.scanOrPruneConfig(false);
    expect(dry.prunableSections).toEqual([deadRoot]);
    expect(dry.removedSections).toEqual([]);
    expect(readConfig().projects?.[deadRoot]).toBeDefined();

    // Apply
    const apply = pruneModule.scanOrPruneConfig(true);
    expect(apply.prunableSections).toEqual([deadRoot]);
    expect(apply.removedSections).toEqual([deadRoot]);
    expect(readConfig().projects?.[deadRoot]).toBeUndefined();
  });

  it('prune: scans and cleans orphan .tmp.* files across state directories', () => {
    const orphanRootTmp = createOldTmpFile('', '.config.json.tmp.12345.0123456789ab');
    const orphanSessionTmp = createOldTmpFile('sessions', '.session.tmp.54321.fedcba987654');

    // Dry-run
    const dry = pruneModule.scanOrPruneTmpFiles(false);
    expect(dry.staleTmpFiles).toContain(orphanRootTmp);
    expect(dry.staleTmpFiles).toContain(orphanSessionTmp);
    expect(dry.removedTmpFiles).toEqual([]);
    expect(fs.existsSync(orphanRootTmp)).toBe(true);
    expect(fs.existsSync(orphanSessionTmp)).toBe(true);

    // Apply
    const apply = pruneModule.scanOrPruneTmpFiles(true);
    expect(apply.removedTmpFiles).toContain(orphanRootTmp);
    expect(apply.removedTmpFiles).toContain(orphanSessionTmp);
    expect(fs.existsSync(orphanRootTmp)).toBe(false);
    expect(fs.existsSync(orphanSessionTmp)).toBe(false);
  });

  it('doctor: diagnoses and fixes state hygiene issues', () => {
    const deadRoot = path.join(tmpHome, 'dead-doctor-project');
    writeConfig({
      [deadRoot]: { watch: { enabled: false } },
    });
    const orphanTmp = createOldTmpFile('locks', 'test.tmp.99999.112233445566');

    // Diagnose
    const report = doctorModule.diagnoseStateHygiene();
    expect(report.prunableConfigSections).toEqual([deadRoot]);
    expect(report.staleTmpFiles).toEqual([orphanTmp]);
    expect(report.staleCount).toBe(2);

    // Fix dry-run
    const dryFix = doctorModule.fixStateHygiene(report, { dryRun: true });
    expect(dryFix.removedConfigSections).toEqual([deadRoot]);
    expect(dryFix.removedTmpFiles).toEqual([orphanTmp]);
    expect(readConfig().projects?.[deadRoot]).toBeDefined();
    expect(fs.existsSync(orphanTmp)).toBe(true);

    // Fix apply
    const applyFix = doctorModule.fixStateHygiene(report, { dryRun: false });
    expect(applyFix.removedConfigSections).toEqual([deadRoot]);
    expect(applyFix.removedTmpFiles).toEqual([orphanTmp]);
    expect(readConfig().projects?.[deadRoot]).toBeUndefined();
    expect(fs.existsSync(orphanTmp)).toBe(false);

    // Re-diagnose is clean
    const postFixReport = doctorModule.diagnoseStateHygiene();
    expect(postFixReport.staleCount).toBe(0);
  });
});
