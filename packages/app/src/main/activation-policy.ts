/**
 * Whether this process is allowed to be a normal foreground app (TRA-407).
 *
 * A regular macOS app activates on launch, and macOS follows that activation to
 * the Space the app's window lives on — so an agent run that starts the dev
 * build drags whoever is at the keyboard out of their full-screen app. Every
 * unpackaged build is therefore `accessory` by default: no Dock icon, no ⌘-Tab,
 * no activation. TRA-403 made that true only under
 * `TRACE_MCP_WINDOW_MODE=hidden`, i.e. only when somebody remembered the flag.
 *
 * A shipped build is a real app and stays `regular` unless the run announces
 * itself — `TRACE_MCP_WINDOW_MODE=hidden`, or `TRACE_MCP_AGENT_RUN=1` from an
 * agent launching the packaged app some other way (TRA-403).
 *
 *   | build      | TRACE_MCP_WINDOW_MODE | policy    |
 *   |------------|-----------------------|-----------|
 *   | packaged   | unset                 | regular   |
 *   | packaged   | hidden                | accessory |
 *   | unpackaged | unset                 | accessory |
 *   | unpackaged | visible               | regular   |
 *   | unpackaged | hidden                | accessory |
 */
export type ActivationPolicy = 'regular' | 'accessory';

export function activationPolicyFor(
  windowMode: string | undefined,
  packaged: boolean,
  agentRun = false,
): ActivationPolicy {
  if (windowMode === 'hidden' || agentRun) return 'accessory';
  if (packaged) return 'regular';
  return windowMode === 'visible' ? 'regular' : 'accessory';
}
