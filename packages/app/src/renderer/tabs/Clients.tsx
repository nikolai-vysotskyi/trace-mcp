import { StatusDot } from '../components/StatusDot';
import { useDaemon, ClientInfo } from '../hooks/useDaemon';

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

function ClientRow({ client }: { client: ClientInfo }) {
  const status = clientStatus(client);

  return (
    <div
      className="flex items-center gap-2 px-2 py-1.5 rounded-md"
      style={{ background: 'var(--bg-secondary)' }}
    >
      <StatusDot status={status} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span
            className="text-xs font-medium truncate"
            style={{ color: 'var(--text-primary)' }}
          >
            {client.id}
          </span>
          <span
            className="text-[10px] shrink-0"
            style={{ color: 'var(--text-tertiary)' }}
          >
            {client.transport}
          </span>
        </div>
        {client.project && (
          <div
            className="text-[10px] truncate"
            style={{ color: 'var(--text-secondary)' }}
          >
            {client.project}
          </div>
        )}
      </div>
      <span
        className="text-[10px] shrink-0"
        style={{ color: 'var(--text-tertiary)' }}
      >
        {timeAgo(client.lastSeen)}
      </span>
    </div>
  );
}

export function Clients() {
  const { clients, loading, connected, restartDaemon } = useDaemon();

  if (!connected && !loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2">
        <div className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
          Daemon not reachable
        </div>
        <button
          onClick={() => restartDaemon()}
          className="text-[10px] px-3 py-1 rounded-md font-medium transition-colors"
          style={{ background: 'var(--accent)', color: '#fff' }}
        >
          Restart Daemon
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
        Connected Clients
      </h2>

      {loading ? (
        <div className="text-xs py-4 text-center" style={{ color: 'var(--text-tertiary)' }}>
          Loading…
        </div>
      ) : clients.length === 0 ? (
        <div className="text-xs py-4 text-center" style={{ color: 'var(--text-secondary)' }}>
          No MCP clients connected.
        </div>
      ) : (
        <div className="space-y-1">
          {clients.map((c) => (
            <ClientRow key={c.id} client={c} />
          ))}
        </div>
      )}
    </div>
  );
}
