/* TRA-356 — the sentence the Graph Explorer failure state shows.

   It is persistent now (TRA-349), so it has to read like something a person
   wrote. `fetch` rejects with a bare "Failed to fetch" whether the daemon is
   down, still booting, or refusing the connection — that names no cause and no
   next step. Everything the daemon itself sends is already specific
   ("Project not found: …", "Server error (500)") and passes through untouched. */

/** Browser wording for "the request never reached a server", across engines. */
const TRANSPORT_FAILURE = /failed to fetch|networkerror|load failed|network request failed/i;

export function userFacingError(err: Error | null | undefined): string {
  const msg = err?.message?.trim() ?? '';
  if (!msg || TRANSPORT_FAILURE.test(msg)) return "Can't reach the trace-mcp daemon.";
  return msg;
}
