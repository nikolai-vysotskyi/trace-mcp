import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { t } from '../i18n';
import { Button, ConfirmPopover, EmptyState, StatusDot } from '../lattice/ui';

/** Rendered at the bottom of the AI settings section when provider=ollama.
 *
 *  Shape: daemon status row + two lists (running now / installed). The lists
 *  auto-refresh every 2.5s but pause while a mutation is in-flight so the
 *  optimistic state doesn't get clobbered by a stale poll response.
 *
 *  Migrated onto the macOS 26 layer with the rest of Settings (TRA-295): the
 *  local 11px/6px-radius `Btn` is the Lattice Button, separators are 0.5px
 *  hairlines, section captions match the surface's 11px sentence-case form
 *  instead of 10px ALL CAPS, and deleting a model asks in a popover rather
 *  than a blocking `window.confirm`.
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
  if (!Number.isFinite(ms) || ms <= 0) return t('guard:ollama.expiring');
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

export function OllamaPanel({ baseUrl }: { baseUrl?: string }) {
  /* Subscribes the panel to language changes; strings resolve through the
     module-level `t`, which the helpers above share. */
  useTranslation('guard');
  const api = window.electronAPI?.ollama;
  const [status, setStatus] = useState<Status | null>(null);
  const [installed, setInstalled] = useState<OllamaInstalledModel[]>([]);
  const [running, setRunning] = useState<OllamaRunningModel[]>([]);
  const [busy, setBusy] = useState<string | null>(null); // key identifying which op is in-flight
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ name: string; x: number; y: number } | null>(
    null,
  );
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
      if (!r.ok)
        setNotice(
          t('guard:ollama.startFailed', { error: r.error ?? t('guard:ollama.unknownError') }),
        );
    });
  const onStop = () =>
    withBusy('daemon:stop', async () => {
      const r = await api!.stop(baseUrl);
      if (!r.ok)
        setNotice(t('guard:ollama.stopFailed', { error: r.error ?? t('guard:ollama.unknownError') }));
    });
  const onUnload = (name: string) =>
    withBusy(`unload:${name}`, async () => {
      const r = await api!.unload(name, baseUrl);
      if (!r.ok)
        setNotice(
          t('guard:ollama.unloadFailed', {
            name,
            error: r.error ?? t('guard:ollama.unknownError'),
          }),
        );
    });
  const onDelete = (name: string) =>
    withBusy(`delete:${name}`, async () => {
      const r = await api!.delete(name, baseUrl);
      if (!r.ok)
        setNotice(
          t('guard:ollama.deleteFailed', {
            name,
            error: r.error ?? t('guard:ollama.unknownError'),
          }),
        );
    });

  if (!api) {
    return (
      <p className="text-[13px] leading-4 px-1" style={{ color: 'var(--label-secondary)' }}>
        {t('guard:ollama.unavailable')}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Section title={t('guard:ollama.title')}>
        <Card>
          <div className="flex items-center gap-2.5 px-3" style={{ minHeight: 44 }}>
            <StatusDot
              tone={status?.running ? 'green' : 'neutral'}
              title={t(status?.running ? 'guard:ollama.runningShort' : 'guard:ollama.notRunning')}
            />
            <div className="flex-1 min-w-0">
              <div className="text-[13px] leading-4" style={{ color: 'var(--label)' }}>
                {status?.running
                  ? t('guard:ollama.running', {
                      version: status.version ?? t('guard:ollama.unknownVersion'),
                    })
                  : t('guard:ollama.notRunning')}
              </div>
              <div
                className="text-[11px] leading-[13px] truncate"
                style={{ color: 'var(--label-secondary)' }}
              >
                {status?.baseUrl ?? baseUrl ?? 'http://localhost:11434'}
                {!status?.running && status?.error ? ` · ${status.error}` : ''}
              </div>
            </div>
            {status?.running ? (
              <Button size="small" disabled={busy === 'daemon:stop'} onClick={onStop}>
                {t(busy === 'daemon:stop' ? 'guard:ollama.stopping' : 'guard:ollama.stop')}
              </Button>
            ) : (
              <Button size="small" disabled={busy === 'daemon:start'} onClick={onStart}>
                {t(busy === 'daemon:start' ? 'guard:ollama.starting' : 'guard:ollama.start')}
              </Button>
            )}
          </div>
        </Card>
      </Section>

      {notice && (
        <p
          className="text-[13px] leading-4 px-1"
          style={{ color: 'var(--status-red)' }}
          role="alert"
        >
          {notice}
        </p>
      )}

      {status?.running && (
        <>
          <Section title={t('guard:ollama.loadedTitle')} count={running.length}>
            <Card>
              {running.length === 0 ? (
                <EmptyState
                  compact
                  icon="database"
                  title={t('guard:ollama.loadedEmptyTitle')}
                  subtitle={t('guard:ollama.loadedEmptyBody')}
                />
              ) : (
                running.map((m, i) => (
                  <Row
                    key={m.name}
                    last={i === running.length - 1}
                    title={m.name}
                    subtitle={[
                      t('guard:ollama.vram', { size: fmtBytes(m.size_vram) }),
                      m.size > m.size_vram
                        ? t('guard:ollama.ram', { size: fmtBytes(m.size - m.size_vram) })
                        : null,
                      fmtExpires(m.expires_at)
                        ? t('guard:ollama.unloadIn', { time: fmtExpires(m.expires_at) })
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    action={
                      <Button
                        size="small"
                        disabled={busy === `unload:${m.name}`}
                        onClick={() => onUnload(m.name)}
                      >
                        {t(
                          busy === `unload:${m.name}`
                            ? 'guard:ollama.unloading'
                            : 'guard:ollama.unload',
                        )}
                      </Button>
                    }
                  />
                ))
              )}
            </Card>
          </Section>

          <Section title={t('guard:ollama.installedTitle')} count={installed.length}>
            <Card>
              {installed.length === 0 ? (
                <EmptyState
                  compact
                  icon="database"
                  title={t('guard:ollama.installedEmptyTitle')}
                  subtitle={t('guard:ollama.installedEmptyBody')}
                />
              ) : (
                installed.map((m, i) => (
                  <Row
                    key={m.name}
                    last={i === installed.length - 1}
                    title={m.name}
                    subtitle={[
                      fmtBytes(m.size),
                      m.details?.parameter_size,
                      m.details?.quantization_level,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    action={
                      <Button
                        size="small"
                        disabled={busy === `delete:${m.name}`}
                        onClick={(e) => {
                          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          setConfirmDelete({ name: m.name, x: r.right, y: r.bottom + 4 });
                        }}
                      >
                        {t(
                          busy === `delete:${m.name}`
                            ? 'guard:ollama.deleting'
                            : 'guard:ollama.delete',
                        )}
                      </Button>
                    }
                  />
                ))
              )}
            </Card>
          </Section>
        </>
      )}

      {/* A blocking window.confirm() is not a macOS affordance for a row
          action. The popover names the object it destroys, per ux-writing. */}
      {confirmDelete && (
        <ConfirmPopover
          x={confirmDelete.x}
          y={confirmDelete.y}
          align="end"
          danger
          title={t('guard:ollama.confirmTitle', { name: confirmDelete.name })}
          body={t('guard:ollama.confirmBody')}
          confirmLabel={t('guard:ollama.confirmAction')}
          onConfirm={() => {
            const { name } = confirmDelete;
            setConfirmDelete(null);
            onDelete(name);
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}

// ── Local presentation, matching the Settings surface it renders inside ──

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

function Row({
  title,
  subtitle,
  action,
  last,
}: {
  title: string;
  subtitle?: string;
  action: React.ReactNode;
  last: boolean;
}) {
  return (
    <div
      className="flex items-center gap-2.5 px-3"
      style={{ minHeight: 44, borderBottom: last ? 'none' : '0.5px solid var(--separator)' }}
    >
      <div className="flex-1 min-w-0">
        <div className="text-[13px] leading-4 truncate" style={{ color: 'var(--label)' }}>
          {title}
        </div>
        {subtitle && (
          <div
            className="text-[11px] leading-[13px] truncate"
            style={{ color: 'var(--label-secondary)' }}
          >
            {subtitle}
          </div>
        )}
      </div>
      {action}
    </div>
  );
}
