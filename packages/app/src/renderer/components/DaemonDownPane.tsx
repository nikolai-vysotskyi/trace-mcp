/* DaemonDownPane — the pane a surface shows when the daemon never answered.

   One condition gets one sentence (DESIGN.md §5). An unreachable daemon is not a
   wait, it is a button: every surface that depends on the daemon says the same
   thing and offers the same action, rather than each inventing its own wording
   for the same dead process.

   Lifted out of Workspace.tsx when Project Overview became the second caller
   (TRA-469). The strings stay in the `workspace` namespace they were written in —
   moving them would churn ten locale files to say what they already say. */

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
