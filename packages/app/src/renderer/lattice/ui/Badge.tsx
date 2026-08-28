/* Badge.tsx — small status tag (TRA-290).

   Capsule, 11px/500, sentence case. ONE look: a tinted fill at 18% with the
   SATURATED HUE as the label colour — every pair is verified ≥ 4.5:1 in both
   appearances by __tests__/primitives.test.ts.

   What this replaces: 9.5px/700/0.05em with ALL-CAPS callers, and the grade
   badge that painted #ffffff on #ffcc00 at 1.6:1. There is no `variant`
   anymore — the outline look was a second thing to keep contrast-correct for
   no gain. */

import type { ReactNode } from 'react';
import { Icon } from '../icons';

export type Tone = 'neutral' | 'accent' | 'green' | 'orange' | 'red' | 'blue' | 'purple';

/** Superseded tone names, mapped so existing call sites keep working. */
const LEGACY_TONE: Record<string, Tone> = { gold: 'orange', pink: 'purple' };

export interface BadgeProps {
  tone?: Tone | 'gold' | 'pink';
  /** Leading 11px glyph. A tone is a colour; pairing it with a glyph is what
      keeps a status badge readable without colour vision. */
  icon?: string;
  className?: string;
  title?: string;
  'aria-label'?: string;
  children: ReactNode;
}

export function Badge({
  tone = 'neutral',
  icon,
  className,
  title,
  'aria-label': ariaLabel,
  children,
}: BadgeProps): ReactNode {
  const t = LEGACY_TONE[tone] ?? (tone as Tone);
  const cls = ['lx-badge', `t-${t}`, className ?? ''].filter(Boolean).join(' ');
  return (
    <span className={cls} title={title} aria-label={ariaLabel}>
      {icon ? <Icon name={icon} size={11} /> : null}
      {children}
    </span>
  );
}

const GRADE_TONE: Record<string, Tone> = {
  A: 'green',
  B: 'green',
  C: 'orange',
  D: 'red',
  F: 'red',
};

export interface GradeBadgeProps {
  grade: string;
}

/** Tech-debt grade. The letter alone means nothing to a screen reader, so the
    accessible name spells it out. */
export function GradeBadge({ grade }: GradeBadgeProps): ReactNode {
  return (
    <Badge
      tone={GRADE_TONE[grade] ?? 'neutral'}
      title={`Tech debt grade ${grade}`}
      aria-label={`Tech debt grade ${grade}`}
    >
      {grade}
    </Badge>
  );
}
