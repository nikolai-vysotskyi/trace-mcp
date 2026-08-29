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

export type UpdateState = {
  available: boolean;
  current?: string;
  latest?: string;
  lastChecked?: number;
  error?: string;
  stuck?: boolean;
  staleRoots?: { root: string; version: string }[];
};

/**
 * `npm install -g` only ever writes into the global root its own npm owns. On a
 * machine with several (nvm + Herd + a bundled runtime) the rest keep an old
 * version, and every other signal here still reads "Up to date" — so a client
 * wired to a stale root runs old code with nothing saying so (TRA-364). We
 * cannot safely write into a root the user never pointed us at, so we say it
 * out loud instead: the app menu's status line goes to the warning treatment
 * and its tooltip names each stale root and the command that fixes it.
 */
export function describeStaleRoots(staleRoots: { root: string; version: string }[]): {
  label: string;
  title: string;
} {
  const label =
    staleRoots.length === 1
      ? `Another npm install is on v${staleRoots[0].version}`
      : `${staleRoots.length} other npm installs are out of date`;
  const lines = staleRoots.map((r) => `v${r.version} — ${r.root}/trace-mcp`);
  return {
    label,
    title: `${label}. This app updated the root it resolves to; these were not touched:\n${lines.join('\n')}\n\nFix each with its own npm: <root>/../../bin/npm install -g trace-mcp@latest`,
  };
}

export function formatAgo(ts?: number, now: number = Date.now()): string {
  if (!ts) return 'never';
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export interface UpdateCheck {
  state: UpdateState;
  /** Set once a new version is on disk and only a restart is left. */
  pendingVersion: string | null;
  checking: boolean;
  updating: boolean;
  check: () => void;
  apply: () => void;
  restart: () => void;
}

export function useUpdateCheck(): UpdateCheck {
  const [state, setState] = useState<UpdateState>({ available: false });
  const [updating, setUpdating] = useState(false);
  const [checking, setChecking] = useState(false);
  const [pendingVersion, setPendingVersion] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const check = useCallback(async () => {
    const api = window.electronAPI;
    if (!api?.checkForUpdate) return;
    setChecking(true);
    try {
      const [upd, pend] = await Promise.all([
        api.checkForUpdate(),
        api.checkPendingUpdate
          ? api.checkPendingUpdate()
          : Promise.resolve<{ pending: boolean; version?: string }>({ pending: false }),
      ]);
      if (cancelledRef.current) return;
      if (upd) setState(upd);
      if (pend?.pending) setPendingVersion(pend.version || (upd?.latest ?? null));
      else setPendingVersion(null);
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
    setState((s) => ({ ...s, error: undefined }));
    try {
      const result = await api.applyUpdate();
      if (result?.ok && api.checkPendingUpdate) {
        const pend = await api.checkPendingUpdate();
        if (pend?.pending) setPendingVersion(pend.version || stateRef.current.latest || null);
      }
      if (!result?.ok) {
        setState((s) => ({ ...s, error: result?.error || 'update failed' }));
      } else if (result.outcome === 'npm-only') {
        // The npm package moved but the .app bundle stayed put. Re-run the
        // availability check now — the main process just wrote the sticky
        // marker, so this call returns { available: false, stuck: true } and
        // the card switches to "needs a manual install" instead of looping the
        // user through the same prompt on the next poll.
        void checkRef.current();
      }
    } finally {
      setUpdating(false);
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
    check: useCallback(() => void checkRef.current(), []),
    apply: useCallback(() => void apply(), [apply]),
    restart,
  };
}
