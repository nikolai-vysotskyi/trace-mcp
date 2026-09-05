/* DaemonDownPane — the pane a surface shows when the daemon never answered.

   One condition gets one sentence (DESIGN.md §5). An unreachable daemon is not a
   wait, it is a button: every surface that depends on the daemon says the same
   thing and offers the same action, rather than each inventing its own wording
   for the same dead process.

   Lifted out of Workspace.tsx when Project Overview became the second caller
   (TRA-469). The strings stay in the `workspace` namespace they were written in —
   moving them would churn ten locale files to say what they already say.

   TRA-438 added a condition in front of that one. On a machine that installed
   the DMG and nothing else, the app installs the daemon itself on first launch;
   until that finishes there is no daemon to be down, and "The daemon isn't
   running" above a Start button that starts nothing is the worst thing a
   first-time user can be shown. The setup state is read here rather than
   threaded through three call sites, all of which would pass the same value. */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, EmptyState } from '../lattice/ui';

type SetupState =
  | { phase: 'idle' }
  | { phase: 'installing' }
  | { phase: 'ready' }
  | { phase: 'unresponsive'; message: string }
  | { phase: 'failed'; message: string };

/** Follow the main process's daemon-install progress. `idle` outside Electron. */
export function useDaemonSetupState(): SetupState {
  const [state, setState] = useState<SetupState>({ phase: 'idle' });
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.daemonSetupState) return;
    let cancelled = false;
    void api.daemonSetupState().then((s) => {
      if (!cancelled) setState(s);
    });
    const off = api.onDaemonSetupState?.((s) => setState(s));
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);
  return state;
}

export function DaemonDownPane({
  restarting,
  onRestart,
}: {
  restarting: boolean;
  onRestart: () => void;
}) {
  const { t } = useTranslation('workspace');
  const setup = useDaemonSetupState();
  const [retrying, setRetrying] = useState(false);

  if (setup.phase === 'installing') {
    return (
      <EmptyState
        icon="cable"
        iconSize={32}
        title={t('daemonInstallingTitle')}
        subtitle={t('daemonInstallingSubtitle')}
      />
    );
  }

  /* Live but not answering. No repair button: there is nothing broken to
     repair, and "Try again" here would reinstall a working daemon (TRA-939).
     The surfaces behind this pane keep revalidating, so it clears itself. */
  if (setup.phase === 'unresponsive') {
    return (
      <EmptyState
        icon="cable"
        iconSize={32}
        title={t('daemonBusyTitle')}
        subtitle={setup.message}
      />
    );
  }

  if (setup.phase === 'failed') {
    return (
      <EmptyState
        icon="cable"
        iconSize={32}
        title={t('daemonInstallFailedTitle')}
        subtitle={setup.message}
        action={
          <Button
            variant="prominent"
            size="large"
            disabled={retrying}
            onClick={() => {
              setRetrying(true);
              void window.electronAPI?.retryDaemonSetup?.().finally(() => setRetrying(false));
            }}
          >
            {retrying ? t('daemonInstallRetrying') : t('daemonInstallRetry')}
          </Button>
        }
      />
    );
  }

  return (
    <EmptyState
      icon="cable"
      iconSize={32}
      title={t('daemonDownTitle')}
      subtitle={t('daemonDownSubtitle')}
      action={
        <Button variant="prominent" size="large" onClick={onRestart} disabled={restarting}>
          {restarting ? t('startingDaemon') : t('startDaemon')}
        </Button>
      }
    />
  );
}
