/**
 * Bind-host guard for the daemon's HTTP listener (TRA-301).
 *
 * The daemon has no authentication: every /api route and the /mcp endpoint
 * trust the caller completely. On loopback that is fine — anything that can
 * reach 127.0.0.1:3741 already runs as this user and can read the same files
 * directly, so `?project=` / `X-Trace-Project` naming an arbitrary directory
 * grants an attacker nothing new.
 *
 * Binding a non-loopback address deletes that boundary: the whole daemon,
 * arbitrary-path indexing included, becomes reachable by anyone on the
 * network. That must be a deliberate act, not the consequence of a stray
 * `--host 0.0.0.0`, so it requires an explicit `--allow-remote` opt-in.
 */

/** Loopback literals plus the 127.0.0.0/8 range. */
export function isLoopbackHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h === '') return true;
  const v4 = h.startsWith('::ffff:') ? h.slice(7) : h;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/**
 * @returns an operator-facing error message when this bind must be refused,
 * or `null` when it is allowed.
 */
export function checkBindHost(host: string, allowRemote: boolean): string | null {
  if (isLoopbackHost(host) || allowRemote) return null;
  return (
    `Refusing to bind --host ${host}: the trace-mcp daemon is unauthenticated. ` +
    'Anyone able to reach a non-loopback address could index and read arbitrary ' +
    'directories on this machine. Pass --allow-remote if that is what you intend, ' +
    'and put your own authentication in front of the port.'
  );
}
