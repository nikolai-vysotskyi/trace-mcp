/**
 * Project resolution for the daemon's HTTP `/mcp` endpoint.
 *
 * Stdio-proxy clients append `?project=<absolute-path>` to the URL — those
 * are routed unambiguously. Some MCP clients (Claude Code, Cursor, IDE
 * HTTP-MCP integrations) cannot append that query string, however, and
 * before this module they would hit the multi-project guard and receive a
 * 400. The recovery chain implemented here keeps the original "no silent
 * fall back to listProjects()[0]" guarantee while restoring connectivity
 * for those clients.
 *
 * Order of precedence:
 *   1. Explicit `?project=` query param.
 *   2. `X-Trace-Project` HTTP header.
 *   3. `params._meta["traceMcp/projectRoot"]` in any JSON-RPC body.
 *   4. MCP initialize body — match `params.clientInfo.name` against the
 *      daemon's active client tracking table; if exactly one tracked
 *      client carries that name and its project is still registered, use
 *      it.
 *   5. If exactly one project is registered, use it.
 *   6. If zero projects are registered, return "no-projects".
 *   7. Otherwise return "ambiguous" — the caller renders a 400.
 *
 * An explicit hint (1-3) that names a dangerous root (filesystem root, home, a
 * system directory) is IGNORED rather than honoured: clients spawned with cwd=/
 * (Claude Cowork/Code sessions) otherwise pinned the session to "/" and the
 * whole MCP connection failed to start with "-32002 Refusing to index /"
 * (TRA-286). Falling through to the tracked-client / single-project steps
 * serves the real project instead.
 */

import { isDangerousProjectRoot } from '../dangerous-root.js';

export interface RegisteredProjectLike {
  root: string;
}

export interface TrackedClientLike {
  name?: string;
  project: string;
}

export type ProjectResolution = (
  | { kind: 'resolved'; projectRoot: string; via: ResolutionSource }
  | { kind: 'no-projects' }
  | { kind: 'ambiguous'; registered: string[] }
) & {
  /** Set when an explicit hint was dropped for naming a dangerous root. */
  ignoredDangerousHint?: { projectRoot: string; reason: string; via: ResolutionSource };
};

export type ResolutionSource = 'query' | 'header' | 'meta' | 'tracked-client' | 'single-project';

export interface ResolveProjectArgs {
  /** Value of the `?project=` query param, if any. */
  queryProject?: string | null;
  /** Value of the `X-Trace-Project` header, if any. */
  headerProject?: string | null;
  /** Parsed JSON-RPC body (or undefined if not POST / parse failed). */
  body?: unknown;
  /** Snapshot of currently registered projects. */
  projects: ReadonlyArray<RegisteredProjectLike>;
  /** Snapshot of currently tracked clients (for clientInfo.name match). */
  trackedClients: ReadonlyArray<TrackedClientLike>;
  /** Optional: tests want to bypass `isInitializeRequest` when faking bodies. */
  isInitializeRequest?: (body: unknown) => boolean;
}

/**
 * Read params._meta["traceMcp/projectRoot"] from any JSON-RPC request body.
 * MCP permits arbitrary `_meta` keys; this is the namespaced field we
 * document for IDE integrations that cannot pass `?project=`.
 */
export function extractMetaProjectRoot(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const params = (body as { params?: unknown }).params;
  if (!params || typeof params !== 'object') return undefined;
  const meta = (params as { _meta?: unknown })._meta;
  if (!meta || typeof meta !== 'object') return undefined;
  const value = (meta as Record<string, unknown>)['traceMcp/projectRoot'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Read params.clientInfo.name from an MCP initialize request body.
 * Used as a recovery key into the daemon's client tracking table.
 */
export function extractInitializeClientName(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const params = (body as { params?: unknown }).params;
  if (!params || typeof params !== 'object') return undefined;
  const clientInfo = (params as { clientInfo?: unknown }).clientInfo;
  if (!clientInfo || typeof clientInfo !== 'object') return undefined;
  const name = (clientInfo as { name?: unknown }).name;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

function looksLikeInitialize(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  return (body as { method?: unknown }).method === 'initialize';
}

/**
 * Apply the full precedence chain. Pure function — no I/O, no logging,
 * deterministic for fixed inputs. The cli.ts handler wraps this and
 * performs side effects (logging, response writes, auto-register).
 */
export function resolveProjectForMcpRequest(args: ResolveProjectArgs): ProjectResolution {
  const isInit = args.isInitializeRequest ?? looksLikeInitialize;

  let ignoredDangerousHint: ProjectResolution['ignoredDangerousHint'];
  /** Honour an explicit hint unless it names a dangerous root — then record and drop it. */
  const useHint = (value: string | undefined, via: ResolutionSource): ProjectResolution | null => {
    if (!value) return null;
    const reason = isDangerousProjectRoot(value);
    if (reason) {
      ignoredDangerousHint ??= { projectRoot: value, reason, via };
      return null;
    }
    return { kind: 'resolved', projectRoot: value, via };
  };

  const queryProject =
    typeof args.queryProject === 'string' && args.queryProject.length > 0
      ? args.queryProject
      : undefined;
  const fromQuery = useHint(queryProject, 'query');
  if (fromQuery) return fromQuery;

  const headerProject =
    typeof args.headerProject === 'string' && args.headerProject.length > 0
      ? args.headerProject
      : undefined;
  const fromHeader = useHint(headerProject, 'header');
  if (fromHeader) return fromHeader;

  const fromMeta = useHint(extractMetaProjectRoot(args.body), 'meta');
  if (fromMeta) return fromMeta;

  if (args.body !== undefined && isInit(args.body)) {
    const clientName = extractInitializeClientName(args.body);
    if (clientName) {
      const registered = new Set(args.projects.map((p) => p.root));
      const matches = args.trackedClients.filter(
        (c) => c.name === clientName && registered.has(c.project),
      );
      if (matches.length === 1) {
        return {
          kind: 'resolved',
          projectRoot: matches[0]!.project,
          via: 'tracked-client',
          ignoredDangerousHint,
        };
      }
    }
  }

  if (args.projects.length === 1) {
    return {
      kind: 'resolved',
      projectRoot: args.projects[0]!.root,
      via: 'single-project',
      ignoredDangerousHint,
    };
  }
  if (args.projects.length === 0) {
    return { kind: 'no-projects', ignoredDangerousHint };
  }
  return { kind: 'ambiguous', registered: args.projects.map((p) => p.root), ignoredDangerousHint };
}
