import { useTranslation } from 'react-i18next';
import { formatNumber } from '../../i18n/format';
import { Icon } from '../../lattice/icons';
import { Badge, GradeBadge } from '../../lattice/ui';
import type { ProjectViewModel } from '../types';

export interface ProjectMetricsBadgesProps {
  project: ProjectViewModel;
  /** Compact rendering — smaller chips, drops the "untested" pill. Default false. */
  dense?: boolean;
}

/**
 * Horizontal strip of small chips summarising health metrics for one project:
 * tech-debt grade pill, critical security count, dead-exports count, untested
 * count. Rendered nothing when the project has no metrics yet (cold cache).
 *
 * Shared between WorkspaceCompactView and (future) WorkspaceCardsView.
 */
export function ProjectMetricsBadges({ project, dense = false }: ProjectMetricsBadgesProps) {
  const { t } = useTranslation('workspace');
  if (!project.hasMetrics) return null;

  const grade = project.techDebtGrade;
  const sec = project.securityFindings ?? 0;
  const dead = project.deadExports ?? 0;
  const untested = project.untestedSymbols ?? 0;
  const iconSize = dense ? 9 : 10;

  return (
    <div className="flex items-center gap-1 whitespace-nowrap">
      {grade && <GradeBadge grade={grade} />}
      {sec > 0 && (
        <Badge
          tone="red"
          title={t('badgeSecurity', { count: sec, n: formatNumber(sec) })}
          aria-label={t('badgeSecurityAria', { count: sec, n: formatNumber(sec) })}
        >
          <Icon name="lock" size={iconSize} /> {sec}
        </Badge>
      )}
      {dead > 0 && (
        <Badge
          tone="orange"
          title={t('badgeDeadExports', { count: dead, n: formatNumber(dead) })}
          aria-label={t('badgeDeadExports', { count: dead, n: formatNumber(dead) })}
        >
          <Icon name="bug_report" size={iconSize} /> {dead}
        </Badge>
      )}
      {!dense && untested > 0 && (
        <Badge
          tone="neutral"
          title={t('badgeUntestedTitle', { count: untested, n: formatNumber(untested) })}
        >
          {t('badgeUntested', { n: formatNumber(untested) })}
        </Badge>
      )}
    </div>
  );
}
