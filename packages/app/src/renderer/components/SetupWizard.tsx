import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { t } from '../i18n';
import { Icon } from '../lattice/icons';
import { Badge, Button, Card, StatusDot } from '../lattice/ui';
import {
  type DetectedMcpClient,
  MCP_CLIENT_DISPLAY_NAMES,
} from '../../shared/mcp-detector-types';
import { addRecentProject } from '../recent-projects';

export type WizardStep = 'daemon' | 'clients' | 'project' | 'complete';

export interface SetupWizardProps {
  onClose: () => void;
  initialStep?: WizardStep;
}

export const ONBOARDING_KEY = 'trace-mcp.onboarded.v1';

export function isOnboardingDone(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_KEY) === '1';
  } catch {
    return false;
  }
}

interface ClientRowState {
  client: DetectedMcpClient;
  selected: boolean;
  connected: boolean;
  /** Why the last Connect attempt failed for this client, if it did. */
  error?: string;
}

/** The app's own local daemon, same address every other screen uses. */
const BASE = 'http://127.0.0.1:3741';

export function SetupWizard({ onClose, initialStep }: SetupWizardProps) {
  useTranslation('guard');
  const [step, setStep] = useState<WizardStep>(initialStep ?? 'daemon');
  const [daemonState, setDaemonState] = useState<{
    phase: 'idle' | 'installing' | 'ready' | 'failed';
    message?: string;
  }>({ phase: 'idle' });

  const [clients, setClients] = useState<ClientRowState[]>([]);
  const [clientsLoading, setClientsLoading] = useState(false);
  const [clientsConnecting, setClientsConnecting] = useState(false);

  const [guessedProject, setGuessedProject] = useState<{ path: string; name: string } | null>(null);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [indexing, setIndexing] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);

  const titleId = useId();
  const bodyId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const dismissAndPersist = useCallback(() => {
    try {
      localStorage.setItem(ONBOARDING_KEY, '1');
    } catch {
      /* ignore */
    }
    onCloseRef.current();
  }, []);

  // ── Step 1: Daemon setup check ──────────────────────────────────────────
  useEffect(() => {
    if (initialStep) return;
    let cancelled = false;

    const checkDaemon = async () => {
      if (window.electronAPI?.daemonSetupState) {
        const state = await window.electronAPI.daemonSetupState();
        if (cancelled) return;
        if (state?.phase === 'ready') {
          setDaemonState({ phase: 'ready' });
          setStep('clients');
          return;
        }
        if (state?.phase === 'installing') {
          setDaemonState({ phase: 'installing' });
          return;
        }
        if (state?.phase === 'failed') {
          setDaemonState({ phase: 'failed', message: state.message });
          return;
        }
      }

      // Check OS daemon process alive as fallback
      const alive = await window.electronAPI?.daemonProcessAlive?.();
      if (cancelled) return;
      if (alive) {
        setDaemonState({ phase: 'ready' });
        setStep('clients');
      } else {
        setDaemonState({ phase: 'ready' });
        setStep('clients');
      }
    };

    checkDaemon();

    // Listen for live daemon setup state updates
    const unsubscribe = window.electronAPI?.onDaemonSetupState?.((state) => {
      if (cancelled) return;
      if (state.phase === 'ready') {
        setDaemonState({ phase: 'ready' });
        setStep('clients');
      } else if (state.phase === 'installing') {
        setDaemonState({ phase: 'installing' });
      } else if (state.phase === 'failed') {
        setDaemonState({ phase: 'failed', message: state.message });
      }
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [initialStep]);

  // ── Step 2: Detect MCP Clients ──────────────────────────────────────────
  useEffect(() => {
    if (step !== 'clients') return;
    let cancelled = false;

    const loadClients = async () => {
      setClientsLoading(true);
      try {
        const detected = (await window.electronAPI?.detectMcpClients()) ?? [];
        if (cancelled) return;

        // Group by unique name
        const unique = new Map<string, DetectedMcpClient>();
        for (const c of detected) {
          if (!unique.has(c.name)) {
            unique.set(c.name, c as DetectedMcpClient);
          }
        }

        const rows: ClientRowState[] = Array.from(unique.values()).map((c) => ({
          client: c,
          // Pre-checked by default for any detected client
          selected: true,
          connected: c.hasTraceMcp,
        }));
        setClients(rows);
      } catch {
        if (!cancelled) setClients([]);
      } finally {
        if (!cancelled) setClientsLoading(false);
      }
    };

    loadClients();
    return () => {
      cancelled = true;
    };
  }, [step]);

  // ── Step 3: Guess First Project ────────────────────────────────────────
  useEffect(() => {
    if (step !== 'project') return;
    let cancelled = false;

    const guess = async () => {
      try {
        const result = await window.electronAPI?.guessFirstProject();
        if (cancelled) return;
        if (result) {
          setGuessedProject(result);
          setSelectedProject(result.path);
        }
      } catch {
        /* ignore */
      }
    };

    guess();
    return () => {
      cancelled = true;
    };
  }, [step]);

  // ── Focus Restoration ───────────────────────────────────────────────────
  // The wizard traps focus while it is open, so on dismissal it has to hand
  // focus back to whatever opened it — the "Run setup wizard" button in
  // Settings — instead of dropping it on document.body. Captured during the
  // first render, since by the time effects run the sheet's own autoFocus has
  // already taken focus away from the opener.
  const openerRef = useRef<HTMLElement | null>(null);
  if (openerRef.current === null) {
    openerRef.current = document.activeElement as HTMLElement | null;
  }
  useEffect(
    () => () => {
      const opener = openerRef.current;
      if (opener?.isConnected) opener.focus?.();
    },
    [],
  );

  // ── Keyboard Trapping & Escape Dismissal ────────────────────────────────
  const dismissable = !clientsConnecting && !indexing;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!dismissable) return;
        e.preventDefault();
        dismissAndPersist();
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = [
        ...panel.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ];
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!active || !panel.contains(active)) {
        e.preventDefault();
        first.focus();
        return;
      }
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [dismissable, dismissAndPersist]);

  // ── Actions ─────────────────────────────────────────────────────────────
  const toggleClient = (name: string) => {
    setClients((prev) =>
      prev.map((r) => (r.client.name === name ? { ...r, selected: !r.selected } : r)),
    );
  };

  const handleConnectClients = async () => {
    const selectedClients = clients.filter((r) => r.selected);
    if (selectedClients.length === 0) {
      setStep('project');
      return;
    }

    setClientsConnecting(true);
    // Per-client outcome. A client the CLI could not configure has to say so
    // and keep the user on this step — reporting a write that never happened
    // as "Connected" is the one thing this screen must never do.
    const outcome = new Map<string, string | undefined>();
    try {
      for (const row of selectedClients) {
        // Skip manual-only clients (warp, jetbrains-ai) from auto-write
        if (row.client.name === 'warp' || row.client.name === 'jetbrains-ai') continue;
        const level = row.client.name.startsWith('claude') ? 'max' : 'base';
        try {
          const result = await window.electronAPI?.configureMcpClient(row.client.name, level);
          outcome.set(row.client.name, result?.ok ? undefined : (result?.error ?? 'unknown error'));
        } catch (err) {
          outcome.set(row.client.name, String(err));
        }
      }
    } finally {
      setClients((prev) =>
        prev.map((r) => {
          if (!outcome.has(r.client.name)) return r;
          const error = outcome.get(r.client.name);
          return { ...r, connected: !error, error };
        }),
      );
      setClientsConnecting(false);
      if (![...outcome.values()].some(Boolean)) setStep('project');
    }
  };

  const handleSelectFolder = async () => {
    const folder = await window.electronAPI?.selectFolder();
    if (folder) {
      const parts = folder.split(/[/\\]/);
      const name = parts[parts.length - 1] || folder;
      setGuessedProject({ path: folder, name });
      setSelectedProject(folder);
    }
  };

  const handleIndexProject = async () => {
    if (!selectedProject) {
      setStep('complete');
      return;
    }
    setIndexing(true);
    setProjectError(null);
    try {
      // Registering with the daemon is what actually indexes the directory.
      // Opening a tab only renders a view of a project the daemon may never
      // have heard of, which is how the wizard used to finish on a clean DMG
      // install with nothing indexed.
      const res = await fetch(`${BASE}/api/projects`, {
        // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- BASE is the app's own local daemon (127.0.0.1), not a remote endpoint.
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root: selectedProject }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      addRecentProject(selectedProject);
      await window.electronAPI?.openProjectTab(selectedProject);
    } catch (err) {
      setProjectError(String(err));
      setIndexing(false);
      return;
    }
    setIndexing(false);
    dismissAndPersist();
  };

  const handleRetryDaemon = async () => {
    setDaemonState({ phase: 'installing' });
    try {
      const result = await window.electronAPI?.retryDaemonSetup?.();
      if (result?.phase === 'ready') {
        setDaemonState({ phase: 'ready' });
        setStep('clients');
      } else if (result?.phase === 'failed') {
        setDaemonState({ phase: 'failed', message: result.message });
      }
    } catch (err) {
      setDaemonState({ phase: 'failed', message: String(err) });
    }
  };

  // ── Render Content per Step ─────────────────────────────────────────────
  let title = t('guard:wizard.welcomeTitle');
  let body: React.ReactNode = null;

  if (step === 'daemon') {
    title = t('guard:wizard.daemon.title');
    body = (
      <div className="flex flex-col gap-4">
        {daemonState.phase === 'installing' && (
          <div className="flex flex-col gap-3 py-2">
            <div className="flex items-center gap-2.5">
              <StatusDot tone="blue" pulse />
              <span className="text-[13px] leading-4" style={{ color: 'var(--label)' }}>
                {t('guard:wizard.daemon.installing')}
              </span>
            </div>
            <div
              className="w-full h-1.5 rounded-full overflow-hidden"
              style={{ background: 'var(--surface-sunken)' }}
              role="progressbar"
              aria-label={t('guard:wizard.daemon.installing')}
            >
              <div
                className="h-full rounded-full animate-pulse"
                style={{ width: '70%', background: 'var(--accent-fill)' }}
              />
            </div>
          </div>
        )}

        {daemonState.phase === 'failed' && (
          <div className="flex flex-col gap-3 py-2">
            <div className="flex items-center gap-2" style={{ color: 'var(--status-red)' }}>
              <Icon name="warning" size={16} />
              <span className="text-[13px] leading-4 font-medium">
                {t('guard:wizard.daemon.failed')}
              </span>
            </div>
            {daemonState.message && (
              <p className="text-[12px] leading-4" style={{ color: 'var(--label-secondary)', margin: 0 }}>
                {daemonState.message}
              </p>
            )}
            <div className="lx-sheet-actions mt-2">
              <Button size="large" onClick={dismissAndPersist}>
                {t('guard:wizard.skip')}
              </Button>
              <Button autoFocus size="large" variant="prominent" onClick={handleRetryDaemon}>
                {t('guard:wizard.daemon.retry')}
              </Button>
            </div>
          </div>
        )}

        {daemonState.phase === 'ready' && (
          <div className="flex flex-col gap-4 py-2">
            <div className="flex items-center gap-2.5">
              <StatusDot tone="green" />
              <span className="text-[13px] leading-4" style={{ color: 'var(--label)' }}>
                {t('guard:wizard.daemon.ready')}
              </span>
            </div>
            <div className="lx-sheet-actions">
              <Button autoFocus size="large" variant="prominent" onClick={() => setStep('clients')}>
                {t('guard:wizard.continue')}
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  } else if (step === 'clients') {
    title = t('guard:wizard.clients.title');
    body = (
      <div className="flex flex-col gap-4">
        <p className="lx-sheet-text" style={{ margin: 0 }}>
          {t('guard:wizard.clients.subtitle')}
        </p>

        {clientsLoading ? (
          <div className="py-6 flex items-center justify-center gap-2">
            <StatusDot tone="blue" pulse />
            <span className="text-[13px] leading-4" style={{ color: 'var(--label-secondary)' }}>
              {t('guard:wizard.clients.connecting')}
            </span>
          </div>
        ) : clients.length === 0 ? (
          <p className="text-[13px] leading-5 py-3" style={{ color: 'var(--label-secondary)', margin: 0 }}>
            {t('guard:wizard.clients.none')}
          </p>
        ) : (
          <Card>
            <div className="flex flex-col divide-y divide-[var(--separator)]">
              {clients.map((row) => {
                const displayName = MCP_CLIENT_DISPLAY_NAMES[row.client.name] ?? row.client.name;
                const isManual = row.client.name === 'warp' || row.client.name === 'jetbrains-ai';

                return (
                  <label
                    key={row.client.name}
                    className="flex items-start gap-3 p-3 cursor-pointer select-none hover:bg-[var(--surface-sunken)] transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={row.selected}
                      onChange={() => toggleClient(row.client.name)}
                      className="mt-0.5 rounded cursor-pointer accent-[var(--accent-fill)]"
                      style={{ width: 16, height: 16 }}
                      aria-label={displayName}
                    />
                    <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] leading-4 font-medium" style={{ color: 'var(--label)' }}>
                          {displayName}
                        </span>
                        {row.connected && (
                          <Badge tone="green">{t('guard:wizard.clients.connected')}</Badge>
                        )}
                        {isManual && (
                          <Badge tone="orange">{t('guard:wizard.clients.manualNote')}</Badge>
                        )}
                      </div>
                      <div className="text-[11px] leading-[14px] font-mono truncate" style={{ color: 'var(--label-secondary)' }}>
                        {row.client.configPath}
                      </div>
                      {row.error && (
                        <div
                          className="text-[11px] leading-[14px]"
                          style={{ color: 'var(--status-red)' }}
                          role="alert"
                        >
                          {row.error}
                        </div>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>
          </Card>
        )}

        {clients.some((r) => r.error) && (
          <p className="text-[12px] leading-4" style={{ color: 'var(--status-red)', margin: 0 }}>
            {t('guard:wizard.clients.failed')}
          </p>
        )}

        <div className="lx-sheet-actions">
          <Button size="large" onClick={() => setStep('project')}>
            {t('guard:wizard.skip')}
          </Button>
          <Button
            autoFocus
            size="large"
            variant="prominent"
            disabled={clientsConnecting}
            onClick={handleConnectClients}
          >
            {clientsConnecting ? t('guard:wizard.clients.connecting') : t('guard:wizard.clients.connect')}
          </Button>
        </div>
      </div>
    );
  } else if (step === 'project') {
    title = t('guard:wizard.project.title');
    body = (
      <div className="flex flex-col gap-4">
        <p className="lx-sheet-text" style={{ margin: 0 }}>
          {t('guard:wizard.project.subtitle')}
        </p>

        {guessedProject ? (
          <Card>
            <div className="flex items-center justify-between gap-3 p-3.5">
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <Icon name="folder" size={24} className="text-[var(--accent-fill)] shrink-0" />
                <div className="flex flex-col min-w-0 flex-1">
                  <div className="text-[13px] leading-4 font-medium truncate" style={{ color: 'var(--label)' }}>
                    {guessedProject.name}
                  </div>
                  <div className="text-[11px] leading-[14px] font-mono truncate" style={{ color: 'var(--label-secondary)' }}>
                    {guessedProject.path}
                  </div>
                </div>
              </div>
              <Button size="small" onClick={handleSelectFolder}>
                {t('guard:wizard.project.changeFolder')}
              </Button>
            </div>
          </Card>
        ) : (
          <Card>
            <div className="flex flex-col items-center justify-center gap-3 p-6 text-center">
              <Icon name="folder_open" size={32} className="text-[var(--label-secondary)]" />
              <p className="text-[13px] leading-4" style={{ color: 'var(--label-secondary)', margin: 0 }}>
                {t('guard:wizard.project.noFolder')}
              </p>
              <Button onClick={handleSelectFolder}>
                {t('guard:wizard.project.chooseFolder')}
              </Button>
            </div>
          </Card>
        )}

        {projectError && (
          <p className="text-[12px] leading-4" style={{ color: 'var(--status-red)', margin: 0 }} role="alert">
            {t('guard:wizard.project.failed')} {projectError}
          </p>
        )}

        <div className="lx-sheet-actions">
          <Button size="large" onClick={() => setStep('complete')}>
            {t('guard:wizard.skip')}
          </Button>
          <Button
            autoFocus
            size="large"
            variant="prominent"
            disabled={indexing || !selectedProject}
            onClick={handleIndexProject}
          >
            {indexing ? t('guard:wizard.project.indexing') : t('guard:wizard.project.index')}
          </Button>
        </div>
      </div>
    );
  } else if (step === 'complete') {
    title = t('guard:wizard.complete.title');
    const connectedCount = clients.filter((c) => c.connected || c.selected).length;

    body = (
      <div className="flex flex-col gap-4">
        <p className="lx-sheet-text" style={{ margin: 0 }}>
          {t('guard:wizard.complete.subtitle')}
        </p>

        <Card>
          <div className="flex flex-col divide-y divide-[var(--separator)]">
            <div className="flex items-center justify-between p-3">
              <span className="text-[13px] leading-4" style={{ color: 'var(--label)' }}>
                {t('guard:wizard.complete.daemon')}
              </span>
              <div className="flex items-center gap-1.5">
                <StatusDot tone="green" />
                <span className="text-[12px] leading-4" style={{ color: 'var(--label-secondary)' }}>
                  {t('guard:health.ok')}
                </span>
              </div>
            </div>
            <div className="flex items-center justify-between p-3">
              <span className="text-[13px] leading-4" style={{ color: 'var(--label)' }}>
                {t('guard:wizard.complete.clients')}
              </span>
              <Badge tone="blue">{connectedCount}</Badge>
            </div>
            {selectedProject && (
              <div className="flex items-center justify-between p-3">
                <span className="text-[13px] leading-4" style={{ color: 'var(--label)' }}>
                  {t('guard:wizard.complete.project')}
                </span>
                <span className="text-[12px] leading-4 font-mono truncate max-w-[200px]" style={{ color: 'var(--label-secondary)' }}>
                  {guessedProject?.name ?? selectedProject}
                </span>
              </div>
            )}
          </div>
        </Card>

        <div className="lx-sheet-actions">
          <Button autoFocus size="large" variant="prominent" onClick={dismissAndPersist}>
            {t('guard:wizard.finish')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="lx-sheet-scrim" onClick={dismissable ? dismissAndPersist : undefined}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="lx-sheet"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={titleId} className="lx-sheet-title">
          {title}
        </h2>
        <div id={bodyId} className="lx-sheet-body">
          {body}
        </div>
      </div>
    </div>
  );
}
