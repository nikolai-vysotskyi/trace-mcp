/* GuardSection.tsx — the per-project guard readout on Project Overview (TRA-334).

   The guard was fully built in main/guard-control.ts and completely invisible:
   of its eight IPC channels the renderer called three, all from the onboarding
   sheet. The app walked you through installing the guard and then never
   mentioned it again — no health, no mode, no bypass, and no way to pause it
   short of hand-editing a sentinel file in the OS temp dir.

   `GuardBadge` used to be that surface and died with `ProjectRow` in the
   workspace rebuild. This is not a port of it. What that one got wrong and this
   one does not: status was five hues on a 6px dot with only the *mode* written
   out, so "down" and "ok" differed by colour alone; mode selection was three
   bordered buttons in a hand-rolled radiogroup inside a hand-rolled popover;
   reading text ran at 10px; five raw single-appearance hex; auto-promotion
   arrived as a toast. Here every tone is a `Badge` (tone + glyph + word), mode
   is a `SegmentedControl`, and promotion is state shown next to the mode.

   `guard.initialize` was called on the old badge's mount, and nothing has
   called it since — which is why this runs it before the first status read.
   Without it a project never gets its `guard-mode` file, and `getGuardMode`
   falls back to `strict`, so the 7-day coach grace period silently never
   happened. */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { t } from '../i18n';
import { formatDate, relativeTime } from '../i18n/format';
import {
  Badge,
  Button,
  Card,
  ListRow,
  Section,
  SectionError,
  SegmentedControl,
  SkeletonRows,
  type Tone,
} from '../lattice/ui';

type GuardMode = 'strict' | 'coach' | 'off';
type GuardHealth = 'ok' | 'stalled' | 'down' | 'unknown';
type GuardReason = 'heartbeat_stale' | 'channel_quiet' | 'never_started';

interface GuardState {
  health: GuardHealth;
  mode: GuardMode;
  bypassUntil?: number;
  reason?: GuardReason;
  reasonSeconds?: number;
  coachExpiresAt?: number;
  autoPromoted?: boolean;
}

type Load = 'loading' | 'ready' | 'failed';

/** Health is a tone AND a glyph AND a word — never the tone alone.
    `label` is a catalogue key, resolved where the badge renders. */
const HEALTH: Record<GuardHealth, { tone: Tone; icon: string; label: string }> = {
  ok: { tone: 'green', icon: 'check', label: 'guard:health.ok' },
  stalled: { tone: 'orange', icon: 'schedule', label: 'guard:health.stalled' },
  down: { tone: 'red', icon: 'warning', label: 'guard:health.down' },
  unknown: { tone: 'neutral', icon: 'remove', label: 'guard:health.unknown' },
};

const MODE_OPTIONS: ReadonlyArray<{ value: GuardMode; label: string; title: string }> = [
  { value: 'strict', label: 'guard:mode.strict', title: 'guard:mode.strictHelp' },
  { value: 'coach', label: 'guard:mode.coach', title: 'guard:mode.coachHelp' },
  { value: 'off', label: 'guard:mode.off', title: 'guard:mode.offHelp' },
];

const POLL_MS = 15_000;
const BYPASS_MINUTES = 10;

/** The one line under the card: why enforcement is not running, and the one
    thing that changes it. It never restates the badge — "Not running" is the
    condition, this is the cause and the next step (TRA-490). Cases with no
    honest advice render nothing rather than a sentence that ends nowhere. */
export function reasonLine(state: GuardState, now: number): string | null {
  if (!state.reason) return null;
  if (state.reason === 'never_started') return t('guard:reason.neverStarted');
  const ago =
    state.reasonSeconds === undefined
      ? null
      : relativeTime(now - state.reasonSeconds * 1000, now);
  if (!ago) return null;
  return state.reason === 'heartbeat_stale'
    ? t('guard:reason.heartbeatStale', { ago })
    : t('guard:reason.channelQuiet', { ago });
}

/** "in 9 minutes" / "in 6 days". Future-tense sibling of `relativeTime`, which
    is past-only by design — hence its own counted keys rather than a call into
    renderer/i18n/format.ts. */
export function untilLabel(epochSec: number, now: number): string {
  const s = Math.max(0, Math.round(epochSec - now / 1000)); // now is ms, epochSec is s
  if (s < 60) return t('guard:until.underMinute');
  const m = Math.round(s / 60);
  if (m < 60) return t('guard:until.minutes', { count: m });
  const h = Math.round(m / 60);
  if (h < 24) return t('guard:until.hours', { count: h });
  return t('guard:until.days', { count: Math.round(h / 24) });
}

/** "in 6 days · Sep 4" — when it happens, and which day that is. */
export function promotionLabel(epochSec: number, now: number): string {
  const abs = formatDate(epochSec * 1000, { month: 'short', day: 'numeric' });
  return `${untilLabel(epochSec, now)} · ${abs}`;
}

