import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Icon } from '../lattice/icons';
import { Button } from '../lattice/ui';

type Step = 'detect' | 'cli-missing' | 'cli-stale' | 'install-prompt' | 'installing' | 'installed' | 'skipped';

interface OnboardingState {
  step: Step;
  cliVersion?: string | null;
  requiredVersion?: string;
  scriptPath?: string;
  error?: string;
}

/**
 * One-time onboarding sheet for the trace-mcp guard.
 * Shown the first time the app launches without a recorded acknowledgement.
 *
 * Flow:
 *   detect  → cli-missing  (terminal — the install command, with a copy button)
 *           → cli-stale    (terminal — the upgrade command)
 *           → install-prompt → installing → installed
 *                                         → skipped (user opted out)
 *
 * Nothing renders until detection resolves — the sheet is the first thing a
 * new user ever sees, so it must not flash an empty "Detecting…" panel over a
 * still-loading Workspace. When Claude Code isn't installed there is nothing
 * to offer, so we acknowledge and close without ever showing a sheet.
 *
 * Presentation (TRA-295): a macOS sheet, not a centred web modal. It slides
 * out of the window's top edge, keeps square top corners because it is
 * attached to that edge, dims what is behind it, traps focus, and closes on
 * Escape and on a backdrop press. The command it asks the user to run is a
 * selectable monospace field with a copy button — `user-select: none` is set
 * globally on `body`, so before this the one thing the dialog existed to
 * communicate could not be copied.
 *
 * Persistence: localStorage, because it is a UI hint, not a security boundary.
 */
const ONBOARDING_KEY = 'trace-mcp.onboarded.v1';

interface GuardOnboardingProps {
  onClose: () => void;
}

export function GuardOnboarding({ onClose }: GuardOnboardingProps) {
  const [state, setState] = useState<OnboardingState>({ step: 'detect' });
  const titleId = useId();
  const bodyId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  // Ref so the detect effect can close without re-running when App re-renders
  // and hands us a fresh `onClose` identity.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const dismissAndPersist = useCallback(() => {
    try {
      localStorage.setItem(ONBOARDING_KEY, '1');
    } catch {
      /* private mode? — no-op */
    }
    onCloseRef.current();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const detect = async () => {
      const cliCheck = await window.electronAPI?.guard.checkCliVersion();
      if (cancelled) return;
      if (!cliCheck || cliCheck.notInstalled) {
        setState({ step: 'cli-missing' });
        return;
      }
      if (cliCheck.needsUpgrade) {
        setState({
          step: 'cli-stale',
          cliVersion: cliCheck.current,
          requiredVersion: cliCheck.required,
        });
        return;
      }
      const installStatus = await window.electronAPI?.guard.installStatus();
      if (cancelled) return;
      if (installStatus?.installed) {
        setState({
          step: 'installed',
          cliVersion: cliCheck.current,
          scriptPath: installStatus.scriptPath,
        });
        return;
      }
      if (!installStatus?.claudeDetected) {
        // Claude Code not installed — there is nothing to offer, so don't
        // interrupt first launch with a sheet just to say "skipped".
        dismissAndPersist();
        return;
      }
      setState({ step: 'install-prompt', cliVersion: cliCheck.current });
    };
    detect();
    return () => {
      cancelled = true;
    };
  }, [dismissAndPersist]);

  // Dismissable while a sheet is actually on screen and idle — not during
  // detection (nothing is shown yet) and not mid-install (work in flight).
  const dismissable = state.step !== 'detect' && state.step !== 'installing';
  const open = state.step !== 'detect';

  // Escape dismisses, and Tab cycles inside the sheet. A modal you can't get
  // out of with the keyboard, or that leaks Tab to the Workspace behind it, is
  // a trap on the very first screen of the app.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!dismissable) return;
        e.preventDefault();
        dismissAndPersist();
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = [
        ...panel.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ];
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!active || !panel.contains(active)) {
        e.preventDefault();
        first.focus();
        return;
      }
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, dismissable, dismissAndPersist]);

  const install = async () => {
    setState((s) => ({ ...s, step: 'installing' }));
    const result = await window.electronAPI?.guard.install();
    if (!result?.ok) {
      setState((s) => ({ ...s, step: 'install-prompt', error: result?.error ?? 'install failed' }));
      return;
    }
    setState((s) => ({ ...s, step: 'installed', scriptPath: result.scriptPath }));
  };

  if (!open) return null;

  const { title, body } = content(state, install, dismissAndPersist, () =>
    setState({ step: 'skipped' }),
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the scrim is a dismissal affordance, not a control — Escape and the sheet's own buttons are the keyboard paths, and the sheet traps focus above it.
    <div
      className="lx-sheet-scrim"
      onClick={dismissable ? dismissAndPersist : undefined}
    >
      {/* stopPropagation keeps presses inside the sheet from reaching the
          scrim's dismiss handler; Escape is handled globally above. */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="lx-sheet"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={titleId} className="lx-sheet-title">
          {title}
        </h2>
        <div id={bodyId} className="lx-sheet-body">
          {body}
        </div>
      </div>
    </div>
  );
}

