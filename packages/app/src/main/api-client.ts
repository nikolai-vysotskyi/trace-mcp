import http from 'http';

const DEFAULT_BASE = 'http://127.0.0.1:3741';

// ── Response types ──────────────────────────────────────────────────

export interface HealthResponse {
  status: 'ok';
  transport: string;
  uptime: number;
  pid: number;
  projects: { root: string; status: string }[];
}

export interface ProjectInfo {
  root: string;
  status: string;
  error?: string;
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

export interface SettingsResponse {
  settings: Record<string, unknown>;
  path: string;
  daemon: DaemonInfo;
}

// ── SSE event types ─────────────────────────────────────────────────

export type SSEEvent =
  | { type: 'project_status'; project: string; status: string; error?: string; progress?: ProgressSnapshot }
  | { type: 'indexing_progress'; project: string; phase: string; current: number; total: number }
  | { type: 'indexing_done'; project: string }
  | { type: 'client_connect'; clientId: string; transport: string; project?: string; name?: string }
  | { type: 'client_update'; clientId: string; project?: string; name?: string }
  | { type: 'client_disconnect'; clientId: string; project?: string };

export interface ProgressSnapshot {
  phase: string;
  current: number;
  total: number;
  percent: number;
}

// ── Client ──────────────────────────────────────────────────────────

export class DaemonClient {
  private base: string;

  constructor(base = DEFAULT_BASE) {
    this.base = base;
  }

  // GET /health
  async health(): Promise<HealthResponse> {
    return this.get<HealthResponse>('/health');
  }

  // GET /api/projects
  async listProjects(): Promise<ProjectInfo[]> {
    const res = await this.get<{ projects: ProjectInfo[] }>('/api/projects');
    return res.projects;
  }

  // POST /api/projects  { root: string }
  async addProject(root: string): Promise<{ status: string; project: string }> {
    return this.post<{ status: string; project: string }>('/api/projects', { root });
  }

  // DELETE /api/projects?project=<root>
  async removeProject(root: string): Promise<{ status: string; project: string }> {
    return this.delete<{ status: string; project: string }>(`/api/projects?project=${encodeURIComponent(root)}`);
  }

  // POST /api/projects/reindex?project=<root>
  async reindexProject(root: string): Promise<{ status: string; project: string }> {
    return this.post<{ status: string; project: string }>(`/api/projects/reindex?project=${encodeURIComponent(root)}`);
  }

  // GET /api/clients
  async listClients(): Promise<ClientInfo[]> {
    const res = await this.get<{ clients: ClientInfo[] }>('/api/clients');
    return res.clients;
  }

  // GET /api/settings
  async getSettings(): Promise<SettingsResponse> {
    return this.get<SettingsResponse>('/api/settings');
  }

  // PUT /api/settings
  async updateSettings(settings: Record<string, unknown>): Promise<{ status: string; settings: Record<string, unknown> }> {
    return this.put<{ status: string; settings: Record<string, unknown> }>('/api/settings', settings);
  }

  // GET /api/events — SSE stream
  subscribeEvents(onEvent: (event: SSEEvent) => void, onError?: (err: Error) => void): () => void {
    const url = new URL('/api/events', this.base);
    const req = http.get(url, (res) => {
      let buffer = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          if (part.startsWith(': ')) continue; // ping comment
          const dataLine = part.split('\n').find((l) => l.startsWith('data: '));
          if (!dataLine) continue;
          try {
            const event = JSON.parse(dataLine.slice(6)) as SSEEvent;
            onEvent(event);
          } catch { /* ignore malformed */ }
        }
      });
      res.on('error', (err) => onError?.(err));
    });

    req.on('error', (err) => onError?.(err));

    // Return unsubscribe function
    return () => { req.destroy(); };
  }

  // ── HTTP helpers ────────────────────────────────────────────────────

  private async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  private async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  private async put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  private async delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.base);
      const payload = body ? JSON.stringify(body) : undefined;

      const req = http.request(url, {
        method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
        timeout: 5000,
      }, (res) => {
        let data = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            return;
          }
          try {
            resolve(JSON.parse(data) as T);
          } catch {
            reject(new Error(`Invalid JSON: ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });

      if (payload) req.write(payload);
      req.end();
    });
  }
}
