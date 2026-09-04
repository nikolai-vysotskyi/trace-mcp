// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SetupWizard, isOnboardingDone } from '../SetupWizard';

interface ElectronApiStubs {
  daemonSetupState?: unknown;
  retryDaemonSetup?: unknown;
  onDaemonSetupState?: unknown;
  daemonProcessAlive?: unknown;
  detectMcpClients?: unknown;
  configureMcpClient?: unknown;
  guessFirstProject?: unknown;
  selectFolder?: unknown;
  openProjectTab?: unknown;
}

function stubElectronApi(stubs: ElectronApiStubs = {}) {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    daemonSetupState: vi.fn().mockResolvedValue(stubs.daemonSetupState ?? { phase: 'ready' }),
    retryDaemonSetup: vi.fn().mockResolvedValue(stubs.retryDaemonSetup ?? { phase: 'ready' }),
    onDaemonSetupState: vi.fn().mockImplementation((cb) => () => {}),
    daemonProcessAlive: vi.fn().mockResolvedValue(stubs.daemonProcessAlive ?? true),
    detectMcpClients: vi.fn().mockResolvedValue(
      stubs.detectMcpClients ?? [
        { name: 'cursor', configPath: '/Users/test/.cursor/mcp.json', hasTraceMcp: false },
        { name: 'claude-code', configPath: '/Users/test/.claude.json', hasTraceMcp: true },
      ],
    ),
    configureMcpClient: vi.fn().mockResolvedValue(stubs.configureMcpClient ?? { ok: true }),
    guessFirstProject: vi.fn().mockResolvedValue(
      stubs.guessFirstProject ?? { path: '/Users/test/Projects/my-app', name: 'my-app' },
    ),
    selectFolder: vi.fn().mockResolvedValue(stubs.selectFolder ?? '/Users/test/Projects/other-app'),
    openProjectTab: vi.fn().mockResolvedValue(stubs.openProjectTab ?? { ok: true }),
    guard: {
      checkCliVersion: vi.fn().mockResolvedValue({ ok: true, current: '3.9.0', required: '3.9.0' }),
      installStatus: vi.fn().mockResolvedValue({ installed: true, claudeDetected: true }),
      install: vi.fn().mockResolvedValue({ ok: true }),
    },
  };
}

/** The local daemon's POST /api/projects, which is what actually indexes. */
function stubDaemon(ok = true) {
  const fetchMock = vi.fn().mockResolvedValue({ ok, status: ok ? 200 : 500 });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('advances from daemon check to clients step when daemon is ready', async () => {
  stubElectronApi();
  render(<SetupWizard onClose={() => {}} />);

  const dialog = await screen.findByRole('dialog');
  expect(dialog).toBeTruthy();

  // Advances to clients step
  await screen.findByText('Connect coding assistants');
  await screen.findByText('Cursor');
  expect(screen.getByText('/Users/test/.cursor/mcp.json')).toBeTruthy();
  expect(screen.getByText('Claude Code')).toBeTruthy();
});


it('displays installing progress state when daemon is installing', async () => {
  stubElectronApi({
    daemonSetupState: { phase: 'installing' },
  });
  render(<SetupWizard onClose={() => {}} />);

  await screen.findByText('Setting up background service…');
  expect(screen.getByRole('progressbar')).toBeTruthy();
});

it('displays failed state with retry button when daemon setup fails', async () => {
  stubElectronApi({
    daemonSetupState: { phase: 'failed', message: 'launchd error 5' },
    retryDaemonSetup: { phase: 'ready' },
  });
  render(<SetupWizard onClose={() => {}} />);

  await screen.findByText('Could not set up background service.');
  expect(screen.getByText('launchd error 5')).toBeTruthy();

  const retryButton = screen.getByRole('button', { name: 'Retry setup' });
  fireEvent.click(retryButton);

  await screen.findByText('Connect coding assistants');
});

it('renders pre-checked checkboxes for detected MCP clients with config paths', async () => {
  stubElectronApi();
  render(<SetupWizard onClose={() => {}} initialStep="clients" />);

  await screen.findByText('Connect coding assistants');
  const cursorCheckbox = screen.getByRole('checkbox', { name: 'Cursor' }) as HTMLInputElement;
  const claudeCheckbox = screen.getByRole('checkbox', { name: 'Claude Code' }) as HTMLInputElement;

  expect(cursorCheckbox.checked).toBe(true);
  expect(claudeCheckbox.checked).toBe(true);
  expect(screen.getByText('/Users/test/.cursor/mcp.json')).toBeTruthy();
});

it('connects selected clients and advances to project step on confirmation', async () => {
  stubElectronApi();
  render(<SetupWizard onClose={() => {}} initialStep="clients" />);

  const connectButton = await screen.findByRole('button', { name: 'Connect selected' });
  fireEvent.click(connectButton);

  const api = (window as unknown as { electronAPI: { configureMcpClient: unknown } }).electronAPI;
  await waitFor(() => {
    expect(api.configureMcpClient).toHaveBeenCalledWith('cursor', 'base');
    expect(api.configureMcpClient).toHaveBeenCalledWith('claude-code', 'max');
  });

  await screen.findByText('Index your first project');
  expect(screen.getByText('my-app')).toBeTruthy();
  expect(screen.getByText('/Users/test/Projects/my-app')).toBeTruthy();
});

it('registers the project with the daemon, then opens it and closes the wizard', async () => {
  stubElectronApi();
  const fetchMock = stubDaemon();
  const onClose = vi.fn();
  render(<SetupWizard onClose={onClose} initialStep="project" />);

  await screen.findByText('Index your first project');
  const indexButton = screen.getByRole('button', { name: 'Index project' });
  fireEvent.click(indexButton);

  const api = (window as unknown as { electronAPI: { openProjectTab: unknown } }).electronAPI;
  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3741/api/projects',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ root: '/Users/test/Projects/my-app' }),
      }),
    );
    expect(api.openProjectTab).toHaveBeenCalledWith('/Users/test/Projects/my-app');
    expect(onClose).toHaveBeenCalled();
    expect(isOnboardingDone()).toBe(true);
  });
});

