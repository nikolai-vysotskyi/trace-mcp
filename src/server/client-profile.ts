/**
 * Per-client tailoring of the advertised surface (TRA-513).
 *
 * The connected host tells us who it is in `initialize` (`clientInfo.name`) and
 * until now we threw that away, so every host got the same `tools/list` and the
 * same instructions. Two costs followed: we advertise tools the host already
 * has natively — pure wire cost plus a mis-pick opportunity, since the model now
 * has two ways to do one thing — and our routing table names host tools that
 * only exist in some hosts.
 *
 * A profile is data, not code: a set of tool names this host already covers,
 * plus the names its own file tools go by. It composes *after* the preset — the
 * preset is the coarse "how much capability" knob, the profile only removes what
 * this particular host duplicates. Nothing is renamed or removed: a suppressed
 * tool is hidden from `tools/list` and stays one `load_tools` call away.
 *
 * Deliberately conservative. A suppression entry is a claim that this host
 * genuinely covers that tool, and a wrong claim costs capability, so the lists
 * stay short until a host has actually been surveyed. `generic` — the fallback
 * for anything unrecognised — suppresses nothing at all.
 */
import type { TraceMcpConfig } from '../config.js';
import { resolvePreset } from '../tools/project/presets.js';
import { HOST_TOOLS_GENERIC, type HostToolNames, hostToolLines } from './instructions.js';

export const CLIENT_PROFILE_NAMES = [
  'claude-code',
  'codex',
  'cursor',
  'vscode',
  'generic',
] as const;
export type ClientProfileName = (typeof CLIENT_PROFILE_NAMES)[number];

export interface ClientProfile {
  name: ClientProfileName;
  /** Tools this host already covers — hidden from `tools/list`, not removed. */
  suppress: ReadonlySet<string>;
  /** What this host's own file tools are called, for the instructions block. */
  hostTools: HostToolNames;
}

/**
 * `search_text` is a regex-over-indexed-files tool. Every host below ships an
 * equivalent (Grep, `rg` through a shell, a workspace text search) that costs
 * the session nothing, so advertising ours buys a second way to do one thing.
 *
 * `discover_hermes_sessions` enumerates session logs for the Hermes harness —
 * inert on any of these hosts, which have their own log layout.
 */
const HOST_COVERED: ReadonlySet<string> = new Set(['search_text', 'discover_hermes_sessions']);

const PROFILES: Record<ClientProfileName, ClientProfile> = {
  'claude-code': {
    name: 'claude-code',
    suppress: HOST_COVERED,
    hostTools: {
      rubric: "your host's own tools are `Read`, `Grep`, `Glob`, `Edit`",
      read: '`Read`',
      grep: '`Grep`',
      glob: '`Glob`',
      edit: 'Edit/Write',
    },
  },
  codex: {
    name: 'codex',
    suppress: HOST_COVERED,
    hostTools: {
      rubric:
        'your host reads and searches through `shell` — cat, rg, find — and edits with `apply_patch`',
      read: '`shell` (cat)',
      grep: '`shell` (rg)',
      glob: '`shell` (find)',
      edit: 'apply_patch',
    },
  },
  cursor: {
    name: 'cursor',
    suppress: HOST_COVERED,
    hostTools: {
      rubric: "your host's own tools are `read_file`, `grep_search`, `file_search`, `edit_file`",
      read: '`read_file`',
      grep: '`grep_search`',
      glob: '`file_search`',
      edit: 'edit_file',
    },
  },
  vscode: {
    name: 'vscode',
    suppress: HOST_COVERED,
    hostTools: {
      rubric: "your host's own tools are `readFile`, `textSearch`, `fileSearch`, `editFile`",
      read: '`readFile`',
      grep: '`textSearch`',
      glob: '`fileSearch`',
      edit: 'editFile',
    },
  },
  // The fallback has to be a no-op, not a guess: a host we don't recognise may
  // have no file tools at all (Claude Desktop, a bare SDK client), and hiding
  // `search_text` there would take away its only content search.
  generic: { name: 'generic', suppress: new Set(), hostTools: HOST_TOOLS_GENERIC },
};

