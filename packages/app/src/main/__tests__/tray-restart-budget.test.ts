/* The restart budget is not a property of any single helper — it is what
   `checkHealth` remembers between polls. `app-restart-policy.test.ts` covers
   `healthClearsRestartBudget` and `shouldRestartUnreachableDaemon` in
   isolation, but with both intact you can still revert the one-line guard in
   tray.ts to an unconditional `restartsThisOutage = 0` and that suite stays
   green (TRA-558). These tests drive the real `checkHealth` over a whole
   outage, so the guard is covered where production actually calls it. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WEDGED_DAEMON_MS } from '../daemon-lifecycle';
import { checkHealth, createTray } from '../tray';

const MINUTE = 60_000;
let base = Date.UTC(2027, 0, 1);

let health: () => Promise<{ status?: string; version?: string }>;
const restarts: string[] = [];

vi.mock('electron', () => {
  const image = { setTemplateImage: vi.fn() };
  return {
    app: { getVersion: () => '3.7.0', isPackaged: false, quit: vi.fn(), on: vi.fn() },
    BrowserWindow: class {
      static getAllWindows() {
        return [];
      }
    },
    ipcMain: { on: vi.fn(), handle: vi.fn() },
    Menu: { buildFromTemplate: (t: unknown) => t },
    nativeImage: { createFromPath: () => image, createFromBuffer: () => image },
    nativeTheme: { shouldUseDarkColors: false, on: vi.fn() },
    Tray: class {
      setImage = vi.fn();
      setToolTip = vi.fn();
      setContextMenu = vi.fn();
      isDestroyed = () => false;
      on = vi.fn();
    },
  };
});

vi.mock('../api-client', () => ({
  DaemonClient: class {
    health() {
      return health();
    }
  },
}));

vi.mock('../i18n', () => ({ t: (key: string) => key }));

vi.mock('../daemon-lifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../daemon-lifecycle')>()),
  // Provably running: this is the case the escalating threshold exists for.
  isDaemonProcessAlive: () => true,
  ensureDaemon: () => {
    restarts.push('ensure');
    return { ok: true };
  },
  restartDaemon: () => {
    restarts.push('restart');
    return { ok: true };
  },
}));


/** Poll `n` times at the current fake clock. */
async function poll(n = 1): Promise<void> {
  for (let i = 0; i < n; i++) await checkHealth();
}

function unreachable(): void {
  health = () => Promise.reject(new Error('connect ECONNREFUSED'));
}

function answers(status: string): void {
  health = () => Promise.resolve({ status, version: '3.7.0' });
}

/** Drive one outage → one restart → daemon answers with `status` → a second
    outage, and report how many restart attempts the second outage produced by
    the time it has been mute for `WEDGED_DAEMON_MS` + 1 min. */
async function outageAfterHealth(status: string): Promise<number> {
  // tray.ts keeps its state in module scope, so each test moves a day forward
  // rather than replaying the same clock — otherwise the previous test's last
  // restart timestamp puts this one inside the startup grace window.
  base += 24 * 60 * MINUTE;
  let now = base;
  vi.setSystemTime(now);
  unreachable();
  await poll(); // failure 1 — mute for 0 ms, nothing to do yet

  now += 6 * MINUTE;
  vi.setSystemTime(now);
  await poll(2); // failures 2 and 3 — past the wedged threshold, tick 3 restarts
  expect(restarts).toHaveLength(1);

  answers(status); // the replacement daemon reports in
  await poll();

  now += MINUTE + 1000; // clear the post-restart startup grace
  vi.setSystemTime(now);
  unreachable();
  await poll(); // failure 1 of the second outage — mute clock restarts here

  now += 6 * MINUTE; // past the base threshold, short of the escalated one
  vi.setSystemTime(now);
  await poll(2); // failures 2 and 3 — tick 3 would restart if the budget cleared
  return restarts.length - 1;
}

describe('checkHealth restart budget', () => {
  beforeEach(async () => {
    restarts.length = 0;
    vi.useFakeTimers();
    // A reachable daemon at import/creation time leaves the module's outage
    // state clean, so each test starts from the same place.
    answers('ok');
    createTray();
    await poll();
  });

  it('keeps the escalated threshold when the daemon is still starting', async () => {
    expect(await outageAfterHealth('starting')).toBe(0);

    // Not "never restarts again": once mute past the escalated threshold it does.
    vi.setSystemTime(Date.now() + 5 * MINUTE);
    await poll(3); // failure 6 — the next restart tick
    expect(restarts).toHaveLength(2);
  });

  it('clears the budget when the daemon reports ok', async () => {
    expect(await outageAfterHealth('ok')).toBe(1);
  });

  it('clears the budget when /health carries no status', async () => {
    expect(await outageAfterHealth(undefined as unknown as string)).toBe(1);
  });
});

it('the escalated threshold is what makes the 6-minute poll a non-restart', () => {
  // Guards the numbers above: 6 min must sit between the base and escalated
  // thresholds, or the tests would pass for the wrong reason.
  expect(WEDGED_DAEMON_MS).toBeLessThan(6 * MINUTE);
  expect(6 * MINUTE).toBeLessThan(2 * WEDGED_DAEMON_MS);
});
