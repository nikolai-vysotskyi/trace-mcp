import type { ProjectViewModel, TechDebtGrade } from '../types';

export interface ProjectMetricsBadgesProps {
  project: ProjectViewModel;
  /** Compact rendering — smaller chips, drops the "untested" pill. Default false. */
  dense?: boolean;
}

const GRADE_COLOR: Record<TechDebtGrade, string> = {
  A: '#34c759',
  B: '#30d158',
  C: '#ffcc00',
  D: '#ff9f0a',
  F: '#ff3b30',
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
  const sizeClass = dense ? 'text-[10px] px-1 py-0' : 'text-[11px] px-1.5 py-0.5';

  return (
    <div className="flex items-center gap-1 whitespace-nowrap">
      {grade && (
        <span
          className={`${sizeClass} rounded font-bold`}
          style={{ color: '#fff', background: GRADE_COLOR[grade] }}
          title={`Tech-debt grade ${grade}`}
        >
          {grade}
        </span>
      )}
      {sec > 0 && (
        <span
          className={`${sizeClass} rounded font-medium tabular-nums`}
          style={{ color: '#ff3b30', background: '#ff3b3014', border: '0.5px solid #ff3b3040' }}
          title={`${sec} critical+high security finding${sec === 1 ? '' : 's'}`}
        >
          🔒 {sec}
        </span>
      )}
      {dead > 0 && (
        <span
          className={`${sizeClass} rounded font-medium tabular-nums`}
          style={{ color: '#ff9f0a', background: '#ff9f0a14', border: '0.5px solid #ff9f0a40' }}
          title={`${dead} dead export${dead === 1 ? '' : 's'}`}
        >
          💀 {dead}
        </span>
      )}
      {!dense && untested > 0 && (
        <span
          className={`${sizeClass} rounded tabular-nums`}
          style={{ color: 'var(--text-secondary)', background: 'var(--fill-control)' }}
          title={`${untested} untested symbol${untested === 1 ? '' : 's'}`}
        >
          untested {untested}
        </span>
      )}
    </div>
  );
}
