import { useCallback, useEffect, useRef, useState } from 'react';

// ── Types (mirrored from api-client.ts — renderer can't import main process modules) ──

export interface ProjectInfo {
  root: string;
  status: string;
  error?: string;
}

export interface ProgressSnapshot {
  phase: string;
  current: number;
  total: number;
  percent: number;
}

export interface ProjectState extends ProjectInfo {
  progress?: ProgressSnapshot;
}

export interface ClientInfo {
  id: string;
  name?: string;
  transport: string;
  project?: string;
  connectedAt: string;
  lastSeen: string;
}

export interface DaemonInfo {
  port: number;
  host: string;
  log_path: string;
  uptime: number;
  pid: number;
}

export interface SettingsData {
  logLevel: string;
  [key: string]: unknown;
}

export interface SettingsState {
  settings: SettingsData;
  path: string;
  daemon: DaemonInfo;
}

type SSEEvent =
  | {
      type: 'project_status';
      project: string;
      status: string;
      error?: string;
      progress?: ProgressSnapshot;
    }
  | {
      type: 'indexing_progress';
      project: string;
      phase: string;
      current?: number;
      processed?: number;
      total: number;
    }
  | { type: 'indexing_done'; project: string }
  | { type: 'client_connect'; clientId: string; transport: string; project?: string; name?: string }
  | { type: 'client_update'; clientId: string; project?: string; name?: string }
  | { type: 'client_disconnect'; clientId: string; project?: string }
  // R09 v2 — pipeline-lifecycle events. Source of truth: DaemonEvent
  // union in src/cli.ts. Keep these shapes in sync.
  | { type: 'reindex_started'; project: string; pipeline: string; total_files?: number }
  | {
      type: 'reindex_completed';
      project: string;
      pipeline: string;
      duration_ms: number;
      summary?: Record<string, unknown>;
    }
  | { type: 'reindex_errored'; project: string; pipeline: string; message: string }
  | { type: 'embed_started'; project: string; total?: number }
  | { type: 'embed_progress'; project: string; processed: number; total: number }
  | { type: 'embed_completed'; project: string; duration_ms: number; embedded: number }
  | {
      type: 'snapshot_created';
      project: string;
      name: string;
      summary?: Record<string, unknown>;
    };

// ── Constants ──────────────────────────────────────────────────────────

const BASE = 'http://127.0.0.1:3741';

// ── Hook ───────────────────────────────────────────────────────────────

