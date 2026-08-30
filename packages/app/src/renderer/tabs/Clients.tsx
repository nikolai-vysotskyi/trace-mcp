/**
 * Clients — the menu window's "MCP clients" surface (TRA-295).
 *
 * Layout:
 *   Toolbar  — 52px glass row: the screen title on the left, one icon button
 *              (Refresh) on the right. The screen used to have neither a title
 *              nor a toolbar, and each section carried its own unlabelled 18px
 *              refresh glyph in its top-right corner.
 *   Content  — two inset grouped lists capped at a readable measure:
 *              Supported clients · Active sessions.
 *
 * What this replaces, measured on the running app before the rewrite:
 *   - Ten accent-filled `Connect` buttons stacked vertically — a wall of blue
 *     far past the ~5% accent budget. Every row action is a bordered button
 *     now, and NOTHING on this screen is prominent.
 *   - Rows floating on the bare frame: a leading grey dot, a 12px name, ~1000px
 *     of dead width, then the button. They are 44px rows of one grouped list.
 *   - A leading dot that was grey for every supported client and therefore
 *     unreadable. Connection state is now a dot PLUS the word "Connected", and
 *     a client with nothing to report carries no dot at all.
 *   - `Manual` as a right-aligned grey word for JetBrains AI Assistant and
 *     Warp — an undocumented convention. It is a "Set up manually…" button that
 *     discloses the actual steps.
 *   - `401b97c5 http` as a session's primary label: a raw id where the name
 *     goes. The project leads, the id is a monospace caption.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { relativeTime } from '../i18n/format';
import {
  Badge,
  Button,
  EmptyState,
  Menu,
  MenuItem,
  MenuSection,
  StatusDot,
  Toolbar,
  useMenuAnchor,
  type Tone,
} from '../lattice/ui';
import { Skeleton } from '../workspace/components/Skeleton';
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

/* Product names: the same in every locale, so they stay inline. */
const ALL_CLIENTS: { name: ClientName; label: string }[] = [
  { name: 'claude-code', label: 'Claude Code' }, // i18n-exempt
  { name: 'claw-code', label: 'Claw Code' }, // i18n-exempt
  { name: 'claude-desktop', label: 'Claude Desktop' }, // i18n-exempt
  { name: 'cursor', label: 'Cursor' }, // i18n-exempt
  { name: 'windsurf', label: 'Windsurf' }, // i18n-exempt
  { name: 'continue', label: 'Continue' }, // i18n-exempt
  { name: 'junie', label: 'Junie' }, // i18n-exempt
  { name: 'jetbrains-ai', label: 'JetBrains AI Assistant' }, // i18n-exempt
  { name: 'codex', label: 'Codex' }, // i18n-exempt
  { name: 'amp', label: 'AMP' }, // i18n-exempt
  { name: 'warp', label: 'Warp' }, // i18n-exempt
  { name: 'factory-droid', label: 'Factory Droid' }, // i18n-exempt
];

// Clients that support enforcement levels (hooks & tweakcc are CC-specific)
const CLAUDE_CLIENTS = new Set<ClientName>(['claude-code', 'claw-code', 'claude-desktop']);

// Clients that require manual configuration (no programmatic write path)
const MANUAL_CLIENTS = new Set<ClientName>(['jetbrains-ai', 'warp']);

/* Not translated, on purpose: this is the literal path a user clicks inside
   somebody else's app, and those menus ship in English. A translated path sends
   them looking for a menu that is not there. */
const MANUAL_HINTS: Partial<Record<ClientName, string>> = {
  'jetbrains-ai': 'Settings → Tools → AI Assistant → MCP → Add → Command: trace-mcp, Args: serve',
  warp: 'Settings → Agents → MCP servers → + Add → paste { mcpServers: { "trace-mcp": … } }',
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
  /**
   * Enforcement level the config on disk is already on. `null` — or absent, on
   * a daemon older than the field — means "we don't know", which is the cue to
   * ask the user rather than reuse a level.
   */
  level?: EnforcementLevel | null;
}

