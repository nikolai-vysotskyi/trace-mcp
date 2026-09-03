/**
 * JSON-RPC error payloads for the daemon's HTTP `/mcp` endpoint.
 *
 * MCP clients (Claude Code, Cursor, IDE integrations) expect a proper
 * JSON-RPC `{ jsonrpc, id, error: { code, message, data } }` envelope on
 * 4xx responses. Returning a bare `{ error: "..." }` triggers the cryptic
 * `MCP error -32603: Backend send failed: Error POSTing to endpoint: …`
 * wrapping that issue #168 reported. Centralizing the shape here keeps
 * the cli.ts handler readable and makes the branches independently
 * testable.
 */

export type ProjectNotFoundReason =
  | 'folder_missing'
  | 'dangerous_root'
  | 'no_project_markers'
  | 'auto_register_failed';

export interface ProjectNotFoundInput {
  projectRoot: string;
  /** `true` when `fs.existsSync(projectRoot)` was false. */
  folderMissing: boolean;
  /** Non-null reason string from `isDangerousProjectRoot`, or null. */
  dangerReason: string | null;
  /** `true` if the path has package.json / pyproject.toml / .git / similar. */
  hasMarkers: boolean;
  /** The JSON-RPC request id, if any, to echo back. */
  rpcId: unknown;
}

export interface JsonRpcErrorBody {
  jsonrpc: '2.0';
  id: unknown;
  error: {
    code: number;
    message: string;
    data: { reason: string; projectRoot?: string; registered?: string[] };
  };
}

/** Build a JSON-RPC error for the "/mcp project not found" branch. */
export function buildProjectNotFoundError(input: ProjectNotFoundInput): JsonRpcErrorBody {
  const { projectRoot, folderMissing, dangerReason, hasMarkers, rpcId } = input;

  let reason: ProjectNotFoundReason;
  let message: string;
  if (folderMissing) {
    reason = 'folder_missing';
    message =
      `Project folder no longer exists: ${projectRoot}. ` +
      `Remove the stale registration with \`trace-mcp remove ${projectRoot}\`, ` +
      'or point your MCP client at an existing project root.';
  } else if (dangerReason) {
    reason = 'dangerous_root';
    message =
      `Refusing to index ${projectRoot} (${dangerReason}). ` +
      'Configure your MCP client to use a real project directory ' +
      '(the folder containing package.json / pyproject.toml / go.mod / .git) ' +
      'instead of your home or a system directory.';
  } else if (!hasMarkers) {
    reason = 'no_project_markers';
    message =
      `Project not found: ${projectRoot} (no package.json / pyproject.toml / .git / similar markers). ` +
      `Register it explicitly with \`trace-mcp add ${projectRoot}\` if this really is a project root.`;
  } else {
    reason = 'auto_register_failed';
    message =
      `Project not found: ${projectRoot}. ` +
      'Auto-registration failed — check the daemon log for details.';
  }

  return {
    jsonrpc: '2.0',
    id: rpcId === undefined ? null : rpcId,
    error: {
      code: -32002,
      message,
      data: { reason, projectRoot },
    },
  };
}

/** Build a JSON-RPC error for the "no projects registered" branch. */
export function buildNoProjectsError(rpcId: unknown): JsonRpcErrorBody {
  return {
    jsonrpc: '2.0',
    id: rpcId === undefined ? null : rpcId,
    error: {
      code: -32002,
      message:
        'No projects registered with trace-mcp. ' +
        'Run `trace-mcp add <absolute-project-path>` (or open the desktop app) to register a project, ' +
        'then reconnect.',
      data: { reason: 'no_projects_registered' },
    },
  };
}

/** Build a JSON-RPC error for the "ambiguous (multiple registered)" branch. */
export function buildAmbiguousProjectError(
  registered: readonly string[],
  rpcId: unknown,
): JsonRpcErrorBody {
  return {
    jsonrpc: '2.0',
    id: rpcId === undefined ? null : rpcId,
    error: {
      code: -32602,
      message:
        'Multiple projects registered — pass ?project=<absolute-path> on /mcp, ' +
        'set the X-Trace-Project header, or include params._meta["traceMcp/projectRoot"] in the MCP initialize body. ' +
        `Registered roots: ${registered.join(', ')}`,
      data: { reason: 'ambiguous_project', registered: [...registered] },
    },
  };
}

/**
 * Pick the error for a resolution that produced no project, and the HTTP status
 * to send it with.
 *
 * The branch that matters is the dangerous-hint one. TRA-286 made the resolver
 * DROP an explicit `?project=` / header / `_meta` hint naming a home or system
 * directory and fall through to the tracked-client and single-project steps —
 * right, and unchanged here. But when that fall-through also came up empty, the
 * client was handed the plain ambiguous error: "pass ?project=<absolute-path>",
 * addressed to a client that had just passed exactly that. Our own stdio proxy
 * is one of them — it always appends `?project=<cwd>`, so a session started with
 * cwd=~ (or /, or /tmp) lost all of trace-mcp's tools behind advice it could not
 * act on (TRA-720). Naming the dropped root turns that into the one instruction
 * that actually helps: point the client at a real project directory.
 */
export function buildResolutionFailureError(
  resolution: {
    kind: 'no-projects' | 'ambiguous';
    registered?: readonly string[];
    ignoredDangerousHint?: { projectRoot: string; reason: string };
  },
  rpcId: unknown,
): { status: number; body: JsonRpcErrorBody } {
  const dropped = resolution.ignoredDangerousHint;
  if (dropped) {
    return {
      status: 404,
      body: buildProjectNotFoundError({
        projectRoot: dropped.projectRoot,
        folderMissing: false,
        dangerReason: dropped.reason,
        hasMarkers: false,
        rpcId,
      }),
    };
  }
  if (resolution.kind === 'no-projects') {
    return { status: 404, body: buildNoProjectsError(rpcId) };
  }
  return { status: 400, body: buildAmbiguousProjectError(resolution.registered ?? [], rpcId) };
}

/** Extract the `id` field from a parsed JSON-RPC body for echoing back. */
export function extractRpcId(parsedBody: unknown): unknown {
  if (parsedBody && typeof parsedBody === 'object' && 'id' in parsedBody) {
    return (parsedBody as { id?: unknown }).id ?? null;
  }
  return null;
}