export function GuardSection({ root }: { root: string }) {
  /* Subscribes the section to language changes; the strings themselves resolve
     through the module-level `t`, which module-scope helpers share. */
  useTranslation('guard');
  const [state, setState] = useState<GuardState | null>(null);
  const [load, setLoad] = useState<Load>('loading');
  const [busy, setBusy] = useState(false);
  const guard = window.electronAPI?.guard;

  const refresh = useCallback(async () => {
    if (!guard) return;
    try {
      const next = await guard.status(root);
      setState(next);
      setLoad('ready');
    } catch {
      setLoad((prev) => (prev === 'ready' ? prev : 'failed'));
    }
  }, [guard, root]);

  useEffect(() => {
    if (!guard) return;
    let cancelled = false;
    setLoad('loading');
    setState(null);
    (async () => {
      /* Initialize first: on a project that has never been initialized this is
         what writes `coach` + the install date, and the status read one line
         below is what would otherwise report a `strict` that nobody chose. */
      try {
        await guard.initialize(root);
      } catch {
        /* An un-initializable project still has a readable status. */
      }
      if (!cancelled) await refresh();
    })();
    const timer = setInterval(refresh, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [guard, root, refresh]);

  /* No bridge means no guard to report on — and inventing a reassuring row for
     a channel we cannot reach would be worse than saying nothing. */
  if (!guard) return null;

  const now = Date.now();
  const bypassUntil = state?.bypassUntil ?? 0;
  const bypassActive = bypassUntil * 1000 > now;

  const setMode = async (mode: GuardMode) => {
    setBusy(true);
    /* Optimistic: the segment moves on click, and the poll reconciles. */
    setState((prev) => (prev ? { ...prev, mode, autoPromoted: false } : prev));
    try {
      await guard.setMode(root, mode);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const setBypass = async (minutes: number) => {
    setBusy(true);
    try {
      await guard.setBypass(root, minutes);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const health = HEALTH[state?.health ?? 'unknown'];

  return (
    <Section title={t('guard:title')}>
      <Card>
        {load === 'loading' && !state ? (
          <SkeletonRows rows={3} />
        ) : load === 'failed' && !state ? (
          <SectionError what={t('guard:statusErrorWhat')} onRetry={refresh} />
        ) : state ? (
          <>
            <ListRow
              label={t('guard:row.status')}
              value={
                <Badge tone={health.tone} icon={health.icon}>
                  {t(health.label)}
                </Badge>
              }
            />
            <ListRow
              label={t('guard:row.mode')}
              value={
                /* Regular (24px), not small: measured on the running renderer
                   a small segment is a 16px paint in a 20px hit box, and the
                   32px row has the height for the 24px tier. */
                <SegmentedControl
                  aria-label={t('guard:mode.aria')}
                  options={MODE_OPTIONS.map((o) => ({
                    ...o,
                    label: t(o.label),
                    title: t(o.title),
                    disabled: busy,
                  }))}
                  value={state.mode}
                  onChange={(m) => setMode(m)}
                />
              }
            />
            {state.mode === 'coach' && state.coachExpiresAt ? (
              <ListRow
                label={t('guard:row.promotion')}
                value={promotionLabel(state.coachExpiresAt, now)}
              />
            ) : null}
            {state.autoPromoted ? (
              /* State, not an event: it belongs next to the mode it changed,
                 not in a toast that is gone before it is read. */
              <ListRow label={t('guard:row.promoted')} value={t('guard:row.promotedValue')} />
            ) : null}
            <ListRow
              last
              /* "Enforcement", not "Temporary pause": the row already carries a
                 Pause button, and label + button both saying "pause" wrapped to
                 two lines at the 640px window minimum for no added meaning. */
              label={t('guard:row.enforcement')}
              value={
                bypassActive ? (
                  <span className="inline-flex items-center gap-2">
                    <span>{t('guard:bypass.resumes', { when: untilLabel(bypassUntil, now) })}</span>
                    <Button icon="play_arrow" disabled={busy} onClick={() => setBypass(0)}>
                      {t('guard:bypass.resumeNow')}
                    </Button>
                  </span>
                ) : (
                  <Button
                    icon="pause"
                    disabled={busy || state.mode === 'off'}
                    onClick={() => setBypass(BYPASS_MINUTES)}
                  >
                    {t('guard:bypass.pause', { count: BYPASS_MINUTES })}
                  </Button>
                )
              }
            />
          </>
        ) : null}
      </Card>
      {state && state.health !== 'ok' && reasonLine(state, now) ? (
        <p className="text-[11px] leading-[13px] px-1" style={{ color: 'var(--label-secondary)' }}>
          {reasonLine(state, now)}
        </p>
      ) : null}
    </Section>
  );
}