// ── Enforcement levels ────────────────────────────────────────────
type EnforcementLevel = 'base' | 'standard' | 'max';

const LEVELS: { value: EnforcementLevel; labelKey: string; hintKey: string }[] = [
  { value: 'base', labelKey: 'levelBase', hintKey: 'levelBaseHint' },
  { value: 'standard', labelKey: 'levelStandard', hintKey: 'levelStandardHint' },
  { value: 'max', labelKey: 'levelMax', hintKey: 'levelMaxHint' },
];

// ── Helpers ───────────────────────────────────────────────────────
function clientStatus(client: ClientInfo): Tone {
  const elapsed = Date.now() - new Date(client.lastSeen).getTime();
  if (elapsed < 30_000) return 'green';
  if (elapsed < 120_000) return 'orange';
  return 'neutral';
}

const CLIENT_LABELS: Record<string, string> = Object.fromEntries(
  ALL_CLIENTS.map((c) => [c.name, c.label]),
);

/** The row's primary label: the project being worked on, then the client that
    is working on it. The session id is neither, so it is never the headline. */
function sessionTitle(client: ClientInfo, fallback: string): string {
  if (client.project) return client.project.split(/[/\\]/).filter(Boolean).pop() ?? client.project;
  if (client.name) return CLIENT_LABELS[client.name] ?? client.name;
  return fallback;
}

function shortPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

// ── Section scaffolding (same idiom as Project Overview) ──────────

/** A titled group. Grouping is whitespace and a caption, never a rule. */
function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3
        className="flex items-baseline gap-1.5 px-1 min-h-6 text-[11px] leading-[13px] font-semibold"
        style={{ color: 'var(--label-secondary)' }}
      >
        {title}
        {count !== undefined && count > 0 && <span className="tabular-nums">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

/** Inset grouped-list container. Content, so: opaque, hairline, no shadow. */
function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="overflow-hidden"
      style={{
        background: 'var(--surface)',
        borderRadius: 12,
        border: '0.5px solid var(--separator)',
      }}
    >
      {children}
    </div>
  );
}

/** Rows at the real 44px geometry so nothing moves when the data lands. */
function SkeletonRows({ rows, label }: { rows: number; label: string }) {
  return (
    <div role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="flex items-center justify-between px-3"
          style={{
            height: 44,
            borderBottom: i === rows - 1 ? 'none' : '0.5px solid var(--separator)',
          }}
        >
          <Skeleton width={96 + ((i * 31) % 56)} height={11} />
          <Skeleton width={64} height={11} />
        </div>
      ))}
    </div>
  );
}

