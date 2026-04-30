import { useEffect, useRef, useState } from 'react';

type GuardMode = 'strict' | 'coach' | 'off';
type GuardHealth = 'ok' | 'stalled' | 'down' | 'unknown';

interface GuardStatusSnapshot {
  health: GuardHealth;
  mode: GuardMode;
  toolCallsTotal?: number;
  toolCallsFailed?: number;
  quietSeconds?: number;
  bypassUntil?: number;
  reason?: string;
  initializedAt?: number;
  coachExpiresAt?: number;
  autoPromoted?: boolean;
}

interface GuardBadgeProps {
  /** Absolute project root path. */
  root: string;
  /** Optional: emitted when the user changes the mode (parent may want to refresh). */
  onModeChange?: (mode: GuardMode) => void;
}

const POLL_INTERVAL_MS = 5_000;

/**
 * Small inline control on each project card showing trace-mcp guard health
 * + a strict/coach/off segmented switch. Polls the main process every 5s
 * (matching the server's status flush cadence).
 */
export function GuardBadge({ root, onModeChange }: GuardBadgeProps) {
  const [snapshot, setSnapshot] = useState<GuardStatusSnapshot | null>(null);
  const [pending, setPending] = useState<GuardMode | null>(null);
  const [open, setOpen] = useState(false);
  const [promotionToast, setPromotionToast] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Initialize guard for this project on first mount (default = coach +
    // 7-day auto-promote). Idempotent on the main side, so safe to call
    // every mount.
    void window.electronAPI?.guard.initialize(root);

    const poll = async () => {
      try {
        const s = await window.electronAPI?.guard.status(root);
        if (cancelled || !s) return;
        setSnapshot(s);
        if (s.autoPromoted) {
          const calls = s.toolCallsTotal ?? 0;
          setPromotionToast(
            calls > 0
              ? `Coach mode finished — switched to Strict (${calls} tool calls so far)`
              : 'Coach mode finished — switched to Strict',
          );
          window.setTimeout(() => setPromotionToast(null), 8000);
        }
      } catch {
        /* ignore — main process may be busy */
      }
    };
    poll();
    const id = window.setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [root]);

  useEffect(() => {
    if (!open) return;
    const handler = (ev: MouseEvent) => {
      if (!popoverRef.current?.contains(ev.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const setMode = async (mode: GuardMode) => {
    if (!snapshot || mode === snapshot.mode) return;
    setPending(mode);
    try {
      const res = await window.electronAPI?.guard.setMode(root, mode);
      if (res?.ok) {
        setSnapshot({ ...snapshot, mode });
        onModeChange?.(mode);
      }
    } finally {
      setPending(null);
    }
  };

  if (!snapshot) {
    return <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>guard…</span>;
  }

  const dotColor = badgeColor(snapshot);
  const label = modeLabel(snapshot.mode);

  return (
    <div className="relative inline-flex items-center" ref={popoverRef}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium transition-colors hover:bg-[var(--bg-active)]"
        style={{ color: 'var(--text-secondary)' }}
        title={tooltipFor(snapshot)}
      >
        <span
          aria-hidden="true"
          className="w-1.5 h-1.5 rounded-full"
          style={{ background: dotColor }}
        />
        <span>{label}</span>
      </button>
      {promotionToast && (
        <div
          className="absolute z-20 right-0 top-full mt-1 px-2 py-1.5 rounded-md text-[10px] shadow-lg whitespace-nowrap"
          style={{
            background: 'var(--accent)',
            color: 'var(--bg-primary)',
          }}
          role="status"
        >
          {promotionToast}
        </div>
      )}

      {open && (
        <div
          className="absolute z-10 right-0 top-full mt-1 p-1.5 rounded-md shadow-lg"
          style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            minWidth: 180,
          }}
        >
          <div
            className="text-[10px] mb-1.5 px-1"
            style={{ color: 'var(--text-tertiary)' }}
          >
            {tooltipFor(snapshot)}
          </div>
          <div className="flex gap-1" role="radiogroup" aria-label="trace-mcp guard mode">
            {(['strict', 'coach', 'off'] as GuardMode[]).map((m) => {
              const isActive = snapshot.mode === m;
              const isPending = pending === m;
              return (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={isActive}
                  disabled={isPending}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMode(m);
                  }}
                  className="flex-1 px-2 py-1 rounded text-[11px] font-medium transition-colors"
                  style={{
                    background: isActive ? 'var(--accent)' : 'transparent',
                    color: isActive ? 'var(--bg-primary)' : 'var(--text-secondary)',
                    border: `1px solid ${isActive ? 'var(--accent)' : 'var(--border)'}`,
                    opacity: isPending ? 0.6 : 1,
                  }}
                >
                  {modeLabel(m)}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function badgeColor(s: GuardStatusSnapshot): string {
  if (s.bypassUntil && s.bypassUntil > 0) return '#ff9500';
  if (s.mode === 'off') return '#8e8e93';
  if (s.health === 'down') return '#ff3b30';
  if (s.health === 'stalled') return '#ff9500';
  if (s.health === 'ok') {
    if (s.mode === 'coach') return '#0a84ff';
    return '#30d158';
  }
  return '#8e8e93';
}

function modeLabel(m: GuardMode): string {
  if (m === 'strict') return 'Strict';
  if (m === 'coach') return 'Coach';
  return 'Off';
}

function tooltipFor(s: GuardStatusSnapshot): string {
  if (s.bypassUntil && s.bypassUntil > 0) {
    const remaining = Math.max(0, s.bypassUntil - Math.floor(Date.now() / 1000));
    return `Bypassed for ${Math.ceil(remaining / 60)}m`;
  }
  if (s.health === 'down') return s.reason ?? 'trace-mcp not running';
  if (s.health === 'stalled') return s.reason ?? 'MCP channel stalled';
  if (s.health === 'ok') {
    if (s.mode === 'coach') {
      if (s.coachExpiresAt) {
        const days = Math.max(
          0,
          Math.ceil((s.coachExpiresAt - Math.floor(Date.now() / 1000)) / 86_400),
        );
        return `Coach: hints only — promotes to Strict in ${days}d`;
      }
      return 'Coach: hints only, never blocks';
    }
    if (s.mode === 'off') return 'Disabled';
    if (typeof s.toolCallsTotal === 'number') {
      return `Strict — ${s.toolCallsTotal} tool calls`;
    }
    return 'Strict';
  }
  return 'Unknown';
}