/** Substring → profile. Order matters: the first hit wins. */
const DETECTION: ReadonlyArray<[string, ClientProfileName]> = [
  // "claude-code" before "claude": Claude Desktop reports "claude-ai" and has
  // no native file tools, so it must fall through to `generic`.
  ['claude-code', 'claude-code'],
  ['codex', 'codex'],
  ['cursor', 'cursor'],
  ['visual-studio-code', 'vscode'],
  ['vscode', 'vscode'],
  ['copilot', 'vscode'],
];

/**
 * Resolve a host name from `initialize` to a profile name.
 *
 * Separators are normalised to `-` first: the same host reports itself as
 * "claude-code" from the CLI and "Claude Code" from an SDK wrapper, and both
 * have to land on the same profile.
 */
export function detectClientProfile(clientName: string | undefined): ClientProfileName {
  const name = (clientName ?? '').toLowerCase().replace(/[\s_.]+/g, '-');
  if (!name) return 'generic';
  for (const [needle, profile] of DETECTION) if (name.includes(needle)) return profile;
  return 'generic';
}

function isProfileName(v: string): v is ClientProfileName {
  return (CLIENT_PROFILE_NAMES as readonly string[]).includes(v);
}

/**
 * The profile this session runs with, or `null` when the layer is switched off.
 *
 * `TRACE_MCP_CLIENT_PROFILE` beats config, config beats detection — for users on
 * a host we guessed wrong about, and for anyone who wants the full surface
 * regardless (`off`). An unrecognised override value falls back to detection
 * rather than failing the handshake.
 */
export function resolveClientProfile(
  clientName: string | undefined,
  config: TraceMcpConfig,
): ClientProfile | null {
  const override = process.env.TRACE_MCP_CLIENT_PROFILE ?? config.tools?.client_profile ?? 'auto';
  if (override === 'off') return null;
  if (override !== 'auto' && isProfileName(override)) return PROFILES[override];
  return PROFILES[detectClientProfile(clientName)];
}

/** Read a profile by name. Exported for tests and `get_preset_info`-style reads. */
export function getClientProfile(name: ClientProfileName): ClientProfile {
  return PROFILES[name];
}

/**
 * Rewrite the host-tool names in a built instructions string.
 *
 * The instructions are composed by the daemon (or the in-process server) before
 * the client's `initialize` is even parsed, so this runs on the wire instead:
 * a substring swap of the exact lines `hostToolLines` produced. Both sides build
 * from that one function, so a drift makes the swap a no-op rather than a
 * corruption — and client-profile.test.ts fails when it does.
 */
export function retargetInstructions(instructions: string, profile: ClientProfile): string {
  if (!instructions || profile.hostTools === HOST_TOOLS_GENERIC) return instructions;
  const from = hostToolLines(HOST_TOOLS_GENERIC);
  const to = hostToolLines(profile.hostTools);
  let out = instructions;
  for (let i = 0; i < from.length; i++) {
    if (from[i] !== to[i]) out = out.split(from[i]).join(to[i]);
  }
  return out;
}

/**
 * One line telling the session what the profile took away and how to get it
 * back. Without it a suppressed tool is invisible: `load_tools` with no
 * arguments lists what the *preset* deferred, and a profile-suppressed tool is
 * inside the preset, so it shows up in neither list.
 */
export function suppressionNotice(profile: ClientProfile, hidden: readonly string[]): string {
  if (hidden.length === 0) return '';
  return (
    `Client profile "${profile.name}": ${hidden.length} tool(s) your host already covers ` +
    `are hidden from tools/list — ${hidden.join(', ')}. ` +
    `Call load_tools({ tools: ["${hidden[0]}"] }) to advertise them anyway, or set ` +
    'tools.client_profile to "off" to disable this layer.'
  );
}

/** A JSON-RPC frame, seen structurally — we never parse it into SDK types. */
type Frame = Record<string, unknown>;

