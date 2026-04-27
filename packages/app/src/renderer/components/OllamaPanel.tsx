import { useCallback, useEffect, useRef, useState } from 'react';

/** Rendered at the bottom of the AI settings section when provider=ollama.
 *
 *  Shape: daemon status row + two lists (running now / installed). The lists
 *  auto-refresh every 2.5s but pause while a mutation is in-flight so the
 *  optimistic state doesn't get clobbered by a stale poll response.
 */

type Status = { running: boolean; version?: string; baseUrl: string; error?: string };

function fmtBytes(n: number | undefined): string {
  if (!n || n <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtExpires(iso: string | undefined): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 'expiring';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

export function OllamaPanel({ baseUrl }: { baseUrl?: string }) {
  const api = window.electronAPI?.ollama;
  const [status, setStatus] = useState<Status | null>(null);
  const [installed, setInstalled] = useState<OllamaInstalledModel[]>([]);
  const [running, setRunning] = useState<OllamaRunningModel[]>([]);
  const [busy, setBusy] = useState<string | null>(null); // key identifying which op is in-flight
  const [notice, setNotice] = useState<string | null>(null);
  const pollBusy = useRef(false);

  const refresh = useCallback(async () => {
    if (!api || pollBusy.current) return;
    pollBusy.current = true;
    try {
      const s = await api.status(baseUrl);
      setStatus(s);
      if (s.running) {
        const [inst, run] = await Promise.all([
          api.listInstalled(baseUrl),
          api.listRunning(baseUrl),
        ]);
        setInstalled(inst.models);
        setRunning(run.models);
      } else {
        setInstalled([]);
        setRunning([]);
      }
    } finally {
      pollBusy.current = false;
    }
  }, [api, baseUrl]);

  useEffect(() => {
    refresh();
    const id = setInterval(() => {
      if (!busy) refresh();
    }, 2500);
    return () => clearInterval(id);
  }, [refresh, busy]);

  const withBusy = async <T,>(key: string, fn: () => Promise<T>) => {
    setBusy(key);
    setNotice(null);
    try {
      return await fn();
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const onStart = () =>
    withBusy('daemon:start', async () => {
      const r = await api!.start(baseUrl);
      if (!r.ok) setNotice(`Start failed: ${r.error ?? 'unknown'}`);
    });
  const onStop = () =>
    withBusy('daemon:stop', async () => {
      const r = await api!.stop(baseUrl);
      if (!r.ok) setNotice(`Stop failed: ${r.error ?? 'unknown'}`);
    });
  const onUnload = (name: string) =>
    withBusy(`unload:${name}`, async () => {
      const r = await api!.unload(name, baseUrl);
      if (!r.ok) setNotice(`Unload failed: ${r.error ?? 'unknown'}`);
    });
  const onDelete = (name: string) => {
    if (!confirm(`Delete model "${name}"? This removes it from disk.`)) return;
    return withBusy(`delete:${name}`, async () => {
      const r = await api!.delete(name, baseUrl);
      if (!r.ok) setNotice(`Delete failed: ${r.error ?? 'unknown'}`);
    });
  };

  if (!api) {
    return (
      <div style={{ marginTop: 20, fontSize: 12, color: 'var(--text-tertiary)' }}>
        Ollama control is only available inside the trace-mcp app.
      </div>
    );
  }

  const dot = status?.running ? 'var(--success)' : 'var(--destructive)';

  return (
    <div style={{ marginTop: 20 }}>
      <div
        className="text-[10px] font-semibold uppercase tracking-wider"
        style={{ color: 'var(--text-tertiary)', marginBottom: 8 }}
      >
        Ollama
      </div>

      {/* Status + daemon controls */}
      <div
        style={{
          background: 'var(--bg-grouped)',
          borderRadius: 10,
          boxShadow: 'var(--shadow-grouped)',
          padding: '10px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <span style={{ width: 8, height: 8, borderRadius: 4, background: dot, flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>
            {status?.running ? `Running · ${status.version ?? 'unknown version'}` : 'Not running'}
          </div>
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-tertiary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {status?.baseUrl ?? baseUrl ?? 'http://localhost:11434'}
            {!status?.running && status?.error ? ` · ${status.error}` : ''}
          </div>
        </div>
        {status?.running ? (
          <Btn onClick={onStop} busy={busy === 'daemon:stop'} variant="destructive">
            Stop
          </Btn>
        ) : (
          <Btn onClick={onStart} busy={busy === 'daemon:start'} variant="primary">
            Start
          </Btn>
        )}
      </div>

      {notice && (
        <div
          style={{
            marginTop: 8,
            padding: '6px 10px',
            borderRadius: 6,
            fontSize: 11,
            background: 'var(--fill-control)',
            color: 'var(--destructive)',
          }}
        >
          {notice}
        </div>
      )}

      {/* Running models */}
      {status?.running && (
        <>
          <div
            className="text-[10px] font-semibold uppercase tracking-wider"
            style={{ color: 'var(--text-tertiary)', marginTop: 16, marginBottom: 8 }}
          >
            Loaded in memory ({running.length})
          </div>
          {running.length === 0 ? (
            <div
              style={{
                fontSize: 12,
                color: 'var(--text-tertiary)',
                padding: '8px 12px',
                background: 'var(--bg-grouped)',
                borderRadius: 10,
              }}
            >
              No models currently loaded.
            </div>
          ) : (
            <ModelList>
              {running.map((m, i) => (
                <Row key={m.name + i} last={i === running.length - 1}>
                  <RowInfo
                    title={m.name}
                    subtitle={[
                      `${fmtBytes(m.size_vram)} VRAM`,
                      m.size > m.size_vram ? `${fmtBytes(m.size - m.size_vram)} RAM` : null,
                      fmtExpires(m.expires_at) ? `unload in ${fmtExpires(m.expires_at)}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  />
                  <Btn onClick={() => onUnload(m.name)} busy={busy === `unload:${m.name}`}>
                    Unload
                  </Btn>
                </Row>
              ))}
            </ModelList>
          )}

          {/* Installed models */}
          <div
            className="text-[10px] font-semibold uppercase tracking-wider"
            style={{ color: 'var(--text-tertiary)', marginTop: 16, marginBottom: 8 }}
          >
            Installed on disk ({installed.length})
          </div>
          {installed.length === 0 ? (
            <div
              style={{
                fontSize: 12,
                color: 'var(--text-tertiary)',
                padding: '8px 12px',
                background: 'var(--bg-grouped)',
                borderRadius: 10,
              }}
            >
              No models installed. Run <code>ollama pull &lt;name&gt;</code> in a terminal.
            </div>
          ) : (
            <ModelList>
              {installed.map((m, i) => (
                <Row key={m.name + i} last={i === installed.length - 1}>
                  <RowInfo
                    title={m.name}
                    subtitle={[
                      fmtBytes(m.size),
                      m.details?.parameter_size,
                      m.details?.quantization_level,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  />
                  <Btn
                    onClick={() => onDelete(m.name)}
                    busy={busy === `delete:${m.name}`}
                    variant="destructive"
                  >
                    Delete
                  </Btn>
                </Row>
              ))}
            </ModelList>
          )}
        </>
      )}
    </div>
  );
}

// ── Small presentational primitives, local to this file ──

function ModelList({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--bg-grouped)',
        borderRadius: 10,
        boxShadow: 'var(--shadow-grouped)',
        overflow: 'hidden',
      }}
    >
      {children}
    </div>
  );
}

function Row({ children, last }: { children: React.ReactNode; last: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 12px',
        minHeight: 36,
        borderBottom: last ? 'none' : '1px solid var(--border-row)',
      }}
    >
      {children}
    </div>
  );
}

function RowInfo({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div
        style={{
          fontSize: 13,
          color: 'var(--text-primary)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {title}
      </div>
      {subtitle && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--text-tertiary)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {subtitle}
        </div>
      )}
    </div>
  );
}

function Btn({
  children,
  onClick,
  busy,
  variant,
}: {
  children: React.ReactNode;
  onClick: () => void;
  busy?: boolean;
  variant?: 'primary' | 'destructive';
}) {
  const color =
    variant === 'destructive'
      ? 'var(--destructive)'
      : variant === 'primary'
        ? '#fff'
        : 'var(--text-primary)';
  const bg = variant === 'primary' ? 'var(--accent)' : 'var(--fill-control)';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      style={{
        fontSize: 11,
        fontWeight: 500,
        padding: '4px 10px',
        borderRadius: 6,
        background: bg,
        color,
        border: '0.5px solid var(--border)',
        cursor: busy ? 'default' : 'pointer',
        opacity: busy ? 0.5 : 1,
        flexShrink: 0,
      }}
    >
      {busy ? '…' : children}
    </button>
  );
}
