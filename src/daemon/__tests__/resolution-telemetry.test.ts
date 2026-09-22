import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { STATUS_DIR } from '../../global.js';
import {
  __getResolutionTelemetryStateForTests,
  __resetResolutionTelemetryForTests,
  DAEMON_STATUS_NAME,
  daemonStatusPath,
  recordUnresolvableResolution,
  type DaemonStatusSnapshot,
} from '../resolution-telemetry.js';

// TRA-1791: the daemon's /mcp endpoint answers 400/404 when it cannot route a
// request to a project (ambiguous / no-projects). No per-project sentinel can
// record that — there is no project — so the guard hook would see a live
// heartbeat, deny every Read forever, and loop through auto-degrade. These
// tests pin the daemon-global snapshot the hook reads instead.

function readSnapshotFromDisk(): DaemonStatusSnapshot {
  return JSON.parse(fs.readFileSync(daemonStatusPath(), 'utf8')) as DaemonStatusSnapshot;
}

describe('resolution-telemetry', () => {
  beforeEach(() => {
    __resetResolutionTelemetryForTests();
    try {
      fs.unlinkSync(daemonStatusPath());
    } catch {
      /* first run — nothing to clean */
    }
  });

  it('writes the daemon snapshot under STATUS_DIR', () => {
    expect(daemonStatusPath()).toBe(path.join(STATUS_DIR, DAEMON_STATUS_NAME));
    const snap = recordUnresolvableResolution({ kind: 'ambiguous' });
    expect(snap.schema).toBe(1);
    expect(snap.unresolvable_total).toBe(1);
    expect(snap.last_resolution).toBe('ambiguous');
    expect(snap.last_unresolvable_at).not.toBeNull();
    expect(readSnapshotFromDisk().unresolvable_total).toBe(1);
  });

  it('accumulates totals and records the dropped dangerous hint', () => {
    recordUnresolvableResolution({ kind: 'ambiguous' });
    const snap = recordUnresolvableResolution({
      kind: 'no-projects',
      ignoredDangerousHint: { projectRoot: '/', reason: 'filesystem root' },
    });
    expect(snap.unresolvable_total).toBe(2);
    expect(snap.dangerous_hints_total).toBe(1);
    expect(snap.last_resolution).toBe('no-projects');
    expect(snap.last_hinted_root).toBe('/');
    expect(snap.last_hint_reason).toBe('filesystem root');
    const onDisk = readSnapshotFromDisk();
    expect(onDisk.unresolvable_total).toBe(2);
    expect(onDisk.dangerous_hints_total).toBe(1);
  });

  it('keeps hint fields null when no hint was dropped', () => {
    const snap = recordUnresolvableResolution({ kind: 'ambiguous' });
    expect(snap.dangerous_hints_total).toBe(0);
    expect(snap.last_hinted_root).toBeNull();
    expect(snap.last_hint_reason).toBeNull();
  });

  it('reset clears the in-memory counters', () => {
    recordUnresolvableResolution({ kind: 'ambiguous' });
    __resetResolutionTelemetryForTests();
    expect(__getResolutionTelemetryStateForTests().unresolvableTotal).toBe(0);
    expect(__getResolutionTelemetryStateForTests().dangerousHintsTotal).toBe(0);
    expect(recordUnresolvableResolution({ kind: 'ambiguous' }).unresolvable_total).toBe(1);
  });
});
