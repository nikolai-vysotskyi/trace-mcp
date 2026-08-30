/* update-check.ts — the app's one owner of update state (TRA-363).

   It used to live inside the sidebar's UpdateBanner, which was fine while the
   banner was the only thing that showed it. It is not: the sidebar's app menu
   reports "Up to date · v3.1.1" in its header and offers "Check for updates…",
   and a second poller would be a second answer to the same question.

   So App calls this once and hands the result to both. The main process does
   the actual work — it checks the npm registry (no rate limit) with GitHub
   Releases as a fallback; this is state plus a 10-minute cadence.

   Three states worth distinguishing: up to date (with when we last looked),
   an update available, and an update downloaded but pending a restart. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from './i18n/index.js';
import { relativeTime } from './i18n/format.js';

export type UpdateState = {
  available: boolean;
  current?: string;
  latest?: string;
  lastChecked?: number;
  error?: string;
  staleRoots?: { root: string; version: string }[];
};

/**
 * `npm install -g` only ever writes into the global root its own npm owns. On a
 * machine with several (nvm + Herd + a bundled runtime) the rest keep an old
 * version, and every other signal here still reads "Up to date" — so a client
 * wired to a stale root runs old code with nothing saying so (TRA-364).
 *
 * The main process now only sends the stale root the launcher shim points into,
 * because that is the only one the user pays for (TRA-377). That sharper
 * condition is what makes a line worth writing: it can name the consequence
 * ("your editors are on the old server") instead of a filesystem fact, and it
 * can name the one command that ends it.
 */
export function describeStaleRoots(staleRoots: { root: string; version: string }[]): {
  label: string;
  title: string;
  /** The exact command that updates that install — offered as a copyable item. */
  command: string;
} {
  /* No plural key any more: the payload is one root by construction, so there
     is no count for a catalogue to draw a line under (TRA-379 wrote the plural
     forms against the old, wider signal). */
  const stale = staleRoots[0];
  const pkgDir = `${stale.root}/trace-mcp`;
  // Its own npm, not whichever one is first on PATH: `npm install -g` writes
  // into the root its own binary owns, so any other npm would miss this one.
  const command = `${stale.root}/../../bin/npm install -g trace-mcp@latest`;
  return {
    label: t('update:staleRoots', { version: stale.version }),
    title: t('update:staleRootsTitle', { pkgDir, version: stale.version, command }),
    command,
  };
}

export function formatAgo(ts?: number, now: number = Date.now()): string {
  if (!ts) return t('common:never');
  return relativeTime(ts, now, 'short');
}

export interface UpdateCheck {
  state: UpdateState;
  /** Set once a new version is on disk and only a restart is left. */
  pendingVersion: string | null;
  checking: boolean;
  updating: boolean;
  /** 0-100 while the update is downloading, null when nothing is in flight. */
  progress: number | null;
  check: () => void;
  apply: () => void;
  restart: () => void;
}

export function useUpdateCheck(): UpdateCheck {
  const [state, setState] = useState<UpdateState>({ available: false });
  const [updating, setUpdating] = useState(false);
  const [checking, setChecking] = useState(false);
  const [pendingVersion, setPendingVersion] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const cancelledRef = useRef(false);

  /* electron-updater reports bytes as they land. Subscribed for the window's
     lifetime rather than only while `updating` is true: a download started from
     one window's Update button has to move the bar in every window showing the
     card, and only this event knows it is still going. */
  useEffect(() => {
    return window.electronAPI?.onUpdateProgress?.((p) => {
      setProgress(Math.max(0, Math.min(100, p.percent)));
    });
  }, []);

  const check = useCallback(async () => {
    const api = window.electronAPI;
    if (!api?.checkForUpdate) return;
    setChecking(true);
    try {
      const [upd, pend] = await Promise.all([
        api.checkForUpdate(),
        api.checkPendingUpdate
          ? api.checkPendingUpdate()
          : Promise.resolve<{ pending: boolean; version?: string; percent?: number }>({
              pending: false,
            }),
      ]);
      if (cancelledRef.current) return;
      if (upd) setState(upd);
      if (pend?.pending) setPendingVersion(pend.version || (upd?.latest ?? null));
      else setPendingVersion(null);
      /* A download already in flight when this window opened: the main process
         carries the percentage, so a second window joins the bar mid-way
         instead of showing 0 until the next event. */
      if (pend?.percent !== undefined) setProgress(pend.percent);
    } catch (err) {
      if (!cancelledRef.current) setState((s) => ({ ...s, error: (err as Error).message }));
    } finally {
      if (!cancelledRef.current) setChecking(false);
    }
  }, []);

  const checkRef = useRef(check);
  checkRef.current = check;
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    cancelledRef.current = false;
    void checkRef.current();
    const poll = setInterval(() => void checkRef.current(), 600_000);
    return () => {
      cancelledRef.current = true;
      clearInterval(poll);
    };
  }, []);

  const apply = useCallback(async () => {
    const api = window.electronAPI;
    if (!api) return;
    setUpdating(true);
    setProgress(0);
    setState((s) => ({ ...s, error: undefined }));
    try {
      const result = await api.applyUpdate();
      if (result?.ok && api.checkPendingUpdate) {
        const pend = await api.checkPendingUpdate();
        if (pend?.pending) setPendingVersion(pend.version || stateRef.current.latest || null);
      }
      if (!result?.ok) {
        setState((s) => ({ ...s, error: result?.error || 'update failed' }));
      }
    } finally {
      setUpdating(false);
      // Whether it landed or failed, nothing is in flight any more — a bar left
      // at 87% after a failed download is the shape of a wedged state.
      setProgress(null);
    }
  }, []);

  const restart = useCallback(() => {
    void window.electronAPI?.restartApp();
  }, []);

  return {
    state,
    pendingVersion,
    checking,
    updating,
    progress,
    check: useCallback(() => void checkRef.current(), []),
    apply: useCallback(() => void apply(), [apply]),
    restart,
  };
}
