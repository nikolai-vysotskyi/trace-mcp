/**
 * DaemonDownPane — the one thing a surface says when the daemon is not
 * answering at all (TRA-397, shared in TRA-469).
 *
 * "One condition gets one sentence" (DESIGN.md §5) is a rule about the whole
 * screen, not about one component: it only holds if every surface reaches for
 * the same answer. Workspace had this pane and Project Overview did not, so
 * Project Overview said "the daemon may still be indexing" five times over a
 * daemon it was simultaneously reporting unreachable — four Retry buttons
 * firing at a refused socket, and a wait offered where there is a process to
 * start.
 *
 * Copy is unchanged from where it was defined, so the ten locales keep the
 * strings they already have. (Clients.tsx still carries its own near-duplicate
 * under `clients:daemonDownTitle`; folding it in changes copy that ships today,
 * so it is left for its own change.)
 */
import { useTranslation } from 'react-i18next';
import { Button, EmptyState } from '../lattice/ui';

export function DaemonDownPane({
  restarting,
  onRestart,
}: {
  restarting: boolean;
  onRestart: () => void;
}) {
  const { t } = useTranslation('workspace');
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
