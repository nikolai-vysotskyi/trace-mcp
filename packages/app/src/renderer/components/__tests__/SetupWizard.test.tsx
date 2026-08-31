// @vitest-environment jsdom
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

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
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

it('indexes the suggested project and closes the wizard on finish', async () => {
  stubElectronApi();
  const onClose = vi.fn();
  render(<SetupWizard onClose={onClose} initialStep="project" />);

  await screen.findByText('Index your first project');
  const indexButton = screen.getByRole('button', { name: 'Index project' });
  fireEvent.click(indexButton);

  const api = (window as unknown as { electronAPI: { openProjectTab: unknown } }).electronAPI;
  await waitFor(() => {
    expect(api.openProjectTab).toHaveBeenCalledWith('/Users/test/Projects/my-app');
    expect(onClose).toHaveBeenCalled();
    expect(isOnboardingDone()).toBe(true);
  });
});

it('allows choosing another folder with selectFolder', async () => {
  stubElectronApi({
    selectFolder: '/Users/test/Projects/custom-repo',
  });
  render(<SetupWizard onClose={() => {}} initialStep="project" />);

  await screen.findByText('Index your first project');
  const changeButton = screen.getByRole('button', { name: 'Change folder…' });
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
