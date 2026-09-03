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
import {
  Menu,
  MenuChoiceRow,
  MenuItem,
  MenuPopUpRow,
  MenuSeparator,
  useMenuAnchor,
} from '../lattice/ui';
import { GLOBAL_ACTIONS, type GlobalAction } from '../../shared/global-actions.js';
import { appearanceOptions, type Appearance } from '../theme.js';
import { localeOptions, t, useLocale } from '../i18n/index.js';
import {
  describeDuplicateApps,
  describeStaleRoots,
  formatAgo,
  type DaemonUpdateState,
  type UpdateState,
} from '../update-check.js';
import { SidebarRow } from './SidebarRow';

export interface AppMenuProps {
  update: UpdateState;
  checking: boolean;
  daemonUpdate: DaemonUpdateState;
  daemonChecking: boolean;
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
  /** The duplicate install to reveal in Finder — offered as a menu item. */
  revealPath?: string;
}

/** The header's second line: what we know about this version right now.
 *  One button drives both checks (TRA-686), so this line has to be able to
 *  name either — or both — of app and daemon as the thing that is behind,
 *  not just report on the app bundle it used to be the only reader of. */
function updateSummary(
  update: UpdateState,
  checking: boolean,
  daemonUpdate: DaemonUpdateState,
  daemonChecking: boolean,
): Summary {
  if (checking || daemonChecking) return { text: t('update:headerChecking'), tone: 'is-busy' };
  // The app row's own error keeps first claim on the line — unchanged from
  // before the daemon row existed.
  if (update.error) return { text: update.error, tone: 'is-warn', title: update.error };
  const appBehind = update.available;
  const daemonBehind = daemonUpdate.available;
  if (appBehind && daemonBehind) {
    return { text: t('update:headerBothAvailable'), tone: 'is-info' };
  }
  if (appBehind) {
    return { text: t('update:headerAvailable', { version: update.latest }), tone: 'is-info' };
  }
  if (daemonBehind) {
    return {
      text: t('update:headerDaemonAvailable', { version: daemonUpdate.latest }),
      tone: 'is-info',
    };
  }
  /* This root is current, but the npm root the launcher shim points into is
     not, so every MCP client is on the old server (TRA-364). The main process
     only sends roots that are actually in use, so reaching here always means
     the user has something to fix. */
  if (update.staleRoots?.length) {
    const stale = describeStaleRoots(update.staleRoots);
    return { text: stale.label, tone: 'is-warn', title: stale.title, command: stale.command };
  }
  /* Below the stale root, above "up to date": a second installed bundle is a
     real divergence, but the copy in hand is still current, so it must not
     borrow the voice of a version that is actually behind (TRA-692). */
  if (update.duplicateApps?.length) {
    const dup = describeDuplicateApps(update.duplicateApps);
    return { text: dup.label, tone: 'is-warn', title: dup.title, revealPath: dup.revealPath };
  }
  if (daemonUpdate.error) {
    return { text: daemonUpdate.error, tone: 'is-warn', title: daemonUpdate.error };
  }
  return {
    text: t('update:headerUpToDate', { when: formatAgo(update.lastChecked) }),
    tone: 'is-ok',
  };
}

export function AppMenu({
  update,
  checking,
  daemonUpdate,
  daemonChecking,
  onCheckForUpdate,
  appearance,
  onAppearanceChange,
  onSettings,
}: AppMenuProps) {
  const menu = useMenuAnchor();
  // Unnamespaced: the shared action list carries fully-qualified keys, because
  // the native menu resolves the same ones in the main process.
  const { t } = useTranslation();
  /* Not a prop, unlike `appearance`: the language has no second owner. `theme`
     is passed down because App.tsx also mirrors it to the main process for the
     sidebar's NSVisualEffectView; `setLocale` already does its own mirroring
     and its own cross-window sync, so a prop would only be plumbing. */
  const { locale, setLocale } = useLocale();
  const open = menu.at !== null;
  const summary = updateSummary(update, checking, daemonUpdate, daemonChecking);

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
      disabled={action.id === 'check-for-update' && (checking || daemonChecking)}
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
        label="trace-mcp" // i18n-exempt — the product's name, Latin in every language
        onClick={toggle}
        title={t('shell:appMenu')}
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
            <div className="name">
              {t('update:headerVersion', { version: update.current ?? '—' })}
            </div>
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
          {/* Reveal, not open: opening the other bundle launches the very copy
              the user came here to decide about. Finder is where both remedies
              start — drag it to the Trash, or double-click it to let it
              update itself. */}
          {summary.revealPath && (
            <>
              <MenuSeparator />
              <MenuItem
                icon="folder"
                onClick={run(
                  () => void window.electronAPI?.showInFolder?.(summary.revealPath as string),
                )}
              >
                {t('update:revealDuplicateApp')}
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
            label={t('shell:theme')}
            options={appearanceOptions()}
            value={appearance}
            onChange={onAppearanceChange}
          />
          {/* Same group as Theme, no separator between them: both are app
              preferences you may want to try, as opposed to the commands below.
              A pop-up rather than Theme's pill: ten languages named in their own
              scripts are words, not glyphs, and DESIGN.md puts anything past
              four values on this side of the line (TRA-450). */}
          <MenuPopUpRow
            label={t('shell:language')}
            options={localeOptions()}
            value={locale}
            onChange={setLocale}
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
