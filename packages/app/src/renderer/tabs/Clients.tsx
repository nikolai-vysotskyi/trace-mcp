import { useCallback, useEffect, useRef, useState } from 'react';
import { StatusDot } from '../components/StatusDot';
import { type ClientInfo, useDaemon } from '../hooks/useDaemon';

// ── All supported MCP clients (same order as CLI init) ────────────
type ClientName =
  | 'claude-code'
  | 'claw-code'
  | 'claude-desktop'
  | 'cursor'
  | 'windsurf'
  | 'continue'
  | 'junie'
  | 'jetbrains-ai'
  | 'codex'
  | 'amp'
  | 'warp'
  | 'factory-droid';

const ALL_CLIENTS: { name: ClientName; label: string }[] = [
  { name: 'claude-code', label: 'Claude Code' },
  { name: 'claw-code', label: 'Claw Code' },
  { name: 'claude-desktop', label: 'Claude Desktop' },
  { name: 'cursor', label: 'Cursor' },
  { name: 'windsurf', label: 'Windsurf' },
  { name: 'continue', label: 'Continue' },
  { name: 'junie', label: 'Junie' },
  { name: 'jetbrains-ai', label: 'JetBrains AI Assistant' },
  { name: 'codex', label: 'Codex' },
  { name: 'amp', label: 'AMP' },
  { name: 'warp', label: 'Warp' },
  { name: 'factory-droid', label: 'Factory Droid' },
];

// Clients that support enforcement levels (hooks & tweakcc are CC-specific)
const CLAUDE_CLIENTS = new Set<ClientName>(['claude-code', 'claw-code', 'claude-desktop']);

// Clients that require manual configuration (no programmatic write path)
const MANUAL_CLIENTS = new Set<ClientName>(['jetbrains-ai', 'warp']);

const MANUAL_HINTS: Partial<Record<ClientName, string>> = {
  'jetbrains-ai': 'Settings → Tools → AI Assistant → MCP → Add → Command: trace-mcp, Args: serve',
  warp: 'Settings → Agents → MCP servers → + Add → paste { mcpServers: { "trace-mcp": ... } }',
};

interface DetectedClient {
  name: string;
  configPath: string;
  hasTraceMcp: boolean;
}

type ClientConfigStatus = 'missing' | 'up_to_date' | 'stale' | 'unmanageable' | 'unknown';

interface RichClientStatus {
  client: string;
  configPath: string | null;
  status: ClientConfigStatus;
  staleReason?: string;
}

// ── Enforcement level popover ─────────────────────────────────────
type EnforcementLevel = 'base' | 'standard' | 'max';

const LEVELS: { value: EnforcementLevel; label: string; hint: string }[] = [
  { value: 'base', label: 'Base', hint: 'CLAUDE.md only — soft routing rules' },
  { value: 'standard', label: 'Standard', hint: 'CLAUDE.md + hooks' },
  { value: 'max', label: 'Max', hint: 'CLAUDE.md + hooks + tweakcc (recommended)' },
];

function LevelPopover({
  onSelect,
  onClose,
}: {
  onSelect: (level: EnforcementLevel) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full mt-1 z-50 rounded-lg overflow-hidden"
      style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
        minWidth: 220,
      }}
    >
      {LEVELS.map((l, i) => (
        <button
          type="button"
          key={l.value}
          onClick={() => onSelect(l.value)}
          className="w-full text-left px-3 py-2 transition-colors hover:brightness-110"
          style={{
            background: l.value === 'max' ? 'var(--bg-active)' : 'transparent',
            borderBottom: i < LEVELS.length - 1 ? '0.5px solid var(--border)' : 'none',
          }}
        >
          <div className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
            {l.label}
          </div>
          <div className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
            {l.hint}
          </div>
        </button>
      ))}
    </div>
  );
}

// ── Connected-client helpers ──────────────────────────────────────
function clientStatus(client: ClientInfo): 'active' | 'idle' | 'disconnected' {
  const elapsed = Date.now() - new Date(client.lastSeen).getTime();
  if (elapsed < 30_000) return 'active';
  if (elapsed < 120_000) return 'idle';
  return 'disconnected';
}

function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

