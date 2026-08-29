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

import { useTranslation } from 'react-i18next';
import { Icon } from '../lattice/icons';
import { Menu, MenuChoiceRow, MenuItem, MenuSeparator, useMenuAnchor } from '../lattice/ui';
import { GLOBAL_ACTIONS, type GlobalAction } from '../../shared/global-actions.js';
import { APPEARANCE_OPTIONS, type Appearance } from '../theme.js';
import { t } from '../i18n/index.js';
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
  /** A shell command the user must run themselves — offered as a copy item. */
  command?: string;
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
  /* Same shape of lie, different cause: this root is current, but the npm root
     the launcher shim points into is not, so every MCP client is on the old
     server (TRA-364). The main process only sends roots that are actually in
     use, so reaching here always means the user has something to fix. */
  if (update.staleRoots?.length) {
    const stale = describeStaleRoots(update.staleRoots);
    return { text: stale.label, tone: 'is-warn', title: stale.title, command: stale.command };
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
  // Unnamespaced: the shared action list carries fully-qualified keys, because
  // the native menu resolves the same ones in the main process.
  const { t } = useTranslation();
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
      {t(action.labelKey)}
    </MenuItem>
  );

  /* Three groups, not two. Settings sits alone above Theme, the way it does in
     the app menu on macOS. Below Theme the remaining actions split on what they
     DO: `links` leave for a browser, `commands` act on this app — so
     "Check for updates…" gets its own group rather than trailing the two GitHub
     pages as if it were a third destination (TRA-376).

     The split is on `url`, not on an id list: an action that opens a page is
     already declared that way in global-actions.ts, so a new entry lands in the
     right group without this file learning its name. */
  const settings = GLOBAL_ACTIONS.find((a) => a.id === 'settings');
  const rest = GLOBAL_ACTIONS.filter((a) => a.id !== 'settings');
  const links = rest.filter((a) => a.url);
  const commands = rest.filter((a) => !a.url);

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
          {/* The one case where the header states a problem the app cannot fix
              for the user: give them the fix rather than a sentence about it. */}
          {summary.command && (
            <>
              <MenuSeparator />
              <MenuItem
                icon="content_copy"
                onClick={run(() => void navigator.clipboard?.writeText(summary.command as string))}
              >
                {t('update:copyStaleRootCommand')}
              </MenuItem>
            </>
          )}
          <MenuSeparator />
          {settings && item(settings)}
          <MenuSeparator />
          {/* One row, not a header plus three checked items. Changing it does
              NOT close the menu: the whole point of an inline switcher is
              seeing the app change under it. */}
          <MenuChoiceRow
            label="Theme"
            options={APPEARANCE_OPTIONS}
            value={appearance}
            onChange={onAppearanceChange}
          />
          <MenuSeparator />
          {links.map(item)}
          {links.length > 0 && commands.length > 0 && <MenuSeparator />}
          {commands.map(item)}
        </Menu>
      )}
    </div>
  );
}
