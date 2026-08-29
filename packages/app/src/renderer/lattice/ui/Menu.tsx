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

import type React from 'react';
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { FloatingLayer } from '../FloatingLayer';
import { Icon } from '../icons';
import { PopUpButton, type PopUpOption } from './PopUpButton';

/** Anchors a Menu under the button held in `ref`, or at an explicit point.
    Lives here rather than next to one surface because every surface with an
    overflow or row menu needs the same three lines. */
export function useMenuAnchor() {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const open = (): void => {
    const r = ref.current?.getBoundingClientRect();
    setAt(r ? { x: r.right, y: r.bottom + 4 } : { x: 0, y: 52 });
  };
  /** For menus opened from a row button rather than a fixed toolbar anchor. */
  const openAt = (point: { x: number; y: number }): void => setAt(point);
  return { ref, at, open, openAt, close: () => setAt(null) };
}

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
  /* Whatever had focus when the menu opened — normally the trigger button,
     since a click focuses it. A menu that closes and drops focus on <body>
     strands the keyboard: Tab restarts at the top of the document. */
  const returnFocusRef = useRef<Element | null>(null);
  if (returnFocusRef.current === null) returnFocusRef.current = document.activeElement;

  useEffect(() => {
    const onPress = (e: MouseEvent): void => {
      const layer = layerRef.current;
      // Press inside the floating layer — leave it to the MenuItems (which
      // call onClose themselves after their action).
      if (layer && e.target instanceof Node && layer.contains(e.target)) return;
      onCloseRef.current();
    };
    /* Every enabled item, in DOM order. Read per keypress rather than cached:
       a menu's items can be conditional (an item that only exists while an
       update is pending), and a stale list arrows onto a node that is gone.

       A MenuChoiceRow is ONE stop, not one per segment: up/down step over the
       whole row and left/right move inside it, which is the only arrangement
       that leaves both axes meaning something. Its stop is whichever segment is
       currently checked, so arrowing back into the row lands on the live value
       rather than on a fixed position. */
    const ENABLED = '[role^="menuitem"]:not([disabled]):not([aria-disabled="true"])';
    const items = (): HTMLElement[] => {
      const layer = layerRef.current;
      if (!layer) return [];
      const out: HTMLElement[] = [];
      // Document order, and a row container always precedes its own segments.
      for (const el of Array.from(
        layer.querySelectorAll<HTMLElement>(`${ENABLED}, [data-menu-row]`),
      )) {
        if (el.hasAttribute('data-menu-row')) {
          /* A pill row stops on its checked segment; a MenuPopUpRow has no
             segments at all, so its single control is the stop. */
          const stop =
            el.querySelector<HTMLElement>('[aria-checked="true"]') ??
            el.querySelector<HTMLElement>(ENABLED) ??
            el.querySelector<HTMLElement>('select:not([disabled])');
          if (stop) out.push(stop);
        } else if (!el.closest('[data-menu-row]')) {
          out.push(el);
        }
      }
      return out;
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        // Consume Escape: the menu is the topmost layer, an enclosing surface
        // (panel / dialog) must not ALSO close from the same keypress.
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') {
        return;
      }
      /* Roving focus, macOS-style: nothing is highlighted until the first
         arrow, and then the list wraps. Focus IS the highlight here — the real
         one, so Enter and Space activate through the native button. */
      const list = items();
      if (list.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const from = list.indexOf(document.activeElement as HTMLElement);
      const next =
        e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? list.length - 1
            : e.key === 'ArrowDown'
              ? from < 0
                ? 0
                : (from + 1) % list.length
              : from < 0
                ? list.length - 1
                : (from - 1 + list.length) % list.length;
      list[next].focus();
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
      // Only take focus back if the menu still has it: an outside press has
      // already given it to whatever was clicked, and stealing it back would
      // undo that click.
      const back = returnFocusRef.current;
      const active = document.activeElement;
      const inMenu = active instanceof Node && layerRef.current?.contains(active);
      if ((inMenu || active === document.body) && back instanceof HTMLElement && back.isConnected) {
        back.focus();
      }
    };
  }, []);

  return (
    <FloatingLayer
      ref={layerRef}
      role="menu"
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
  // A toggle item is a menuitemcheckbox and must publish its state; a plain one
  // is a menuitem. Without these the menu was a bag of unlabelled buttons.
  const role = showCheckSlot ? 'menuitemcheckbox' : 'menuitem';
  return (
    <button
      type={type}
      role={role}
      aria-checked={showCheckSlot ? checked === true : undefined}
      className={cls}
      {...rest}
    >
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

export interface MenuChoice<T extends string> {
  value: T;
  /** The accessible name AND the tooltip. For an icon segment it is the only name;
      for a word segment it is the long form the short text abbreviates. */
  label: string;
  /** A pill segment is a glyph, always: a choice whose values need words does
      not fit 20px squares and belongs in a MenuPopUpRow instead. */
  icon: string;
}

export interface MenuChoiceRowProps<T extends string> {
  /** Visible row label; also the group's accessible name. */
  label: string;
  options: ReadonlyArray<MenuChoice<T>>;
  value: T;
  onChange: (next: T) => void;
}

/**
 * A menu row that carries a CHOICE rather than an action: a label on the left,
 * an inline segmented control on the right, one row (TRA-363 follow-up).
 *
 * The alternative — a section header plus one checked item per value — spends
 * four rows on a three-state preference, inside a popover whose justification
 * was that a menu item costs no sidebar height. A header above a single control
 * is weight without information; the row's own label already says what it is.
 *
 * ARIA, because a control inside a menu is where this usually goes wrong:
 * `role="group"` is a legal child of `role="menu"` and the segments are
 * `menuitemradio`, so the set announces as "Theme, Dark, selected" instead of
 * three unrelated pressed buttons. Roving tabindex keeps the row a single Tab
 * stop; `Menu`'s traversal keeps it a single up/down stop.
 */
export function MenuChoiceRow<T extends string>({
  label,
  options,
  value,
  onChange,
}: MenuChoiceRowProps<T>): ReactNode {
  const rowRef = useRef<HTMLDivElement>(null);
  /* Focus follows selection, but only when the keyboard put it there. A click
     selects without stealing focus from wherever it already was. */
  const keyboardRef = useRef(false);

  useEffect(() => {
    if (!keyboardRef.current) return;
    keyboardRef.current = false;
    rowRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, [value]);

  const step = (delta: number, e: React.KeyboardEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const from = Math.max(
      0,
      options.findIndex((o) => o.value === value),
    );
    const next = options[(from + delta + options.length) % options.length];
    if (next.value === value) return;
    keyboardRef.current = true;
    onChange(next.value);
  };

  return (
    <div
      ref={rowRef}
      className="ws-ctx-row"
      role="group"
      aria-label={label}
      data-menu-row=""
      /* Left/right only. Up/down and Home/End are consumed by Menu's document
         listener in the capture phase before they reach here, which is what
         keeps them meaning "move between rows". */
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') step(1, e);
        else if (e.key === 'ArrowLeft') step(-1, e);
      }}
    >
      <span className="ws-ctx-row-label">{label}</span>
      {/* No `sz-small`: at 20px the track left 1px above and below a 14px glyph
          while the segments ran 30px wide, which is the squeeze Nikolai saw —
          crushed vertically, loose horizontally (TRA-376). The default 24px
          track carries square 20px segments; island.css sets their geometry. */}
      <div className="lx-seg ws-ctx-seg">
        {options.map((option) => {
          const checked = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={checked}
              aria-label={option.label}
              title={option.label}
              // Roving tabindex: the row is one Tab stop, entered on its value.
              tabIndex={checked ? 0 : -1}
              className={'lx-seg-item' + (checked ? ' is-active' : '')}
              onClick={() => onChange(option.value)}
            >
              <Icon name={option.icon} size={12} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

export interface MenuPopUpRowProps<T extends string> {
  /** Visible row label; also the pop-up button's accessible name. */
  label: string;
  options: ReadonlyArray<PopUpOption<T>>;
  value: T;
  onChange: (next: T) => void;
}

/**
 * The same row as MenuChoiceRow for a choice a pill cannot carry: too many
 * values, or values that are words rather than glyphs (TRA-450).
 *
 * DESIGN.md draws the line at four. Language is the case that crossed it — ten
 * languages named in their own scripts do not fit ten 20px segments — and the
 * native pop-up is the right escape hatch precisely because its list IS the
 * platform's menu, scrolling and type-ahead included, for no code of ours.
 *
 * Changing the value does not close the enclosing menu: watching the app
 * switch language under the row is the whole point of an inline switcher.
 *
 * No `role="group"`, unlike MenuChoiceRow: a group exists there to bind several
 * radios into one set, and here there is a single control that already carries
 * the row's name. Wrapping it would only make a screen reader say "Language"
 * twice. `data-menu-row` still marks it, because Menu's up/down traversal reads
 * that attribute — not the role — to treat a row as one stop.
 */
export function MenuPopUpRow<T extends string>({
  label,
  options,
  value,
  onChange,
}: MenuPopUpRowProps<T>): ReactNode {
  return (
    <div className="ws-ctx-row" data-menu-row="">
      <span className="ws-ctx-row-label" aria-hidden="true">
        {label}
      </span>
      <PopUpButton options={options} value={value} onChange={onChange} aria-label={label} />
    </div>
  );
}

export function MenuSection({ children }: { children: ReactNode }): ReactNode {
  return (
    <div role="presentation" className="ws-ctx-section">
      {children}
    </div>
  );
}

export function MenuSeparator(): ReactNode {
  return <div role="separator" className="ws-ctx-sep" />;
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
