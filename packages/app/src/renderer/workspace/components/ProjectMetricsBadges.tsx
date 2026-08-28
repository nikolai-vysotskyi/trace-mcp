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
          title={`${sec} critical+high security finding${sec === 1 ? '' : 's'}`}
          aria-label={`${sec} critical or high security finding${sec === 1 ? '' : 's'}`}
        >
          <Icon name="lock" size={iconSize} /> {sec}
        </Badge>
      )}
      {dead > 0 && (
        <Badge
          tone="orange"
          title={`${dead} dead export${dead === 1 ? '' : 's'}`}
          aria-label={`${dead} dead export${dead === 1 ? '' : 's'}`}
        >
          <Icon name="bug_report" size={iconSize} /> {dead}
        </Badge>
      )}
      {!dense && untested > 0 && (
        <Badge tone="neutral" title={`${untested} untested symbol${untested === 1 ? '' : 's'}`}>
          untested {untested}
        </Badge>
      )}
    </div>
  );
}
