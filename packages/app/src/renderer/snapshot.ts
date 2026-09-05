/**
 * Last-known-good values, kept across launches (TRA-397, generalised in TRA-934).
 *
 * The daemon can take seconds to answer while it indexes — measured on this
 * machine, every renderer read of `127.0.0.1:3741` blocked for 7.80 s at once
 * while `curl` against the same socket blocked for 7.799 s, so it is the daemon
 * holding, not the app. A screen with no snapshot spends that whole window on a
 * skeleton for numbers that were on disk the entire time.
 *
 * The contract: open on the snapshot, revalidate behind it, and say on screen
 * that the numbers are the last indexed ones until the fresh read lands.
 */

/** Read a snapshot, or `null` when there is none / it is unusable. */
export function loadSnapshot<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    // Corrupted JSON, or a sandboxed renderer with no storage — start cold.
    return null;
  }
}

export function saveSnapshot(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or sandbox. A missing snapshot costs one screen of placeholders,
    // so there is nothing worth reporting to the user here.
  }
}