export function useDaemon() {
  const [projects, setProjects] = useState<ProjectState[]>([]);
  const [clients, setClients] = useState<ClientInfo[]>([]);
  const [settings, setSettings] = useState<SettingsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Fetch project list
  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/api/projects`);
      if (!res.ok) throw new Error(res.statusText);
      const json = await res.json();
      const data: ProjectInfo[] = json.projects ?? json;
      setProjects(data.map((p) => ({ ...p })));
      setConnected(true);
    } catch {
      setConnected(false);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch client list
  const fetchClients = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/api/clients`);
      if (!res.ok) throw new Error(res.statusText);
      const json = await res.json();
      const data: ClientInfo[] = json.clients ?? json;
      setClients(data);
    } catch {
      // will retry on reconnect
    }
  }, []);

  // Fetch settings + daemon info
  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/api/settings`);
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      setSettings(data);
    } catch {
      // will retry on reconnect
    }
  }, []);

  // SSE subscription
  useEffect(() => {
    fetchProjects();
    fetchClients();
    fetchSettings();

    const es = new EventSource(`${BASE}/api/events`);
    eventSourceRef.current = es;

    es.onopen = () => {
      setConnected(true);
      // Re-fetch full state on reconnect — events during the gap are lost
      fetchClients();
      fetchProjects();
    };
    es.onerror = () => setConnected(false);

    es.onmessage = (msg) => {
      let event: SSEEvent;
      try {
        event = JSON.parse(msg.data);
      } catch {
        return;
      }

      if (event.type === 'project_status') {
        setProjects((prev) =>
          prev.map((p) =>
            p.root === event.project
              ? { ...p, status: event.status, error: event.error, progress: event.progress }
              : p,
          ),
        );
      } else if (event.type === 'indexing_progress') {
        const total = event.total || 1;
        const current = event.processed ?? event.current ?? 0;
        setProjects((prev) =>
          prev.map((p) =>
            p.root === event.project
              ? {
                  ...p,
                  status: 'indexing',
                  progress: {
                    phase: event.phase,
                    current,
                    total,
                    percent: Math.round((current / total) * 100),
                  },
                }
              : p,
          ),
        );
      } else if (event.type === 'indexing_done') {
        setProjects((prev) =>
          prev.map((p) =>
            p.root === event.project ? { ...p, status: 'ready', progress: undefined } : p,
          ),
        );
      } else if (event.type === 'client_connect') {
        const now = new Date().toISOString();
        setClients((prev) => {
          if (prev.some((c) => c.id === event.clientId)) return prev;
          return [
            ...prev,
            {
              id: event.clientId,
              name: event.name,
              transport: event.transport,
              project: event.project,
              connectedAt: now,
              lastSeen: now,
            },
          ];
        });
      } else if (event.type === 'client_update') {
        setClients((prev) =>
          prev.map((c) =>
            c.id === event.clientId
              ? { ...c, name: event.name ?? c.name, lastSeen: new Date().toISOString() }
              : c,
          ),
        );
      } else if (event.type === 'client_disconnect') {
        setClients((prev) => prev.filter((c) => c.id !== event.clientId));
      } else if (event.type === 'reindex_started') {
        // R09 v2: flip project to "indexing" so the UI shows a live
        // pipeline. Subsequent indexing_progress events fill in the
        // progress bar; reindex_completed/errored finalizes.
        setProjects((prev) =>
          prev.map((p) =>
            p.root === event.project ? { ...p, status: 'indexing', progress: undefined } : p,
          ),
        );
      } else if (event.type === 'reindex_completed') {
        setProjects((prev) =>
          prev.map((p) =>
            p.root === event.project ? { ...p, status: 'ready', progress: undefined } : p,
          ),
        );
      } else if (event.type === 'reindex_errored') {
        setProjects((prev) =>
          prev.map((p) =>
            p.root === event.project
              ? { ...p, status: 'error', error: event.message, progress: undefined }
              : p,
          ),
        );
      } else if (event.type === 'embed_progress') {
        // Surface embed progress as a virtual pipeline so the project
        // list shows live "embedding N / M" instead of a static state.
        const total = event.total || 1;
        const current = event.processed;
        setProjects((prev) =>
          prev.map((p) =>
            p.root === event.project
              ? {
                  ...p,
                  status: 'embedding',
                  progress: {
                    phase: 'embedding',
                    current,
                    total,
                    percent: Math.round((current / total) * 100),
                  },
                }
              : p,
          ),
        );
      } else if (event.type === 'embed_started') {
        setProjects((prev) =>
          prev.map((p) =>
            p.root === event.project
              ? {
                  ...p,
                  status: 'embedding',
                  progress: {
                    phase: 'embedding',
                    current: 0,
                    total: event.total ?? 0,
                    percent: 0,
                  },
                }
              : p,
          ),
        );
      } else if (event.type === 'embed_completed') {
        setProjects((prev) =>
          prev.map((p) =>
            p.root === event.project ? { ...p, status: 'ready', progress: undefined } : p,
          ),
        );
      }
      // snapshot_created is a one-shot informational event; Activity tab
      // renders it. No project-state mutation here.
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [fetchProjects, fetchClients, fetchSettings]);

  // Actions
  const addProject = useCallback(async (root: string) => {
    try {
      await fetch(`${BASE}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root }),
      });
      // Optimistic: add immediately, SSE will update status
      setProjects((prev) => [...prev, { root, status: 'pending' }]);
    } catch {
      // SSE will reconcile
    }
  }, []);

  const removeProject = useCallback(async (root: string) => {
    try {
      await fetch(`${BASE}/api/projects?project=${encodeURIComponent(root)}`, { method: 'DELETE' });
      setProjects((prev) => prev.filter((p) => p.root !== root));
    } catch {
      // SSE will reconcile
    }
  }, []);

  const reindexProject = useCallback(async (root: string) => {
    // Optimistic: set status to indexing immediately
    setProjects((prev) =>
      prev.map((p) => (p.root === root ? { ...p, status: 'indexing', progress: undefined } : p)),
    );
    try {
      await fetch(`${BASE}/api/projects/reindex?project=${encodeURIComponent(root)}`, {
        method: 'POST',
      });
    } catch {
      // Revert on failure
      setProjects((prev) =>
        prev.map((p) =>
          p.root === root && p.status === 'indexing' ? { ...p, status: 'ready' } : p,
        ),
      );
    }
  }, []);

  const [restarting, setRestarting] = useState(false);

  const restartDaemon = useCallback(async () => {
    const api = window.electronAPI;
    if (!api?.restartDaemon) return;

    setRestarting(true);
    try {
      await api.restartDaemon();
      // Poll until daemon is reachable (up to 10 seconds)
      let ready = false;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(500) });
          if (res.ok) {
            ready = true;
            break;
          }
        } catch {
          /* not ready yet */
        }
      }
      if (ready) {
        await fetchProjects();
        await fetchClients();
        await fetchSettings();
      } else {
        setConnected(false);
      }
    } catch {
      setConnected(false);
    } finally {
      setRestarting(false);
    }
  }, [fetchProjects, fetchClients, fetchSettings]);

  const updateSettings = useCallback(
    async (patch: Record<string, unknown>) => {
      try {
        await fetch(`${BASE}/api/settings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        await fetchSettings();
      } catch {
        // ignore
      }
    },
    [fetchSettings],
  );

  return {
    projects,
    clients,
    settings,
    loading,
    connected,
    restarting,
    addProject,
    removeProject,
    reindexProject,
    restartDaemon,
    updateSettings,
    fetchSettings,
    fetchClients,
  };
}
