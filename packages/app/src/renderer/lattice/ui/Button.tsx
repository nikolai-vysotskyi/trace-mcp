/* Button.tsx — the single button primitive for the Lattice island surfaces.

   Wraps the canonical button classes from island.css (NO new styling): pick a
   `variant` and the component emits the matching class — so call sites stop
   hand-writing `<button className="ws-primary">` etc. and there is ONE place
   that knows the markup contract (leading icon slot, toggle state, icon-only).

     primary → .ws-primary   accent-filled CTA (32px)
     chip    → .ws-chipbtn   bordered neutral chip (30px); `iconOnly` → square
     text    → .ws-textbtn   borderless tertiary text button
     mini    → .ws-mini      24px icon-only action (island header / toolbar)

   For the NATIVE-WINDOW (.dlg) surface use DlgButton instead — it speaks the
   separate `--d-*` token scope (see Dlg.tsx). */

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Icon } from '../icons';

export type ButtonVariant = 'primary' | 'chip' | 'text' | 'mini';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** Leading icon name (see icons.tsx GLYPHS). */
  icon?: string;
  iconSize?: number;
  /** chip variant only: render a square icon-only chip (.ws-chipbtn.icon). */
  iconOnly?: boolean;
  /** chip variant only: toggle styling (.ws-chipbtn.toggle.is-on when active). */
  toggle?: boolean;
  active?: boolean;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'ws-primary',
  chip: 'ws-chipbtn',
  text: 'ws-textbtn',
  mini: 'ws-mini',
};

export function Button({
  variant = 'chip',
  icon,
  iconSize,
  iconOnly = false,
  toggle = false,
  active = false,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps): ReactNode {
  const cls = [
    VARIANT_CLASS[variant],
    variant === 'chip' && iconOnly ? 'icon' : '',
    variant === 'chip' && toggle ? 'toggle' : '',
    toggle && active ? 'is-on' : '',
    !toggle && active ? 'is-active' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  const glyphSize = iconSize ?? (variant === 'mini' ? 16 : 15);

  return (
    <button type={type} className={cls} {...rest}>
      {icon ? <Icon name={icon} size={glyphSize} /> : null}
      {children}
    </button>
  );
}
