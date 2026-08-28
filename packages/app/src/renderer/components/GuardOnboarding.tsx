import { useCallback, useEffect, useId, useRef, useState } from 'react';
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
 * One-time onboarding wizard for the trace-mcp guard.
 * Shown the first time the app launches without a recorded acknowledgement.
 *
 * Flow:
 *   detect  → cli-missing  (terminal — link to install instructions)
 *           → cli-stale    (terminal — prompt to upgrade)
 *           → install-prompt → installing → installed
 *                                         → skipped (user opted out)
 *
 * Nothing renders until detection resolves — the dialog is the first thing a
 * new user ever sees, so it must not flash an empty "Detecting…" panel over a
 * still-loading Workspace. When Claude Code isn't installed there is nothing
 * to offer, so we acknowledge and close without ever showing a dialog.
 *
 * Persistence: writes ~/.claude/.trace-mcp-onboarded once the user reaches
 * a terminal state. Renderer-side via electronAPI? — actually we keep it
 * in localStorage because it's a UI hint, not a security boundary.
 */
const ONBOARDING_KEY = 'trace-mcp.onboarded.v1';

interface GuardOnboardingProps {
  onClose: () => void;
}

export function GuardOnboarding({ onClose }: GuardOnboardingProps) {
  const [state, setState] = useState<OnboardingState>({ step: 'detect' });
  const titleId = useId();

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
      if (!cliCheck) {
        setState({ step: 'cli-missing' });
        return;
      }
      if (cliCheck.notInstalled) {
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
        // interrupt first launch with a dialog just to say "skipped".
        dismissAndPersist();
        return;
      }
      setState({
        step: 'install-prompt',
        cliVersion: cliCheck.current,
      });
    };
    detect();
    return () => {
      cancelled = true;
    };
  }, [dismissAndPersist]);

  // Dismissable while a dialog is actually on screen and idle — not during
  // detection (nothing is shown yet) and not mid-install (work in flight).
  const dismissable = state.step !== 'detect' && state.step !== 'installing';

  // Escape dismisses, same as the primary action. A modal you can't get out of
  // with the keyboard is a trap on the very first screen of the app.
  useEffect(() => {
    if (!dismissable) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismissAndPersist();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dismissable, dismissAndPersist]);

  const install = async () => {
    setState((s) => ({ ...s, step: 'installing' }));
    const result = await window.electronAPI?.guard.install();
    if (!result?.ok) {
      setState((s) => ({ ...s, step: 'install-prompt', error: result?.error ?? 'install failed' }));
      return;
    }
    setState((s) => ({ ...s, step: 'installed', scriptPath: result.scriptPath }));
  };

  if (state.step === 'detect') return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.4)' }}
      onClick={dismissable ? dismissAndPersist : undefined}
    >
      {/* stopPropagation below keeps clicks inside the panel from reaching the
          backdrop handler; Escape is handled globally above. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="rounded-lg shadow-2xl p-6 max-w-md w-full"
        style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id={titleId}
          className="text-base font-semibold mb-3"
          style={{ color: 'var(--text-primary)' }}
        >
          Set up trace-mcp guard
        </h2>

        {state.step === 'cli-missing' && (
          <div>
            <p className="text-sm mb-3" style={{ color: 'var(--text-secondary)' }}>
              The <code>trace-mcp</code> CLI isn't on your PATH. Install it first:
            </p>
            <pre
              className="text-xs px-2 py-1.5 rounded mb-3"
              style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
            >
              npm install -g trace-mcp
            </pre>
            <ActionRow onPrimary={dismissAndPersist} primaryLabel="Got it" />
          </div>
        )}

        {state.step === 'cli-stale' && (
          <div>
            <p className="text-sm mb-3" style={{ color: 'var(--text-secondary)' }}>
              Installed CLI is <code>{state.cliVersion}</code> — this app expects ≥{' '}
              <code>{state.requiredVersion}</code>. Upgrade:
            </p>
            <pre
              className="text-xs px-2 py-1.5 rounded mb-3"
              style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
            >
              npm install -g trace-mcp@latest
            </pre>
            <ActionRow onPrimary={dismissAndPersist} primaryLabel="Got it" />
          </div>
        )}

        {state.step === 'install-prompt' && (
          <div>
            <p className="text-sm mb-3" style={{ color: 'var(--text-secondary)' }}>
              Install the trace-mcp guard hook into Claude Code? This routes
              Read/Grep/Glob/Bash through trace-mcp instead of raw file
              reads — saves ~30–50% of tokens per session. New projects
              start in <strong>Coach</strong> mode (hints only, never
              blocks) and auto-promote to Strict after 7 days.
            </p>
            <p className="text-[11px] mb-4" style={{ color: 'var(--text-tertiary)' }}>
              We'll back up <code>~/.claude/settings.json</code> to{' '}
              <code>settings.json.bak</code> before editing.
            </p>
            {state.error && (
              <div className="text-xs mb-2" style={{ color: '#ff3b30' }}>
                {state.error}
              </div>
            )}
            <ActionRow
              onPrimary={install}
              primaryLabel="Install"
              onSecondary={() => {
                setState({ step: 'skipped' });
              }}
              secondaryLabel="Skip"
            />
          </div>
        )}

        {state.step === 'installing' && (
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Installing hook…
          </div>
        )}

        {state.step === 'installed' && (
          <div>
            <p className="text-sm mb-3" style={{ color: 'var(--text-secondary)' }}>
              Guard installed.
              {state.scriptPath && (
                <>
                  {' '}Hook at <code>{state.scriptPath}</code>.
                </>
              )}
            </p>
            <p className="text-[11px] mb-4" style={{ color: 'var(--text-tertiary)' }}>
              Restart Claude Code so it picks up the new hook configuration.
            </p>
            <ActionRow onPrimary={dismissAndPersist} primaryLabel="Done" />
          </div>
        )}

        {state.step === 'skipped' && (
          <div>
            <p className="text-sm mb-3" style={{ color: 'var(--text-secondary)' }}>
              Skipped. You can install the guard later from Settings.
            </p>
            <ActionRow onPrimary={dismissAndPersist} primaryLabel="Close" />
          </div>
        )}
      </div>
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
    <div className="flex gap-2 justify-end">
      {onSecondary && secondaryLabel && (
        <Button variant="chip" onClick={onSecondary}>
          {secondaryLabel}
        </Button>
      )}
      {/* autoFocus: the dialog must own the keyboard on mount, otherwise Tab
          and Enter act on the Workspace behind it. */}
      <Button autoFocus variant="primary" onClick={onPrimary}>
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
