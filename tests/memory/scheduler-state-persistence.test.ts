/**
 * Persistence tests for the `scheduler_state` table + scheduler
 * hydration on start. Covers:
 *   - upsert insert-then-update merge semantics
 *   - partial-field updates do not clobber other columns
 *   - getSchedulerState returns row when present, undefined when not
 *   - consecutive_failures default + increment
 *   - scheduler integration: state survives "restart" (new instance
 *     pointing at the same store sees hydrated timestamps).
 *
 * The test re-points TRACE_MCP_DATA_DIR at a per-process tmp dir before
 * any module imports so the scheduler's lazy DecisionStore opens never
 * touch the real ~/.trace-mcp/decisions.db file.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

const sharedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-state-home-'));
process.env.TRACE_MCP_DATA_DIR = sharedHome;

const { DecisionStore } = await import('../../src/memory/decision-store.js');
const { MemoryScheduler } = await import('../../src/memory/scheduler/memory-scheduler.js');
const { WEIGHTS_PATH } = await import('../../src/memory/confidence-tuner.js');

type TraceMcpConfig = import('../../src/config.js').TraceMcpConfig;

function buildSchedulerConfig(overrides: Partial<TraceMcpConfig['memory']> = {}): TraceMcpConfig {
  return {
    memory: {
      background: {
        enabled: true,
        tickIntervalSec: 60,
        activityDebounceSec: 0,
        idleWindowSec: 3600,
        coldThresholdSec: 86400,
        mineMinIntervalSec: 1800,
        clusterEveryNDecisions: 25,
        failureBackoffSec: 3600,
        tuneCooldownSec: 86400,
        tuneEveryNNewEvents: 25,
      },
      weight_tuning: { enabled: true, min_events: 25 },
      ...overrides,
    },
  } as unknown as TraceMcpConfig;
}

function seedReviewEvents(
  store: InstanceType<typeof DecisionStore>,
  projectRoot: string,
  n: number,
): void {
  for (let i = 0; i < n; i++) {
    const d = store.addDecision({
      title: `approved-${i}`,
      content: 'a'.repeat(250),
      type: 'architecture_decision',
      project_root: projectRoot,
      file_path: `src/file-${i}.ts`,
      tags: ['x'],
      review_status: 'pending',
    });
    store.setReviewStatus(d.id, 'approved');
  }
  for (let i = 0; i < n; i++) {
    const d = store.addDecision({
      title: `rejected-${i}`,
      content: 'short',
      type: 'preference',
      project_root: projectRoot,
      review_status: 'pending',
    });
    store.setReviewStatus(d.id, 'rejected');
  }
}

describe('DecisionStore — scheduler_state CRUD', () => {
  const projectRoot = '/projects/sched-state';
  let store: InstanceType<typeof DecisionStore>;
  let dbPath: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-state-db-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('getSchedulerState returns undefined for an unknown project', () => {
    expect(store.getSchedulerState(projectRoot)).toBeUndefined();
  });

  it('upsertSchedulerState inserts a new row and stamps updated_at', () => {
    store.upsertSchedulerState({
      project_root: projectRoot,
      last_mine_at: 1_000,
    });
    const row = store.getSchedulerState(projectRoot);
    expect(row).toBeDefined();
    expect(row!.project_root).toBe(projectRoot);
    expect(row!.last_mine_at).toBe(1_000);
    expect(row!.last_cluster_at).toBeNull();
    expect(row!.last_memo_at).toBeNull();
    expect(row!.last_tune_at).toBeNull();
    expect(row!.last_tune_event_count).toBeNull();
    expect(row!.consecutive_failures).toBe(0);
    expect(typeof row!.updated_at).toBe('string');
    expect(row!.updated_at.length).toBeGreaterThan(0);
  });

  it('partial update: setting last_mine_at preserves last_cluster_at', () => {
    store.upsertSchedulerState({
      project_root: projectRoot,
      last_mine_at: 100,
      last_cluster_at: 200,
    });
    // Partial update touches only mine.
    store.upsertSchedulerState({
      project_root: projectRoot,
      last_mine_at: 999,
    });
    const row = store.getSchedulerState(projectRoot);
    expect(row!.last_mine_at).toBe(999);
    expect(row!.last_cluster_at).toBe(200);
  });

  it('explicit null clears a column, undefined preserves it', () => {
    store.upsertSchedulerState({
      project_root: projectRoot,
      last_mine_at: 111,
      last_cluster_at: 222,
    });
    store.upsertSchedulerState({
      project_root: projectRoot,
      last_mine_at: null, // explicit clear
      // last_cluster_at undefined → preserve
    });
    const row = store.getSchedulerState(projectRoot);
    expect(row!.last_mine_at).toBeNull();
    expect(row!.last_cluster_at).toBe(222);
  });

  it('consecutive_failures defaults to 0 on insert and can be incremented', () => {
    store.upsertSchedulerState({ project_root: projectRoot });
    let row = store.getSchedulerState(projectRoot);
    expect(row!.consecutive_failures).toBe(0);

    store.upsertSchedulerState({ project_root: projectRoot, consecutive_failures: 3 });
    row = store.getSchedulerState(projectRoot);
    expect(row!.consecutive_failures).toBe(3);

    // Undefined preserves the existing value.
    store.upsertSchedulerState({ project_root: projectRoot, last_memo_at: 555 });
    row = store.getSchedulerState(projectRoot);
    expect(row!.consecutive_failures).toBe(3);
    expect(row!.last_memo_at).toBe(555);
  });

  it('rows are isolated per project_root', () => {
    store.upsertSchedulerState({ project_root: '/p/a', last_mine_at: 1 });
    store.upsertSchedulerState({ project_root: '/p/b', last_mine_at: 2 });
    expect(store.getSchedulerState('/p/a')!.last_mine_at).toBe(1);
    expect(store.getSchedulerState('/p/b')!.last_mine_at).toBe(2);
    expect(store.getSchedulerState('/p/c')).toBeUndefined();
  });
});

describe('MemoryScheduler — state persistence across instances', () => {
  const projectRoot = '/projects/sched-state-hydrate';
  let store: InstanceType<typeof DecisionStore>;
  let dbPath: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-state-sched-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);
    if (fs.existsSync(WEIGHTS_PATH)) fs.unlinkSync(WEIGHTS_PATH);
  });

  afterEach(async () => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (fs.existsSync(WEIGHTS_PATH)) fs.unlinkSync(WEIGHTS_PATH);
  });

  afterAll(() => {
    fs.rmSync(sharedHome, { recursive: true, force: true });
  });

  it('after a tune tick, scheduler_state row is persisted and a fresh instance hydrates from it', async () => {
    seedReviewEvents(store, projectRoot, 15); // 30 events — past min_events=25
    const cfg = buildSchedulerConfig();
    let nowMs = 1_700_000_000_000;
    const scheduler = new MemoryScheduler({
      projectManager: { listProjects: () => [{ root: projectRoot, config: cfg }] },
      config: cfg,
      decisionStore: store,
      startInterval: false,
      now: () => nowMs,
    });
    await scheduler.runTickForTests();
    await scheduler.stop();

    // Stage D wrote durable state.
    const persisted = store.getSchedulerState(projectRoot);
    expect(persisted).toBeDefined();
    expect(persisted!.last_tune_at).toBe(nowMs);
    expect(persisted!.last_tune_event_count).toBe(30);

    // Spin up a second scheduler instance against the same store — it
    // should hydrate the same timestamps so the cooldown gate holds.
    const scheduler2 = new MemoryScheduler({
      projectManager: { listProjects: () => [{ root: projectRoot, config: cfg }] },
      config: cfg,
      decisionStore: store,
      startInterval: false,
      now: () => nowMs + 60 * 1000, // 1 minute later, well under 24h cooldown
    });
    // Drive a tick — Stage D must NOT re-fire because the cooldown is
    // already accounted for via the hydrated lastTuneAt.
    if (fs.existsSync(WEIGHTS_PATH)) fs.unlinkSync(WEIGHTS_PATH);
    await scheduler2.runTickForTests();
    expect(fs.existsSync(WEIGHTS_PATH)).toBe(false);

    const status = scheduler2.getStatus();
    const proj = status.projects.find((p) => p.root === projectRoot);
    expect(proj?.lastTuneAt).toBe(nowMs);
    await scheduler2.stop();
  });

  it('hydration is a no-op when no row exists (fresh project)', async () => {
    // Disable all stages that could write durable state so the row stays
    // absent. Mine fires offline with the regex strategy and now persists
    // its own last_mine_at, so we have to gate it behind the activity
    // debounce: lastActivityAt < activityDebounceSec ago short-circuits
    // computeDueStages entirely.
    const cfg = buildSchedulerConfig({
      background: {
        enabled: true,
        tickIntervalSec: 60,
        activityDebounceSec: 86_400, // 1 day — debounce wins
        idleWindowSec: 3600,
        coldThresholdSec: 86400,
        mineMinIntervalSec: 1800,
        clusterEveryNDecisions: 25,
        failureBackoffSec: 3600,
        tuneCooldownSec: 86400,
        tuneEveryNNewEvents: 25,
      },
      weight_tuning: { enabled: false },
    } as unknown as Partial<TraceMcpConfig['memory']>);
    const scheduler = new MemoryScheduler({
      projectManager: { listProjects: () => [{ root: projectRoot, config: cfg }] },
      config: cfg,
      decisionStore: store,
      startInterval: false,
    });
    // Bump activity so the debounce gate trips and skips every stage.
    scheduler.notifyActivity(projectRoot);
    await scheduler.runTickForTests();
    // The project state map should still exist (notifyActivity created it).
    const status = scheduler.getStatus();
    expect(status.projects.find((p) => p.root === projectRoot)).toBeDefined();
    // No stage ran → no row written.
    expect(store.getSchedulerState(projectRoot)).toBeUndefined();
    await scheduler.stop();
  });

  it('mine stage completion writes last_mine_at to scheduler_state', async () => {
    // Disable weight tuning so Stage D does not also fire and clobber
    // the state row's other columns we want to assert on cleanly.
    const cfg = buildSchedulerConfig({
      weight_tuning: { enabled: false },
      mining: { strategy: 'regex' },
    } as unknown as Partial<TraceMcpConfig['memory']>);
    let nowMs = 1_700_500_000_000;
    const scheduler = new MemoryScheduler({
      projectManager: { listProjects: () => [{ root: projectRoot, config: cfg }] },
      config: cfg,
      decisionStore: store,
      startInterval: false,
      now: () => nowMs,
    });
    await scheduler.runTickForTests();
    const persisted = store.getSchedulerState(projectRoot);
    // Mine stage runs (no AI provider needed for regex strategy) → its
    // timestamp is stamped onto the durable row.
    expect(persisted).toBeDefined();
    expect(persisted!.last_mine_at).toBe(nowMs);
    expect(persisted!.last_tune_at).toBeNull();
    await scheduler.stop();
  });

  it('schema migration is idempotent — reopening the store does not error', () => {
    // First open already happened in beforeEach; close and reopen.
    store.close();
    const reopened = new DecisionStore(dbPath);
    // Insert + read works on the reopened store with no migration error.
    reopened.upsertSchedulerState({ project_root: projectRoot, last_mine_at: 42 });
    const row = reopened.getSchedulerState(projectRoot);
    expect(row!.last_mine_at).toBe(42);
    reopened.close();
    // Restore for afterEach cleanup.
    store = new DecisionStore(dbPath);
  });
});
