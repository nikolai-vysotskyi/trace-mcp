/* AppMenu.tsx — the sidebar footer, as one row that opens a menu (TRA-363).

   The footer used to grow a row per global action: Settings, then Appearance,
   then a permanent "● Up to date · v3.1.1 ⟳" strip. Two of those were removed
   again for the space they cost (TRA-306); the pattern was the problem, not the
   individual rows. One row that opens a menu ends it, and gives the next global
   action somewhere to go that isn't 28px off the bottom of every window.

   The anchor is the app itself. There are no accounts here, so the identity a
   menu like this normally hangs on is the product: the trigger says its name,
   the header says its version and whether that version is current. The update
   state had a whole sidebar row to say "nothing is wrong"; it now says it in
   the one place you go to act on it, next to "Check for updates…".

   The actions are read from src/shared/global-actions.ts — the same list the
   native application menu builds from, so the two cannot drift apart.
   Appearance is not in that list: it is a preference with three states, it also
   lives in Settings, and it exists on no other surface to drift against. */

import { Icon } from '../lattice/icons';
import { Menu, MenuItem, MenuSection, MenuSeparator, useMenuAnchor } from '../lattice/ui';
import { GLOBAL_ACTIONS, type GlobalAction } from '../../shared/global-actions.js';
import { APPEARANCE_OPTIONS, type Appearance } from '../theme.js';
import { describeStaleRoots, formatAgo, type UpdateState } from '../update-check.js';
import { SidebarRow } from './SidebarRow';

export interface AppMenuProps {
  update: UpdateState;
  checking: boolean;
  onCheckForUpdate: () => void;
  appearance: Appearance;
  onAppearanceChange: (next: Appearance) => void;
  /** Menu window: switch to the Settings surface. Project window: hand off. */
  onSettings: () => void;
}

interface Summary {
  text: string;
  tone: string;
  /** Long-form detail for the cases where one line cannot carry it. */
  title?: string;
}

/** The header's second line: what we know about this version right now. */
function updateSummary(update: UpdateState, checking: boolean): Summary {
  if (checking) return { text: 'Checking…', tone: 'is-busy' };
  if (update.error) return { text: update.error, tone: 'is-warn', title: update.error };
  if (update.available) return { text: `Version ${update.latest} available`, tone: 'is-info' };
  /* `stuck` is available: false — the CLI moved and the bundle did not. Calling
     that "Up to date" is the failure TRA-357 fixed on the card, and this header
     is a second place it could be told. */
  if (update.stuck && update.latest) {
    return { text: `Version ${update.latest} needs a manual install`, tone: 'is-warn' };
  }
  /* Same shape of lie, different cause: this root is current, another npm root
     on the machine is not (TRA-364). Not an error, but not healthy either. */
  if (update.staleRoots?.length) {
    const stale = describeStaleRoots(update.staleRoots);
    return { text: stale.label, tone: 'is-warn', title: stale.title };
  }
  return { text: `Up to date · checked ${formatAgo(update.lastChecked)}`, tone: 'is-ok' };
}

export function AppMenu({
  update,
  checking,
  onCheckForUpdate,
  appearance,
  onAppearanceChange,
  onSettings,
}: AppMenuProps) {
  const menu = useMenuAnchor();
  const open = menu.at !== null;
  const summary = updateSummary(update, checking);

  const toggle = (): void => {
    if (open) {
      menu.close();
      return;
    }
    const r = menu.ref.current?.getBoundingClientRect();
    // Anchor on the row's TOP edge, not its bottom: the footer is the last
    // thing in the window, so FloatingLayer flips the menu above the anchor and
    // it lands 4px clear of the trigger instead of covering it.
    menu.openAt(r ? { x: r.left, y: r.top - 4 } : { x: 8, y: 8 });
  };

  const run = (action: () => void) => () => {
    action();
    menu.close();
  };

  const runAction = (action: GlobalAction): (() => void) => {
    if (action.url) {
      const url = action.url;
      return run(() => void window.electronAPI?.openExternal?.(url));
    }
    if (action.id === 'settings') return run(onSettings);
    return run(onCheckForUpdate);
  };

  const item = (action: GlobalAction) => (
    <MenuItem
      key={action.id}
      icon={action.icon}
      shortcut={action.shortcut}
      disabled={action.id === 'check-for-update' && checking}
      onClick={runAction(action)}
    >
      {action.label}
    </MenuItem>
  );

  /* Settings sits alone above Appearance, the way it does in the app menu on
     macOS; the rest follow the group. Split by id rather than by index so a
     reordered shared list cannot silently move an item into the wrong group. */
  const settings = GLOBAL_ACTIONS.find((a) => a.id === 'settings');
  const rest = GLOBAL_ACTIONS.filter((a) => a.id !== 'settings');

  return (
    <div className="ws-sb-footer">
      <SidebarRow
        rowRef={menu.ref}
        icon="compass"
        label="trace-mcp"
        onClick={toggle}
        title="App menu"
        aria-haspopup="menu"
        aria-expanded={open}
        trailing={
          <span className="ws-sb-chevron" aria-hidden="true">
            <Icon name="expand_more" size={14} />
          </span>
        }
      />
      {menu.at && (
        <Menu x={menu.at.x} y={menu.at.y} onClose={menu.close}>
          {/* Not a menu item: it is what the menu is about. Version first —
              the trigger already carries the name. */}
          <div className="ws-ctx-header">
            <div className="name">Version {update.current ?? '—'}</div>
            <div className={`status ${summary.tone}`}>
              <span className="dot" aria-hidden="true" />
              <span className="text" title={summary.title}>
                {summary.text}
              </span>
            </div>
          </div>
          <MenuSeparator />
          {settings && item(settings)}
          <MenuSeparator />
          <MenuSection>Appearance</MenuSection>
          {APPEARANCE_OPTIONS.map((option) => (
            <MenuItem
              key={option.value}
              showCheckSlot
              checked={appearance === option.value}
              onClick={run(() => onAppearanceChange(option.value))}
            >
              {option.label}
            </MenuItem>
          ))}
          <MenuSeparator />
          {rest.map(item)}
        </Menu>
      )}
    </div>
  );
}