/**
 * The profile applied to a live stdio session's wire traffic.
 *
 * It sits at the session boundary rather than inside the tool gate for the same
 * reason the preset filter does on the daemon path: one daemon serves many
 * sessions, and both backends build their surface — and their instructions —
 * before the client's `initialize` has been read. The session is the only place
 * that sees both who the client is and every frame going back to it.
 *
 * Hiding is all it does: a suppressed tool stays callable if the client asks for
 * it by name. That is deliberate — the token win is entirely in not advertising
 * the tool, and rejecting the call would only break a client that cached an
 * earlier `tools/list`.
 */
export class ClientProfileGate {
  private profile: ClientProfile | null = null;
  /** Suppressed tools this session pulled back in via `load_tools`. */
  private readonly reinstated = new Set<string>();
  /** Names actually withheld from the last `tools/list`, for logging/tests. */
  private lastHidden: string[] = [];

  constructor(private readonly config: TraceMcpConfig) {}

  /** Profile name for logs, or null while the handshake hasn't arrived. */
  get name(): ClientProfileName | null {
    return this.profile?.name ?? null;
  }

  /** Tools withheld from the most recent `tools/list`. */
  get hidden(): readonly string[] {
    return this.lastHidden;
  }

  /** Inbound: learn who the client is, and honour explicit escalation. */
  observeFromClient(msg: unknown): void {
    const m = msg as Frame;
    if (m.method === 'initialize') {
      const info = (m.params as Frame | undefined)?.clientInfo as Frame | undefined;
      const clientName = typeof info?.name === 'string' ? info.name : undefined;
      this.profile = resolveClientProfile(clientName, this.config);
      return;
    }
    if (m.method !== 'tools/call') return;
    const params = m.params as Frame | undefined;
    if (params?.name !== 'load_tools') return;
    const args = params.arguments as { preset?: string; tools?: string[] } | undefined;
    for (const t of args?.tools ?? []) this.reinstated.add(t);
    if (!args?.preset) return;
    const resolved = resolvePreset(args.preset);
    if (resolved === 'all') for (const t of this.profile?.suppress ?? []) this.reinstated.add(t);
    else if (resolved) for (const t of resolved) this.reinstated.add(t);
  }

  /** Outbound: retarget the instructions and thin the advertised surface. */
  applyToClient(msg: unknown): unknown {
    if (!this.profile) return msg;
    const m = msg as Frame;
    const result = m.result as Frame | undefined;
    if (!result) return msg;
    if (typeof result.instructions === 'string') return this.rewriteInitialize(m, result);
    if (Array.isArray(result.tools)) return this.filterToolsList(m, result);
    return msg;
  }

  // ── Internals ───────────────────────────────────────────────────────

  private suppressed(): string[] {
    return [...(this.profile?.suppress ?? [])].filter((t) => !this.reinstated.has(t));
  }

  private rewriteInitialize(msg: Frame, result: Frame): unknown {
    let instructions = retargetInstructions(result.instructions as string, this.profile!);
    // The notice needs the names, and at handshake time no tools/list has gone
    // out yet — so it states what the profile *will* hide.
    const notice = suppressionNotice(this.profile!, this.suppressed());
    if (notice) instructions = instructions ? `${instructions}\n\n${notice}` : notice;
    if (instructions === result.instructions) return msg;
    return { ...msg, result: { ...result, instructions } };
  }

  private filterToolsList(msg: Frame, result: Frame): unknown {
    const hide = new Set(this.suppressed());
    if (hide.size === 0) return msg;
    const advertised = result.tools as Array<{ name?: unknown }>;
    const tools = advertised.filter((t) => typeof t?.name !== 'string' || !hide.has(t.name));
    if (tools.length === advertised.length) return msg;
    this.lastHidden = advertised
      .map((t) => t?.name)
      .filter((n): n is string => typeof n === 'string' && hide.has(n));
    return { ...msg, result: { ...result, tools } };
  }
}