const CLIENT_LABELS: Record<string, string> = Object.fromEntries(
  ALL_CLIENTS.map((c) => [c.name, c.label]),
);

function clientDisplayName(client: ClientInfo): string {
  if (client.name) return CLIENT_LABELS[client.name] ?? client.name;
  return client.id.slice(0, 8);
}

// ── Row for a connected session ───────────────────────────────────
function ConnectedClientRow({ client }: { client: ClientInfo }) {
  const status = clientStatus(client);

  return (
    <div
      className="flex items-center gap-2 px-2 py-1.5 rounded-md"
      style={{ background: 'var(--bg-secondary)' }}
    >
      <StatusDot status={status} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>
            {clientDisplayName(client)}
          </span>
          <span className="text-[10px] shrink-0" style={{ color: 'var(--text-tertiary)' }}>
            {client.transport}
          </span>
        </div>
        {client.project && (
          <div
            className="text-[10px] truncate"
            style={{ color: 'var(--text-secondary)' }}
            title={client.project}
          >
            {client.project.split(/[/\\]/).filter(Boolean).pop()}
          </div>
        )}
      </div>
      <span className="text-[10px] shrink-0" style={{ color: 'var(--text-tertiary)' }}>
        {timeAgo(client.lastSeen)}
      </span>
    </div>
  );
}

