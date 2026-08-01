/* Badge.tsx — small status/label tag for island surfaces (.ws-badge).

   Consolidates the dozen ad-hoc badge/pill/tag styles scattered across the
   domain stylesheets onto ONE tone scale driven by the shared status tokens
   (see island.css → "STATUS PALETTE / shared badge + dot"). Two looks:
     variant="solid"   → tinted fill + colored text (default)
     variant="outline" → transparent fill + colored 1px ring

   Tones map to the canonical app status colors so callers stop re-hardcoding
   `#2f9e6e` / `#e0563a` / `#cda23f` etc. */

import type { ReactNode } from 'react';

export type Tone = 'neutral' | 'accent' | 'green' | 'red' | 'gold' | 'blue' | 'pink';

export interface BadgeProps {
  tone?: Tone;
  variant?: 'solid' | 'outline';
  className?: string;
  children: ReactNode;
}

export function Badge({
  tone = 'neutral',
  variant = 'solid',
  className,
  children,
}: BadgeProps): ReactNode {
  const cls = ['ws-badge', `t-${tone}`, variant === 'outline' ? 'outline' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return <span className={cls}>{children}</span>;
}
