// @vitest-environment jsdom
/**
 * Settings — the design invariants the TRA-295 rebuild has to keep, plus the
 * two data bugs the rebuild exposed.
 *
 * What was wrong on the running app: seven unlabelled groups, `Edit JSON` as
 * the single most prominent control, a 7px blue dot as the only "differs from
 * defaults" signal, Title Case section names, `PID 64806 · Port 3741 · 22s` as
 * the daemon card's headline, and an `lsp` section that existed in the schema
 * but rendered nowhere because it belonged to no group.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { t } from '../../i18n';
import type { DaemonUpdateCheck, UpdateCheck } from '../../update-check.js';
import { CONFIG_SCHEMA, countModifiedFields, type SectionDef } from '../configSchema';
import { Settings } from '../Settings';

/* This file's assertions are about the config/daemon screen, not update
   state — the fixtures below just satisfy the props App.tsx's single poller
   normally supplies. */
const update: UpdateCheck = {
  state: { available: false },
  pendingVersion: null,
  checking: false,
  updating: false,
  progress: null,
  check: () => {},
  apply: () => {},
  restart: () => {},
};
const daemonUpdate: DaemonUpdateCheck = {
  state: { available: false },
  checking: false,
  updating: false,
  check: () => {},
  apply: () => {},
};
function renderSettings() {
  return render(
    <Settings
      appearance="auto"
      onAppearanceChange={() => {}}
      update={update}
      daemonUpdate={daemonUpdate}
    />,
  );
}

const SETTINGS = {
  path: '/Users/x/.trace-mcp/.config.json',
  daemon: { port: 3741, host: '127.0.0.1', log_path: '/x/daemon.log', uptime: 74, pid: 64806 },
  settings: {
    logLevel: 'info',
    ai: { enabled: true, provider: 'ollama' },
    projects: {},
  },
};

vi.mock('../../hooks/useDaemon', () => ({
  useDaemon: () => ({
    settings: SETTINGS,
    loading: false,
    connected: true,
    restarting: false,
    restartDaemon: vi.fn(),
    updateSettings: vi.fn(),
  }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('gives every group a title', () => {
  renderSettings();
  for (const title of [
    'General',
    'Intelligence',
    'Quality and security',
    'Infrastructure',
    'Development',
    'Monitoring',
    'Advanced',
  ]) {
    expect(screen.getAllByText(title).length).toBeGreaterThan(0);
  }
});

/* `lsp` was in the schema and in no group, and groups are what the list
   renders — so a whole settings section was unreachable. */
it('renders every schema section, including LSP enrichment', () => {
  renderSettings();
  for (const section of CONFIG_SCHEMA) {
    // The schema carries catalogue keys since TRA-383; the rendered row is
    // still the English label, which is what this asserts.
    const literal = t(section.label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(screen.getByRole('button', { name: new RegExp(`^${literal}`) })).toBeTruthy();
  }
  expect(screen.getByRole('button', { name: /^LSP enrichment/ })).toBeTruthy();
});

/* An accent-filled button for a raw-config escape hatch was the loudest thing
   on the screen. It is a menu item now, and the list has no prominent control
   at all. */
it('keeps the raw-config escape hatch out of the toolbar', async () => {
  const { container } = renderSettings();
  expect(screen.queryByRole('button', { name: 'Edit JSON' })).toBeNull();
  expect(container.querySelectorAll('.v-prominent').length).toBe(0);

  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
  const menu = await screen.findByRole('menu');
  expect(within(menu).getByRole('menuitem', { name: 'Edit config file…' })).toBeTruthy();
});

/* The dot had no legend anywhere in the app, so its colour was the whole
   message. The word is the message now. */
it('names the modified state instead of signalling it with colour alone', () => {
  const { container } = renderSettings();
  expect(screen.getAllByText('Modified').length).toBeGreaterThan(0);
  // No bare accent-filled dot spans left in the rows.
  const dots = [...container.querySelectorAll('span')].filter(
    (s) => (s.getAttribute('style') ?? '').includes('var(--accent)') && !s.textContent,
  );
  expect(dots).toHaveLength(0);
});

/* PID is diagnostic detail, not a headline. */
it('leads the daemon card with its state and hides the PID behind a copy action', async () => {
  renderSettings();
  expect(screen.getByText(/Running · port/)).toBeTruthy();
  expect(screen.queryByText(/PID/)).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
  const menu = await screen.findByRole('menu');
  expect(within(menu).getByRole('menuitem', { name: 'Copy daemon details' })).toBeTruthy();
});

it('titles the screen and its sections in sentence case', () => {
  renderSettings();
  expect(screen.getByRole('heading', { name: 'Settings', level: 2 })).toBeTruthy();
  for (const wrong of [
    'Quality Gates',
    'Ignore Rules',
    'Tool Exposure',
    'Per-project Overrides',
    'Cross-repo Topology',
    'AI / Embeddings',
  ]) {
    expect(screen.queryByText(wrong)).toBeNull();
  }
});

it('searches from the toolbar with the SearchField primitive', async () => {
  const { container } = renderSettings();
  const search = screen.getByRole('textbox', { name: 'Search settings' });
  expect(search.closest('.lx-search')).not.toBeNull();

  fireEvent.change(search, { target: { value: 'ollama' } });
  await waitFor(() =>
    expect(container.querySelectorAll('[class*="text-[13px]"]').length).toBeGreaterThan(0),
  );
  expect(screen.queryByRole('button', { name: /^File watcher/ })).toBeNull();
});

it('navigates into a section and back from the toolbar', async () => {
  renderSettings();
  fireEvent.click(screen.getByRole('button', { name: /^AI and embeddings/ }));
  expect(screen.getByRole('heading', { name: 'AI and embeddings', level: 2 })).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  expect(screen.getByRole('heading', { name: 'Settings', level: 2 })).toBeTruthy();
});

/* TRA-333: the model-list fetch outlived the component. Its `finally` ran
   `setLoading(false)` after the test's jsdom was torn down, React reached for
   `window`, and vitest failed the whole run on the unhandled error even though
   every test passed. */
it('aborts the in-flight model fetch when the settings tab unmounts', async () => {
  let signal: AbortSignal | undefined;
  const fetchMock = vi.fn((_url: unknown, init?: { signal?: AbortSignal }) => {
    signal = init?.signal;
    return new Promise<never>(() => {}); // never settles on its own
  });
  vi.stubGlobal('fetch', fetchMock);

  const { unmount } = renderSettings();
  fireEvent.click(screen.getByRole('button', { name: /^AI and embeddings/ }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());

  unmount();
  expect(signal?.aborted).toBe(true);
});

/* An absent key IS the default — the daemon applies the default when the key
   is missing. Counting it as "modified" marked almost every section, which was
   survivable while the signal was an unexplained dot and is not once the row
   says the word. */
it('does not count a never-set field as modified', () => {
  const section: SectionDef = {
    key: 'demo',
    label: 'Demo',
    fields: [
      { key: 'a', label: 'A', type: 'boolean', defaultValue: true },
      { key: 'b', label: 'B', type: 'number', defaultValue: 10 },
    ],
  };
  expect(countModifiedFields(section, {})).toBe(0);
  expect(countModifiedFields(section, { a: true, b: 10 })).toBe(0);
  expect(countModifiedFields(section, { b: 42 })).toBe(1);
});

/* Emoji are banned as UI icons, and this field was never read by anything. */
it('carries no emoji icon on any schema section', () => {
  for (const section of CONFIG_SCHEMA) {
    expect('icon' in section).toBe(false);
  }
});