// ── Row for a connected session ───────────────────────────────────
function ConnectedClientRow({ client, last }: { client: ClientInfo; last: boolean }) {
  const { t } = useTranslation('clients');
  const tone = clientStatus(client);
  const state =
    tone === 'green'
      ? t('sessionActive')
      : tone === 'orange'
        ? t('sessionIdle')
        : t('sessionStale');

  return (
    <div
      className="flex items-center gap-2.5 px-3"
      style={{ height: 44, borderBottom: last ? 'none' : '0.5px solid var(--separator)' }}
    >
      <StatusDot tone={tone} pulse={tone === 'green'} title={state} />
      <div className="flex-1 min-w-0">
        <div
          className="text-[13px] leading-4 truncate"
          style={{ color: 'var(--label)' }}
          title={client.project ?? undefined}
        >
          {sessionTitle(client, t('unnamedSession'))}
        </div>
        <div
          className="text-[11px] leading-[13px] truncate"
          style={{ color: 'var(--label-secondary)', fontFamily: 'var(--font-mono)' }}
        >
          {client.id.slice(0, 8)} · {client.transport}
        </div>
      </div>
      {/* The dot's colour is never the only carrier of the state — the word is
          right next to it, and the timestamp is tabular so the column lines up. */}
      <span
        className="text-[11px] leading-[13px] shrink-0"
        style={{ color: 'var(--label-secondary)' }}
      >
        {state} ·{' '}
        <span className="tabular-nums">
          {relativeTime(new Date(client.lastSeen).getTime(), Date.now(), 'short')}
        </span>
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
  last,
  onConnect,
  onConnectWithLevel,
}: {
  name: ClientName;
  label: string;
  /**
   * Drives the right-hand control:
   *   missing       → "Connect" (level menu for the Claude family)
   *   up_to_date    → a green dot + the word "Connected"
   *   stale         → "Update available" badge + "Update"
   *   unmanageable  → "Set up manually…", which discloses the steps
   *   unknown       → "Connected" (presence-only — Codex TOML, can't compare)
   */
  status: ClientConfigStatus;
  configPath?: string | null;
  staleReason?: string;
  configuring: boolean;
  last: boolean;
  onConnect: () => void;
  onConnectWithLevel: (level: EnforcementLevel) => void;
}) {
  const { t } = useTranslation('clients');
  const isManual = MANUAL_CLIENTS.has(name) || status === 'unmanageable';
  const hasLevels = CLAUDE_CLIENTS.has(name);
  const levelMenu = useMenuAnchor();
  const [showSteps, setShowSteps] = useState(false);

  const connected = status === 'up_to_date' || status === 'unknown';
  const handleConnect = () => {
    if (hasLevels) levelMenu.open();
    else onConnect();
  };

  /* One caption slot, and only when there is something to say: where the entry
     lives, or the manual steps the user asked to see. */
  const caption =
    isManual && showSteps
      ? MANUAL_HINTS[name]
      : (connected || status === 'stale') && configPath
        ? shortPath(configPath)
        : null;

  return (
    <div
      className="flex items-center gap-2.5 px-3"
      style={{
        minHeight: 44,
        paddingTop: caption ? 8 : 0,
        paddingBottom: caption ? 8 : 0,
        borderBottom: last ? 'none' : '0.5px solid var(--separator)',
      }}
    >
      <div className="flex-1 min-w-0">
        <div className="text-[13px] leading-4 truncate" style={{ color: 'var(--label)' }}>
          {label}
        </div>
        {caption && (
          <div
            className="text-[11px] leading-[13px] truncate"
            style={{ color: 'var(--label-secondary)' }}
            title={caption}
          >
            {caption}
          </div>
        )}
      </div>

      {connected ? (
        /* Colour alone never carries the state: the dot is paired with the word. */
        <span
          className="flex items-center gap-1.5 text-[13px] leading-4 shrink-0"
          style={{ color: 'var(--label-secondary)' }}
        >
          <StatusDot tone="green" />
          {t('connected')}
        </span>
      ) : status === 'stale' ? (
        <>
          <Badge
            tone="orange"
            title={staleReason ? t('driftedField', { field: staleReason }) : undefined}
          >
            {t('updateAvailable')}
          </Badge>
          <Button disabled={configuring} onClick={handleConnect}>
            {configuring ? t('updating') : t('update')}
          </Button>
        </>
      ) : isManual ? (
        <Button
          active={showSteps}
          aria-expanded={showSteps}
          onClick={() => setShowSteps((v) => !v)}
        >
          {showSteps ? t('hideSteps') : t('setUpManually')}
        </Button>
      ) : (
        <Button
          ref={levelMenu.ref}
          disabled={configuring}
          aria-haspopup={hasLevels ? 'menu' : undefined}
          aria-expanded={hasLevels ? levelMenu.at !== null : undefined}
          onClick={handleConnect}
        >
          {configuring ? t('connecting') : t('connect')}
        </Button>
      )}

      {levelMenu.at && (
        <Menu x={levelMenu.at.x} y={levelMenu.at.y} align="end" onClose={levelMenu.close}>
          <MenuSection>{t('enforcementLevel')}</MenuSection>
          {LEVELS.map((l) => (
            <MenuItem
              key={l.value}
              title={t(l.hintKey)}
              onClick={() => {
                levelMenu.close();
                onConnectWithLevel(l.value);
              }}
            >
              {t(l.labelKey)}
            </MenuItem>
          ))}
        </Menu>
      )}
    </div>
  );
}

