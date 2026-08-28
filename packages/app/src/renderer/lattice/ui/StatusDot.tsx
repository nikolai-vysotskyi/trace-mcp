/* StatusDot.tsx — a small colored status dot (.ws-statusdot).

   Replaces the many one-off `.dot` / `.st` / `…-dot` spans (each re-hardcoding
   its color) with a single tone-driven dot. `pulse` adds the soft pulsing halo
   used for "live"/"connected" indicators. Tones share the status tokens with
   Badge. */

import type { CSSProperties, ReactNode } from 'react';
import type { Tone } from './Badge';

export interface StatusDotProps {
  /** `gold`/`pink` are the pre-TRA-290 names for `orange`/`purple`. */
  tone?: Tone | 'gold' | 'pink';
  /** Diameter in px (default 8). */
  size?: number;
  /** Pulsing halo (live indicator). */
  pulse?: boolean;
  className?: string;
  title?: string;
}

export function StatusDot({
  tone = 'neutral',
  size = 8,
  pulse = false,
  className,
  title,
}: StatusDotProps): ReactNode {
  const t = tone === 'gold' ? 'orange' : tone === 'pink' ? 'purple' : tone;
  const cls = ['ws-statusdot', `t-${t}`, pulse ? 'pulse' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <span
      className={cls}
      title={title}
      style={{ width: size, height: size } as CSSProperties}
    />
  );
}
