/* Menu.tsx — floating context menu + confirmation popover for island surfaces.

   Wraps FloatingLayer + the .ws-ctx-* / .ws-popover markup (island.css) so the
   dismissal behavior, viewport-clamping and item contract live in ONE place.

     <Menu x y align onClose>
       <MenuSection>Group</MenuSection>
       <MenuItem icon="…" shortcut="⌘C" onClick>Label</MenuItem>
       <MenuItem danger onClick>Delete</MenuItem>
     </Menu>

   Menu dismisses on outside-press WITHOUT swallowing the press (see the effect
   in Menu) — clicking another control closes the menu AND activates that
   control in one click. <ConfirmPopover> is the paired destructive-action
   confirmation; it deliberately KEEPS a click-eating scrim (see comment there). */

import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { FloatingLayer } from '../FloatingLayer';
import { Icon } from '../icons';

export interface MenuProps {
  x: number;
  y: number;
  align?: 'start' | 'end';
  onClose: () => void;
  className?: string;
  children: ReactNode;
}

export function Menu({ x, y, align = 'start', onClose, className, children }: MenuProps): ReactNode {
  const layerRef = useRef<HTMLDivElement>(null);

  // Latest onClose without re-binding document listeners every render —
  // callers routinely pass inline closures (`onClose={() => setMenu(null)}`).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  /* Outside-PRESS dismissal instead of a click-eating scrim. The old full-
     screen scrim swallowed the first click while any menu was open, so e.g.
     the sidebar Settings button needed TWO clicks (one eaten by the scrim,
     one to activate). Listening on `document` in the CAPTURE phase and closing
     WITHOUT preventDefault/stopPropagation lets the same press continue to its
     real target: one click both closes the menu and activates whatever was
     pressed. Right-clicking another tab likewise closes here first, then that
     tab's own onContextMenu fires and re-opens the menu at the new position.
     Note these listeners attach AFTER the event that opened the menu has
     already passed document capture, so the opening click/contextmenu can
     never instantly dismiss it. */
  useEffect(() => {
    const onPress = (e: MouseEvent): void => {
      const layer = layerRef.current;
      // Press inside the floating layer — leave it to the MenuItems (which
      // call onClose themselves after their action).
      if (layer && e.target instanceof Node && layer.contains(e.target)) return;
      onCloseRef.current();
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      // Consume Escape: the menu is the topmost layer, an enclosing surface
      // (panel / dialog) must not ALSO close from the same keypress.
      e.preventDefault();
      e.stopPropagation();
      onCloseRef.current();
    };
    // App/window switch (Cmd-Tab, native dialog opening) — never leave a
    // zombie menu floating over a window the user has left.
    const onWindowBlur = (): void => onCloseRef.current();

    document.addEventListener('mousedown', onPress, true);
    document.addEventListener('contextmenu', onPress, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', onWindowBlur);
    return () => {
      document.removeEventListener('mousedown', onPress, true);
      document.removeEventListener('contextmenu', onPress, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', onWindowBlur);
    };
  }, []);

  return (
    <FloatingLayer
      ref={layerRef}
      className={'ws-ctx-menu' + (className ? ' ' + className : '')}
      x={x}
      y={y}
      align={align}
    >
      {children}
    </FloatingLayer>
  );
}

export interface MenuItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Leading icon glyph (.ws-ctx-ico). */
  icon?: string;
  /** Custom leading glyph node (e.g. a brand mark) — wins over `icon`. */
  iconNode?: ReactNode;
  /** Trailing shortcut hint (.ws-ctx-sc), e.g. "⌘C". */
  shortcut?: ReactNode;
  /** Leading check slot (.ws-ctx-check) for toggle items. */
  checked?: boolean;
  showCheckSlot?: boolean;
  danger?: boolean;
}

export function MenuItem({
  icon,
  iconNode,
  shortcut,
  checked,
  showCheckSlot = false,
  danger = false,
  className,
  children,
  type = 'button',
  ...rest
}: MenuItemProps): ReactNode {
  const cls = ['ws-ctx-item', danger ? 'danger' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <button type={type} className={cls} {...rest}>
      {showCheckSlot ? (
        <span className="ws-ctx-check">{checked ? <Icon name="check" size={14} /> : null}</span>
      ) : null}
      {iconNode ? (
        <span className="ws-ctx-ico">{iconNode}</span>
      ) : icon ? (
        <span className="ws-ctx-ico">
          <Icon name={icon} size={15} />
        </span>
      ) : null}
      {children}
      {shortcut != null ? <span className="ws-ctx-sc">{shortcut}</span> : null}
    </button>
  );
}

export function MenuSection({ children }: { children: ReactNode }): ReactNode {
  return <div className="ws-ctx-section">{children}</div>;
}

export function MenuSeparator(): ReactNode {
  return <div className="ws-ctx-sep" />;
}

export interface ConfirmPopoverProps {
  x: number;
  y: number;
  align?: 'start' | 'end';
  title: ReactNode;
  body?: ReactNode;
  confirmLabel?: ReactNode;
  cancelLabel?: ReactNode;
  danger?: boolean;
  /** Focus the confirm button on open (keyboard-confirm). Default true. */
  autoFocusConfirm?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmPopover({
  x,
  y,
  align = 'start',
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  autoFocusConfirm = true,
  onConfirm,
  onCancel,
}: ConfirmPopoverProps): ReactNode {
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  // Escape always cancels — autoFocusConfirm puts focus on the destructive
  // button, so a keyboard path OUT of the popover must exist besides Tab.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onCancelRef.current();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, []);

  return (
    <>
      {/* Unlike Menu, the confirm popover KEEPS the click-eating scrim on
          purpose: this guards a destructive action, so a stray outside press
          must only dismiss — it must NOT click through and activate whatever
          control happens to be underneath. */}
      <div className="ws-ctx-scrim" onClick={onCancel} onContextMenu={(e) => e.preventDefault()} />
      <FloatingLayer className="ws-popover" x={x} y={y} align={align}>
        <div className="ws-popover-title">{title}</div>
        {body != null ? <div className="ws-popover-body">{body}</div> : null}
        <div className="ws-popover-actions">
          <button type="button" className="ws-popover-btn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={'ws-popover-btn ' + (danger ? 'danger' : 'prominent')}
            autoFocus={autoFocusConfirm}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </FloatingLayer>
    </>
  );
}