// ── Row for a supported client (configured or not) ────────────────
function SupportedClientRow({
  name,
  label,
  status,
  configPath,
  staleReason,
  configuring,
  onConnect,
  onConnectWithLevel,
}: {
  name: ClientName;
  label: string;
  /**
   * Drives the right-hand control:
   *   missing       → "Connect" / level popover
   *   up_to_date    → "Configured"
   *   stale         → "Update" (rewrites the entry to current expectations)
   *   unmanageable  → "Manual"
   *   unknown       → "Configured" (presence-only — Codex TOML, can't compare safely)
   */
  status: ClientConfigStatus;
  configPath?: string | null;
  staleReason?: string;
  configuring: boolean;
  onConnect: () => void;
  onConnectWithLevel: (level: EnforcementLevel) => void;
}) {
  const isManual = MANUAL_CLIENTS.has(name);
  const hasClaude = CLAUDE_CLIENTS.has(name);
  const [showLevels, setShowLevels] = useState(false);

  const handleConnect = () => {
    if (hasClaude) {
      setShowLevels(true);
    } else {
      onConnect();
    }
  };

  const isPresent = status === 'up_to_date' || status === 'unknown';
  const dotColor =
    status === 'up_to_date' || status === 'unknown'
      ? '#34c759' // green: integration is healthy
      : status === 'stale'
        ? '#ff9500' // amber: present but drifted — update available
        : 'var(--text-tertiary)'; // gray: missing or unmanageable

  return (
    <div
      className="flex items-center gap-2 px-2 py-1.5 rounded-md relative"
      style={{ background: 'var(--bg-secondary)' }}
    >
      <div
        className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{
          background: dotColor,
          opacity: isPresent || status === 'stale' ? 1 : 0.4,
        }}
      />
      <div className="flex-1 min-w-0">
        <span
          className="text-xs font-medium"
          style={{
            color: isPresent || status === 'stale' ? 'var(--text-primary)' : 'var(--text-secondary)',
          }}
        >
          {label}
        </span>
        {(isPresent || status === 'stale') && configPath && (
          <div className="text-[10px] truncate" style={{ color: 'var(--text-tertiary)' }}>
            {configPath.replace(/^\/Users\/[^/]+/, '~')}
            {status === 'stale' && staleReason && (
              <span style={{ color: '#ff9500' }}> · drift: {staleReason}</span>
            )}
          </div>
        )}
        {status === 'missing' && isManual && MANUAL_HINTS[name] && (
          <div className="text-[10px] truncate" style={{ color: 'var(--text-tertiary)' }}>
            {MANUAL_HINTS[name]}
          </div>
        )}
      </div>
      {status === 'up_to_date' || status === 'unknown' ? (
        <span className="text-[10px] shrink-0 font-medium" style={{ color: '#34c759' }}>
          Configured
        </span>
      ) : status === 'unmanageable' || isManual ? (
        <span className="text-[10px] shrink-0" style={{ color: 'var(--text-tertiary)' }}>
          Manual
        </span>
      ) : status === 'stale' ? (
        <button
          type="button"
          onClick={handleConnect}
          disabled={configuring}
          title={staleReason ? `Drifted field: ${staleReason}` : 'Refresh trace-mcp config'}
          className="text-[10px] px-2 py-0.5 rounded font-medium transition-colors shrink-0"
          style={{
            background: '#ff9500',
            color: '#fff',
            opacity: configuring ? 0.6 : 1,
            cursor: configuring ? 'default' : 'pointer',
          }}
        >
          {configuring ? 'Updating…' : 'Update'}
        </button>
      ) : (
        <>
          <button
            type="button"
            onClick={handleConnect}
            disabled={configuring}
            className="text-[10px] px-2 py-0.5 rounded font-medium transition-colors shrink-0"
            style={{
              background: 'var(--accent)',
              color: '#fff',
              opacity: configuring ? 0.6 : 1,
              cursor: configuring ? 'default' : 'pointer',
            }}
          >
            {configuring ? 'Connecting…' : 'Connect'}
          </button>
          {showLevels && (
            <LevelPopover
              onSelect={(level) => {
                setShowLevels(false);
                onConnectWithLevel(level);
              }}
              onClose={() => setShowLevels(false)}
            />
          )}
        </>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────
export function Clients() {
  const { clients, loading, connected, restarting, restartDaemon, fetchClients } = useDaemon();
  const [detected, setDetected] = useState<DetectedClient[]>([]);
  const [statuses, setStatuses] = useState<RichClientStatus[]>([]);
  const [detecting, setDetecting] = useState(true);
  const [configuringClient, setConfiguringClient] = useState<string | null>(null);

  const detectClients = useCallback(async () => {
    setDetecting(true);
    try {
      // Prefer the rich CLI-backed status report when available — it knows
      // whether an existing entry is up_to_date or stale (e.g. missing
      // alwaysLoad). Fall back to detect-mcp-clients on older daemons that
      // don't ship `clients status` yet.
      const richResult = await window.electronAPI?.getMcpClientStatuses?.('global');
      if (richResult?.ok && richResult.statuses) {
        setStatuses(richResult.statuses);
        // Synthesize the legacy "detected" shape so we don't have to
        // refactor every consumer in this file at once.
        const synth: DetectedClient[] = richResult.statuses
          .filter((s) => s.status === 'up_to_date' || s.status === 'stale' || s.status === 'unknown')
          .map((s) => ({
            name: s.client,
            configPath: s.configPath ?? '',
            hasTraceMcp: true,
          }));
        setDetected(synth);
      } else {
        const fallback = await window.electronAPI?.detectMcpClients();
        setDetected(fallback ?? []);
        setStatuses([]);
      }
    } catch {
      setDetected([]);
      setStatuses([]);
    } finally {
      setDetecting(false);
    }
  }, []);

  useEffect(() => {
    detectClients();
  }, [detectClients]);

  const handleConnect = async (clientName: string, level: EnforcementLevel = 'max') => {
    setConfiguringClient(clientName);
    try {
      const result = await window.electronAPI?.configureMcpClient(clientName, level);
      if (result?.ok) {
        await detectClients();
      }
    } finally {
      setConfiguringClient(null);
    }
  };

  if (!connected && !loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2">
        <div className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
          Daemon not reachable
        </div>
        <button
          type="button"
          onClick={() => restartDaemon()}
          disabled={restarting}
          className="text-[11px] px-4 py-1.5 rounded-lg font-medium transition-all"
          style={{
            background: 'var(--fill-control)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            color: 'var(--accent)',
            border: '0.5px solid var(--border)',
            boxShadow: 'var(--shadow-control)',
            cursor: restarting ? 'default' : 'pointer',
            opacity: restarting ? 0.6 : 1,
          }}
        >
          {restarting ? 'Starting…' : 'Restart Daemon'}
        </button>
      </div>
    );
  }

  // Build configured set (client name → best config entry)
  const configuredMap = new Map<string, DetectedClient>();
  for (const d of detected) {
    if (d.hasTraceMcp) {
      if (!configuredMap.has(d.name)) {
        configuredMap.set(d.name, d);
      }
    }
  }
  const statusMap = new Map<string, RichClientStatus>();
  for (const s of statuses) {
    statusMap.set(s.client, s);
  }

  /**
   * Resolve the per-row status. When the rich CLI-backed map is present
   * we trust it; otherwise synthesize from the legacy `detected` set so
   * the UI stays functional on older trace-mcp daemons.
   */
  const resolveStatus = (clientName: ClientName): RichClientStatus => {
    const rich = statusMap.get(clientName);
    if (rich) return rich;
    if (MANUAL_CLIENTS.has(clientName)) {
      return { client: clientName, configPath: null, status: 'unmanageable' };
    }
    const legacy = configuredMap.get(clientName);
    return {
      client: clientName,
      configPath: legacy?.configPath ?? null,
      status: legacy ? 'up_to_date' : 'missing',
    };
  };

  // Sort: actionable rows first (stale → update available), then configured,
  // then missing/manual. Inside each bucket preserve declaration order.
  const sortRank = (s: ClientConfigStatus): number => {
    switch (s) {
      case 'stale':
        return 0;
      case 'up_to_date':
      case 'unknown':
        return 1;
      case 'missing':
        return 2;
      case 'unmanageable':
        return 3;
    }
  };
  const sortedClients = [...ALL_CLIENTS].sort((a, b) => {
    const ra = sortRank(resolveStatus(a.name).status);
    const rb = sortRank(resolveStatus(b.name).status);
    return ra - rb;
  });

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {/* Section 1: Supported clients / configuration */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            Supported Clients
          </h2>
          <button
            type="button"
            onClick={() => detectClients()}
            className="p-1 rounded-md transition-colors hover:opacity-80"
            style={{ color: 'var(--text-secondary)' }}
            title="Refresh"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M1.5 1.5v4h4" />
              <path d="M1.5 5.5A6.5 6.5 0 0 1 14.5 8" />
              <path d="M14.5 14.5v-4h-4" />
              <path d="M14.5 10.5A6.5 6.5 0 0 1 1.5 8" />
            </svg>
          </button>
        </div>

        {detecting ? (
          <div className="text-xs py-2 text-center" style={{ color: 'var(--text-tertiary)' }}>
            Detecting clients…
          </div>
        ) : (
          <div className="space-y-1">
            {sortedClients.map((c) => {
              const s = resolveStatus(c.name);
              return (
                <SupportedClientRow
                  key={c.name}
                  name={c.name}
                  label={c.label}
                  status={s.status}
                  configPath={s.configPath}
                  staleReason={s.staleReason}
                  configuring={configuringClient === c.name}
                  onConnect={() => handleConnect(c.name)}
                  onConnectWithLevel={(level) => handleConnect(c.name, level)}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* Section 2: Live connected sessions */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            Active Sessions
          </h2>
          <button
            type="button"
            onClick={() => fetchClients()}
            className="p-1 rounded-md transition-colors hover:opacity-80"
            style={{ color: 'var(--text-secondary)' }}
            title="Refresh"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M1.5 1.5v4h4" />
              <path d="M1.5 5.5A6.5 6.5 0 0 1 14.5 8" />
              <path d="M14.5 14.5v-4h-4" />
              <path d="M14.5 10.5A6.5 6.5 0 0 1 1.5 8" />
            </svg>
          </button>
        </div>

        {loading ? (
          <div className="text-xs py-2 text-center" style={{ color: 'var(--text-tertiary)' }}>
            Loading…
          </div>
        ) : clients.length === 0 ? (
          <div className="text-xs py-2 text-center" style={{ color: 'var(--text-secondary)' }}>
            No active MCP sessions.
            <br />
            <span style={{ color: 'var(--text-tertiary)' }}>
              Sessions appear when a client connects via trace-mcp serve.
            </span>
          </div>
        ) : (
          <div className="space-y-1">
            {[...clients]
              .sort((a, b) => new Date(b.connectedAt).getTime() - new Date(a.connectedAt).getTime())
              .map((c) => (
                <ConnectedClientRow key={c.id} client={c} />
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