// ── Surface ───────────────────────────────────────────────────────
export function Clients() {
  const { t } = useTranslation('clients');
  const { clients, loading, connected, restarting, restartDaemon, fetchClients } = useDaemon();
  const [detected, setDetected] = useState<DetectedClient[]>([]);
  const [statuses, setStatuses] = useState<RichClientStatus[]>([]);
  const [detecting, setDetecting] = useState(true);
  const [configuringClient, setConfiguringClient] = useState<string | null>(null);
  const [scrolled, setScrolled] = useState(false);

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

  const refreshAll = () => {
    detectClients();
    fetchClients();
  };

  /* The toolbar owns the pane and always renders — a surface that swaps its
     whole chrome for an error panel reads as a different screen. */
  const daemonDown = !connected && !loading;

  // Build configured set (client name → best config entry)
  const configuredMap = new Map<string, DetectedClient>();
  for (const d of detected) {
    if (d.hasTraceMcp && !configuredMap.has(d.name)) {
      configuredMap.set(d.name, d);
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
  const sortedClients = [...ALL_CLIENTS].sort(
    (a, b) => sortRank(resolveStatus(a.name).status) - sortRank(resolveStatus(b.name).status),
  );

  const sessions = [...clients].sort(
    (a, b) => new Date(b.connectedAt).getTime() - new Date(a.connectedAt).getTime(),
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* ── Toolbar ──────────────────────────────────────────────────── */}
      <Toolbar scrolled={scrolled} className="gap-3">
        <h2
          className="flex-1 min-w-0 text-[15px] leading-5 font-semibold truncate"
          style={{ color: 'var(--label)', letterSpacing: '-0.01em' }}
        >
          {t('title')}
        </h2>
        <Button
          variant="icon"
          icon="refresh"
          onClick={refreshAll}
          aria-label={t('refresh')}
          title={t('refresh')}
        />
      </Toolbar>

      {/* ── Content ──────────────────────────────────────────────────── */}
      <div
        className="flex-1 overflow-auto"
        onScroll={(e) => setScrolled((e.target as HTMLElement).scrollTop > 0)}
      >
        {daemonDown ? (
          <div className="flex items-center justify-center h-full">
            <EmptyState
              icon="cable"
              title={t('daemonDownTitle')}
              subtitle={t('daemonDownSubtitle')}
              action={
                <Button variant="prominent" disabled={restarting} onClick={() => restartDaemon()}>
                  {restarting ? t('starting') : t('startDaemon')}
                </Button>
              }
            />
          </div>
        ) : (
        <div className="flex flex-col gap-6 px-4 py-4 mx-auto w-full" style={{ maxWidth: 720 }}>
          <Section title={t('supported')}>
            <Card>
              {detecting && !statuses.length && !detected.length ? (
                <SkeletonRows rows={6} label={t('detecting')} />
              ) : (
                sortedClients.map((c, i) => {
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
                      last={i === sortedClients.length - 1}
                      onConnect={() => handleConnect(c.name)}
                      onConnectWithLevel={(level) => handleConnect(c.name, level)}
                    />
                  );
                })
              )}
            </Card>
          </Section>

          <Section title={t('sessions')} count={sessions.length}>
            <Card>
              {loading && sessions.length === 0 ? (
                <SkeletonRows rows={2} label={t('loadingSessions')} />
              ) : sessions.length === 0 ? (
                <EmptyState
                  compact
                  icon="hub"
                  title={t('noSessionsTitle')}
                  subtitle={t('noSessionsSubtitle')}
                />
              ) : (
                sessions.map((c, i) => (
                  <ConnectedClientRow key={c.id} client={c} last={i === sessions.length - 1} />
                ))
              )}
            </Card>
          </Section>
        </div>
        )}
      </div>
    </div>
  );
}
