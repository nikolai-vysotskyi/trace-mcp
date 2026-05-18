/**
 * Stage D tests — auto-tune confidence weights inside the background
 * scheduler. Covers both the pure `runTuneStage` function and the
 * scheduler-tick wiring that enqueues it under the right conditions.
 *
 * The test re-points TRACE_MCP_DATA_DIR at a per-process tmp dir before
 * any module imports so saveWeights/loadWeights never touch the real
 * ~/.trace-mcp/confidence_weights.json.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Capture-then-isolate any pre-existing env so the sandbox the rest of
// the test process needs is restored on afterAll.
const sharedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-tune-home-'));
process.env.TRACE_MCP_DATA_DIR = sharedHome;

const { DecisionStore } = await import('../../src/memory/decision-store.js');
const { MemoryScheduler } = await import('../../src/memory/scheduler/memory-scheduler.js');
const { runTuneStage } = await import('../../src/memory/scheduler/stages.js');
const { WEIGHTS_PATH } = await import('../../src/memory/confidence-tuner.js');
const { resetCachedWeights } = await import('../../src/memory/decision-confidence.js');

type TraceMcpConfig = import('../../src/config.js').TraceMcpConfig;

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

describe('runTuneStage (pure)', () => {
  const projectRoot = '/projects/scheduler-tune';
  let store: InstanceType<typeof DecisionStore>;
  let dbPath: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-tune-db-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);
    resetCachedWeights();
    if (fs.existsSync(WEIGHTS_PATH)) fs.unlinkSync(WEIGHTS_PATH);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (fs.existsSync(WEIGHTS_PATH)) fs.unlinkSync(WEIGHTS_PATH);
    resetCachedWeights();
  });

  afterAll(() => {
    fs.rmSync(sharedHome, { recursive: true, force: true });
  });

  it('returns skipped=true reason=insufficient_events when below threshold', async () => {
    seedReviewEvents(store, projectRoot, 5); // 10 events
    const result = await runTuneStage({ store, projectRoot, minEvents: 25 });
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('insufficient_events');
    expect(result.applied).toBe(false);
    expect(result.events_used).toBe(10);
  });

  it('writes weights when events >= min and result.ok and dryRun=false', async () => {
    seedReviewEvents(store, projectRoot, 15); // 30 events
    expect(fs.existsSync(WEIGHTS_PATH)).toBe(false);
    const result = await runTuneStage({ store, projectRoot, minEvents: 25 });
    expect(result.ok).toBe(true);
    expect(result.applied).toBe(true);
    expect(result.events_used).toBe(30);
    expect(fs.existsSync(WEIGHTS_PATH)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(WEIGHTS_PATH, 'utf-8'));
    expect(onDisk.version).toBe(1);
  });

  it('dryRun=true does not persist weights', async () => {
    seedReviewEvents(store, projectRoot, 15);
    const result = await runTuneStage({ store, projectRoot, minEvents: 25, dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.applied).toBe(false);
    expect(fs.existsSync(WEIGHTS_PATH)).toBe(false);
  });

  it('swallows exceptions and returns ok=false with error message', async () => {
    // Inject a broken store: listReviewEvents throws.
    const broken = {
      listReviewEvents() {
        throw new Error('boom');
      },
    } as unknown as InstanceType<typeof DecisionStore>;
    const result = await runTuneStage({ store: broken, projectRoot });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('boom');
  });
});

describe('MemoryScheduler — Stage D wiring', () => {
  const projectRoot = '/projects/scheduler-tune-sched';
  let store: InstanceType<typeof DecisionStore>;
  let dbPath: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-tune-sched-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);
    resetCachedWeights();
    if (fs.existsSync(WEIGHTS_PATH)) fs.unlinkSync(WEIGHTS_PATH);
  });

  afterEach(async () => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (fs.existsSync(WEIGHTS_PATH)) fs.unlinkSync(WEIGHTS_PATH);
    resetCachedWeights();
  });

  it('tick with sufficient events + no prior tune → Stage D enqueued and runs', async () => {
    seedReviewEvents(store, projectRoot, 15); // 30 events ≥ 25
    const cfg = buildSchedulerConfig();
    const scheduler = new MemoryScheduler({
      projectManager: { listProjects: () => [{ root: projectRoot, config: cfg }] },
      config: cfg,
      decisionStore: store,
      startInterval: false,
    });
    expect(fs.existsSync(WEIGHTS_PATH)).toBe(false);
    await scheduler.runTickForTests();
    // Stage D should have fired and persisted weights.
    expect(fs.existsSync(WEIGHTS_PATH)).toBe(true);
    const status = scheduler.getStatus();
    const proj = status.projects.find((p) => p.root === projectRoot);
    expect(proj?.lastTuneAt).toBeGreaterThan(0);
    await scheduler.stop();
  });

  it('tick within cooldown → Stage D NOT enqueued again', async () => {
    seedReviewEvents(store, projectRoot, 15);
    let nowMs = 1_000_000_000_000;
    const cfg = buildSchedulerConfig();
    const scheduler = new MemoryScheduler({
      projectManager: { listProjects: () => [{ root: projectRoot, config: cfg }] },
      config: cfg,
      decisionStore: store,
      startInterval: false,
      now: () => nowMs,
    });
    await scheduler.runTickForTests();
    expect(fs.existsSync(WEIGHTS_PATH)).toBe(true);
    fs.unlinkSync(WEIGHTS_PATH); // erase to detect a second write

    // Advance < tuneCooldownSec — Stage D must NOT re-enqueue.
    nowMs += 60 * 60 * 1000; // 1h, cooldown defaults to 24h
    // Even adding more events should not bypass the cooldown.
    seedReviewEvents(store, projectRoot, 15);
    await scheduler.runTickForTests();
    expect(fs.existsSync(WEIGHTS_PATH)).toBe(false);
    await scheduler.stop();
  });

  it('tick after cooldown elapsed + new events → Stage D re-fires', async () => {
    seedReviewEvents(store, projectRoot, 15);
    let nowMs = 1_000_000_000_000;
    const cfg = buildSchedulerConfig({
      background: {
        enabled: true,
        tickIntervalSec: 60,
        activityDebounceSec: 0,
        idleWindowSec: 3600,
        coldThresholdSec: 86400,
        mineMinIntervalSec: 1800,
        clusterEveryNDecisions: 25,
        failureBackoffSec: 3600,
        tuneCooldownSec: 60, // 1 minute for the test
        tuneEveryNNewEvents: 25,
      },
      weight_tuning: { enabled: true, min_events: 25 },
    } as unknown as TraceMcpConfig['memory']);
    const scheduler = new MemoryScheduler({
      projectManager: { listProjects: () => [{ root: projectRoot, config: cfg }] },
      config: cfg,
      decisionStore: store,
      startInterval: false,
      now: () => nowMs,
    });
    await scheduler.runTickForTests();
    expect(fs.existsSync(WEIGHTS_PATH)).toBe(true);
    fs.unlinkSync(WEIGHTS_PATH);

    // Past the cooldown + bring in more events to trip the delta threshold.
    nowMs += 120_000; // 2 minutes — exceeds 60s cooldown
    seedReviewEvents(store, projectRoot, 15); // another 30 events
    await scheduler.runTickForTests();
    expect(fs.existsSync(WEIGHTS_PATH)).toBe(true);
    await scheduler.stop();
  });

  it('memory.weight_tuning.enabled=false → Stage D NOT enqueued', async () => {
    seedReviewEvents(store, projectRoot, 15);
    const cfg = buildSchedulerConfig({
      weight_tuning: { enabled: false, min_events: 25 },
    } as unknown as TraceMcpConfig['memory']);
    const scheduler = new MemoryScheduler({
      projectManager: { listProjects: () => [{ root: projectRoot, config: cfg }] },
      config: cfg,
      decisionStore: store,
      startInterval: false,
    });
    await scheduler.runTickForTests();
    expect(fs.existsSync(WEIGHTS_PATH)).toBe(false);
    const status = scheduler.getStatus();
    const proj = status.projects.find((p) => p.root === projectRoot);
    expect(proj?.lastTuneAt).toBeUndefined();
    await scheduler.stop();
  });

  it('insufficient events → Stage D NOT enqueued (delta below threshold)', async () => {
    seedReviewEvents(store, projectRoot, 5); // only 10 events
    const cfg = buildSchedulerConfig();
    const scheduler = new MemoryScheduler({
      projectManager: { listProjects: () => [{ root: projectRoot, config: cfg }] },
      config: cfg,
      decisionStore: store,
      startInterval: false,
    });
    await scheduler.runTickForTests();
    expect(fs.existsSync(WEIGHTS_PATH)).toBe(false);
    await scheduler.stop();
  });
});

// Reference vi.fn to keep the import from being elided when no test uses it.
void vi;
