import { useEffect, useState } from 'react';

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
        // Claude Code not installed; nothing to do for now.
        setState({ step: 'skipped' });
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
  }, []);

  const install = async () => {
    setState((s) => ({ ...s, step: 'installing' }));
    const result = await window.electronAPI?.guard.install();
    if (!result?.ok) {
      setState((s) => ({ ...s, step: 'install-prompt', error: result?.error ?? 'install failed' }));
      return;
    }
    setState((s) => ({ ...s, step: 'installed', scriptPath: result.scriptPath }));
  };

  const dismissAndPersist = () => {
    try {
      localStorage.setItem(ONBOARDING_KEY, '1');
    } catch {
      /* private mode? — no-op */
    }
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.4)' }}
    >
      <div
        className="rounded-lg shadow-2xl p-6 max-w-md w-full"
        style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)' }}
      >
        <h2 className="text-base font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>
          Set up trace-mcp guard
        </h2>

        {state.step === 'detect' && (
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Detecting installation…
          </div>
        )}

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
        <button
          type="button"
          onClick={onSecondary}
          className="px-3 py-1.5 rounded-md text-sm font-medium"
          style={{
            background: 'transparent',
            color: 'var(--text-secondary)',
            border: '1px solid var(--border)',
          }}
        >
          {secondaryLabel}
        </button>
      )}
      <button
        type="button"
        onClick={onPrimary}
        className="px-3 py-1.5 rounded-md text-sm font-medium"
        style={{ background: 'var(--accent)', color: 'var(--bg-primary)' }}
      >
        {primaryLabel}
      </button>
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