/** Per-step title and body. Split out so the sheet chrome above stays one
    shape regardless of which of the six states is showing. */
function content(
  state: OnboardingState,
  install: () => void,
  dismiss: () => void,
  skip: () => void,
): { title: string; body: React.ReactNode } {
  switch (state.step) {
    case 'cli-missing':
      return {
        title: 'Install the trace-mcp CLI',
        body: (
          <>
            <p className="lx-sheet-text">
              The app talks to your projects through the <code>trace-mcp</code> command, and it
              isn't on your PATH yet. Run this in a terminal, then reopen the app.
            </p>
            <CommandField command="npm install -g trace-mcp" />
            <ActionRow onPrimary={dismiss} primaryLabel="Done" />
          </>
        ),
      };
    case 'cli-stale':
      return {
        title: 'Update the trace-mcp CLI',
        body: (
          <>
            <p className="lx-sheet-text">
              You have <code>{state.cliVersion}</code>; this app needs{' '}
              <code>{state.requiredVersion}</code> or newer. Run this in a terminal, then reopen
              the app.
            </p>
            <CommandField command="npm install -g trace-mcp@latest" />
            <ActionRow onPrimary={dismiss} primaryLabel="Done" />
          </>
        ),
      };
    case 'install-prompt':
      return {
        title: 'Set up the trace-mcp guard',
        body: (
          <>
            <p className="lx-sheet-text">
              The guard routes Claude Code's Read, Grep, Glob and Bash calls through trace-mcp
              instead of raw file reads, which saves roughly 30–50% of the tokens in a session.
              New projects start in Coach mode — hints only, never blocking — and move to Strict
              after seven days.
            </p>
            <p className="lx-sheet-note">
              <code>~/.claude/settings.json</code> is backed up to <code>settings.json.bak</code>{' '}
              before anything is written.
            </p>
            {state.error && (
              <p className="lx-sheet-error" role="alert">
                <Icon name="warning" size={14} />
                {state.error}
              </p>
            )}
            <ActionRow
              onPrimary={install}
              primaryLabel="Install guard"
              onSecondary={skip}
              secondaryLabel="Not now"
            />
          </>
        ),
      };
    case 'installing':
      return {
        title: 'Installing the guard',
        body: (
          <p className="lx-sheet-text" role="status">
            Writing the hook into Claude Code's settings…
          </p>
        ),
      };
    case 'installed':
      return {
        title: 'Guard installed',
        body: (
          <>
            <p className="lx-sheet-text">
              Restart Claude Code so it picks up the new hook configuration.
            </p>
            {state.scriptPath && <CommandField command={state.scriptPath} label="Hook script" />}
            <ActionRow onPrimary={dismiss} primaryLabel="Done" />
          </>
        ),
      };
    case 'skipped':
      return {
        title: 'Guard not installed',
        body: (
          <>
            <p className="lx-sheet-text">
              You can install it later from Settings, under AI / embeddings.
            </p>
            <ActionRow onPrimary={dismiss} primaryLabel="Close" />
          </>
        ),
      };
    default:
      return { title: '', body: null };
  }
}

/** A command the user is meant to run. Selectable (the global
    `user-select: none` on body is overridden here) and copyable in one click —
    a command you cannot copy is a screenshot, not an instruction. */
function CommandField({ command, label }: { command: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard denied — the text is selectable, so ⌘C still works */
    }
  };

  return (
    <div className="lx-sheet-command">
      <code>{command}</code>
      <Button
        variant="icon"
        size="small"
        icon={copied ? 'check' : 'content_copy'}
        onClick={copy}
        aria-label={copied ? 'Copied' : `Copy ${label ?? 'command'}`}
        title={copied ? 'Copied' : `Copy ${label ?? 'command'}`}
      />
    </div>
  );
}

interface ActionRowProps {
  onPrimary: () => void;
  primaryLabel: string;
  onSecondary?: () => void;
  secondaryLabel?: string;
}

function ActionRow({ onPrimary, primaryLabel, onSecondary, secondaryLabel }: ActionRowProps) {
  return (
    <div className="lx-sheet-actions">
      {onSecondary && secondaryLabel && (
        <Button size="large" onClick={onSecondary}>
          {secondaryLabel}
        </Button>
      )}
      {/* autoFocus: the sheet must own the keyboard on mount, otherwise Tab
          and Enter act on the Workspace behind it. */}
      <Button autoFocus size="large" variant="prominent" onClick={onPrimary}>
        {primaryLabel}
      </Button>
    </div>
  );
}

/** Helper for callers: was onboarding already shown to this user? */
export function isOnboardingDone(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_KEY) === '1';
  } catch {
    return false;
  }
}
