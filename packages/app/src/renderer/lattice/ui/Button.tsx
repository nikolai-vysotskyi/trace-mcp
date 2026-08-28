/* Button.tsx — the single button primitive (TRA-290).

   Three sizes, four variants, one radius:

     size     small 20 · regular 24 · large 28    (nothing else exists)
     variant  prominent  accent capsule, white label — the one default action
              bordered   0.5px --separator capsule, quaternary fill on hover
              plain      no chrome until hover
              icon       24×24 square, 6px radius, 16px glyph

   Every capsule variant is `border-radius: 999px`. The `icon` variant is the
   ONLY square control, and it requires both `aria-label` and `title` — the type
   below will not compile without them, because an icon with neither is
   unreachable by screen reader AND unexplained by hover.

   The pre-TRA-290 variant names (primary/chip/text/mini) still resolve, mapped
   onto the new ones, so existing call sites keep working. They are deprecated;
   don't add new ones. */

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Icon } from '../icons';

export type ButtonSize = 'small' | 'regular' | 'large';
export type ButtonVariant = 'prominent' | 'bordered' | 'plain' | 'icon';

/** Superseded names, kept so the migration is not a big-bang rename. */
export type LegacyButtonVariant = 'primary' | 'chip' | 'text' | 'mini';

const LEGACY: Record<LegacyButtonVariant, ButtonVariant> = {
  primary: 'prominent',
  chip: 'bordered',
  text: 'plain',
  mini: 'icon',
};

interface BaseButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  size?: ButtonSize;
  /** Leading icon name (see icons.tsx GLYPHS). */
  icon?: string;
  iconSize?: number;
  /** Renders the on/selected state (`.is-on`). */
  active?: boolean;
  /** @deprecated no-op — `active` alone drives the on state now. */
  toggle?: boolean;
  /** @deprecated use `variant="icon"`. */
  iconOnly?: boolean;
}

/** `icon` buttons carry no label, so both of these are mandatory. */
interface IconButtonProps extends BaseButtonProps {
  variant: 'icon' | 'mini';
  'aria-label': string;
  title: string;
}

interface LabelledButtonProps extends BaseButtonProps {
  variant?: Exclude<ButtonVariant | LegacyButtonVariant, 'icon' | 'mini'>;
}

export type ButtonProps = IconButtonProps | LabelledButtonProps;

export function Button(props: ButtonProps): ReactNode {
  const {
    variant = 'bordered',
    size = 'regular',
    icon,
    iconSize,
    active = false,
    toggle: _toggle,
    iconOnly: _iconOnly,
    className,
    children,
    type = 'button',
    ...rest
  } = props as BaseButtonProps & { variant?: ButtonVariant | LegacyButtonVariant };

  const v: ButtonVariant = (LEGACY as Record<string, ButtonVariant>)[variant] ?? (variant as ButtonVariant);

  const cls = ['lx-btn', `v-${v}`, `sz-${size}`, active ? 'is-on' : '', className ?? '']
    .filter(Boolean)
    .join(' ');

  const glyphSize = iconSize ?? (v === 'icon' ? 16 : size === 'small' ? 13 : 15);

  return (
    <button type={type} className={cls} {...rest}>
      {icon ? <Icon name={icon} size={glyphSize} /> : null}
      {children}
    </button>
  );
}
