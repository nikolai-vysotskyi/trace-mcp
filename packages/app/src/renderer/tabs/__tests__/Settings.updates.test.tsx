// @vitest-environment jsdom
/**
 * Settings → Updates — what each row SHOWS, as opposed to what it computes
 * (TRA-686 design pass).
 *
 * Measured on the rendered rows before this pass: a check in flight was
 * signalled only by the refresh glyph dimming to opacity .4 over
 * --label-secondary — 22% label on --surface, ~1.6:1, invisible in both
 * appearances — while the status line went on saying "Up to date". And an
 * npm failure printed its whole multi-line stderr into an 11px red line.
 */
import { render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { DaemonUpdateCheck, UpdateCheck } from '../../update-check.js';
import { Settings } from '../Settings';

const update = (over: Partial<UpdateCheck> = {}): UpdateCheck => ({
  state: { available: false, current: '3.10.0', lastChecked: Date.now() },
  pendingVersion: null,
  checking: false,
  updating: false,
  progress: null,
  check: () => {},
  apply: () => {},
  restart: () => {},
  ...over,
});

const daemonUpdate = (over: Partial<DaemonUpdateCheck> = {}): DaemonUpdateCheck => ({
  state: { available: false, current: '3.13.0', lastChecked: Date.now() },
  checking: false,
  updating: false,
  check: () => {},
  apply: () => {},
  ...over,
});

vi.mock('../../hooks/useDaemon', () => ({
  useDaemon: () => ({
    settings: {
      path: '/Users/x/.trace-mcp/.config.json',
      daemon: { port: 3741, host: '127.0.0.1', log_path: '/x/daemon.log', uptime: 74, pid: 64806 },
      settings: { logLevel: 'info', projects: {} },
    },
    loading: false,
    connected: true,
    restarting: false,
    restartDaemon: vi.fn(),
    updateSettings: vi.fn(),
  }),
}));

function renderSettings(props: Partial<Parameters<typeof Settings>[0]> = {}) {
  return render(
    <Settings
      appearance="auto"
      onAppearanceChange={() => {}}
      update={update()}
      daemonUpdate={daemonUpdate()}
      {...props}
    />,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('says a check is running, per row, instead of only dimming the glyph', () => {
  renderSettings({ update: update({ checking: true }) });
  expect(screen.getAllByText('Checking…')).toHaveLength(1);
});

it('shows the first line of a failure and keeps the rest in the tooltip', () => {
  const error =
    'npm error code EACCES\nnpm error syscall mkdir\nnpm error path /usr/local/lib/node_modules';
  renderSettings({
    daemonUpdate: daemonUpdate({
      state: { available: true, current: '3.10.0', latest: '3.13.0', error },
    }),
  });
  const line = screen.getByText('npm error code EACCES');
  expect(line.textContent).not.toContain('syscall');
  expect(line.getAttribute('title')).toBe(error);
});

/* A download runs for a minute with nothing on the row but a disabled
   button — the percentage the hook already carries says it is moving. */
it('reports download progress on the app row', () => {
  renderSettings({
    update: update({
      state: { available: true, current: '3.10.0', latest: '3.13.0' },
      updating: true,
      progress: 42,
    }),
  });
  expect(screen.getByText('v3.13.0 available · 42%')).toBeTruthy();
});

/* The whole point of the split: one row failing must not take the other's
   state with it. */
it('keeps the daemon row readable when the app check has failed', () => {
  renderSettings({
    update: update({ state: { available: false, current: '3.10.0', error: 'network unreachable' } }),
    daemonUpdate: daemonUpdate({
      state: { available: true, current: '3.10.0', latest: '3.13.0' },
    }),
  });
  expect(screen.getByText('network unreachable')).toBeTruthy();
  expect(screen.getByText('v3.13.0 available')).toBeTruthy();
});
