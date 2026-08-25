import { Icon } from '../../lattice/icons';
import { Badge, type Tone } from '../../lattice/ui';
import type { ProjectViewModel, TechDebtGrade } from '../types';

export interface ProjectMetricsBadgesProps {
  project: ProjectViewModel;
  /** Compact rendering — smaller chips, drops the "untested" pill. Default false. */
  dense?: boolean;
}

const GRADE_TONE: Record<TechDebtGrade, Tone> = {
  A: 'green',
  B: 'green',
  C: 'gold',
  D: 'red',
  F: 'red',
};

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
      {grade && (
        <Badge tone={GRADE_TONE[grade]} variant="outline" title={`Tech-debt grade ${grade}`}>
          {grade}
        </Badge>
      )}
      {sec > 0 && (
        <Badge
          tone="red"
          variant="outline"
          title={`${sec} critical+high security finding${sec === 1 ? '' : 's'}`}
        >
          <Icon name="lock" size={iconSize} /> {sec}
        </Badge>
      )}
      {dead > 0 && (
        <Badge tone="gold" variant="outline" title={`${dead} dead export${dead === 1 ? '' : 's'}`}>
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