it('keeps the wizard open when the daemon refuses the project', async () => {
  stubElectronApi();
  stubDaemon(false);
  const onClose = vi.fn();
  render(<SetupWizard onClose={onClose} initialStep="project" />);

  await screen.findByText('Index your first project');
  fireEvent.click(screen.getByRole('button', { name: 'Index project' }));

  await screen.findByText(/Could not add the project to the background service/);
  const api = (window as unknown as { electronAPI: { openProjectTab: unknown } }).electronAPI;
  expect(api.openProjectTab).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(isOnboardingDone()).toBe(false);
});

it('reports a failed client configuration instead of claiming it connected', async () => {
  stubElectronApi();
  const api = (
    window as unknown as { electronAPI: { configureMcpClient: ReturnType<typeof vi.fn> } }
  ).electronAPI;
  api.configureMcpClient.mockImplementation(async (name: string) =>
    name === 'cursor' ? { ok: false, error: 'spawn trace-mcp ENOENT' } : { ok: true },
  );
  render(<SetupWizard onClose={() => {}} initialStep="clients" />);

  fireEvent.click(await screen.findByRole('button', { name: 'Connect selected' }));

  await screen.findByText('spawn trace-mcp ENOENT');
  // Still on the clients step — the project step never rendered.
  expect(screen.queryByText('Index your first project')).toBeNull();
  expect(screen.getAllByText('Connected')).toHaveLength(1);
});

it('returns focus to whatever opened it', async () => {
  stubElectronApi();
  const opener = document.createElement('button');
  document.body.appendChild(opener);
  opener.focus();

  const { unmount } = render(<SetupWizard onClose={() => {}} initialStep="clients" />);
  await screen.findByRole('dialog');
  await act(async () => {});
  unmount();

  expect(document.activeElement).toBe(opener);
  opener.remove();
});

it('allows choosing another folder with selectFolder', async () => {
  stubElectronApi({
    selectFolder: '/Users/test/Projects/custom-repo',
  });
  render(<SetupWizard onClose={() => {}} initialStep="project" />);

  await screen.findByText('Index your first project');
  // The project step's title renders synchronously; guessFirstProject() still
  // needs a tick to resolve and swap the "no folder" card for the guessed one
  // (TRA-640) — findByRole waits for that instead of racing it.
  const changeButton = await screen.findByRole('button', { name: 'Change folder…' });
  fireEvent.click(changeButton);

  await screen.findByText('custom-repo');
  expect(screen.getByText('/Users/test/Projects/custom-repo')).toBeTruthy();
});

it('dismisses on Escape and remembers completion', async () => {
  stubElectronApi();
  const onClose = vi.fn();
  render(<SetupWizard onClose={onClose} initialStep="clients" />);

  await screen.findByRole('dialog');
  await act(async () => {});

  fireEvent.keyDown(window, { key: 'Escape' });

  expect(onClose).toHaveBeenCalledTimes(1);
  expect(isOnboardingDone()).toBe(true);
});

// TRA-794: the sheet used to be as tall as its content, so 15 detected clients
// pushed "Skip for now" / "Connect selected" below the window edge — with a
// fixed, unscrollable scrim there was no way forward left on screen. jsdom does
// not apply app.css, so this checks both halves of the chain by source: the
// sheet's ceiling in CSS, and the shrink/scroll classes on the list.
it('keeps the client list scrolling inside the sheet, not past the window', async () => {
  const css = readFileSync('src/renderer/app.css', 'utf8');
  const sheetRule = css.slice(css.indexOf('.lx-sheet {'), css.indexOf('@keyframes lx-sheet-in'));
  expect(sheetRule).toMatch(/max-height:/);
  const bodyRule = css.slice(css.indexOf('.lx-sheet-body {'));
  expect(bodyRule.slice(0, bodyRule.indexOf('}'))).toMatch(/overflow-y:\s*auto/);

  stubElectronApi();
  render(<SetupWizard onClose={() => {}} initialStep="clients" />);
  await screen.findByText('Connect coding assistants');

  const list = document.querySelector('[data-scroll="clients"]') as HTMLElement;
  expect(list.className).toContain('overflow-y-auto');

  // Every box between the scroll area and the sheet body must be allowed to
  // shrink, or the list just grows and takes the actions off screen again.
  for (let el = list.parentElement; el && !el.classList.contains('lx-sheet-body'); el = el.parentElement) {
    expect(el.className).toContain('min-h-0');
  }
});

it('traps Tab focus inside the sheet', async () => {
  stubElectronApi();
  const outside = document.createElement('button');
  outside.textContent = 'behind the sheet';
  document.body.appendChild(outside);

  render(<SetupWizard onClose={() => {}} initialStep="clients" />);
  const dialog = await screen.findByRole('dialog');
  const focusables = [...dialog.querySelectorAll('button, input')];
  expect(focusables.length).toBeGreaterThan(1);

  focusables[focusables.length - 1].focus();
  fireEvent.keyDown(window, { key: 'Tab' });
  expect(document.activeElement).toBe(focusables[0]);

  fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(focusables[focusables.length - 1]);

  outside.remove();
});
