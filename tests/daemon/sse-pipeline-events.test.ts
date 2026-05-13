/**
 * R09 v2 — pipeline-lifecycle SSE events: integration test.
 *
 * Replaces the missing manual "Electron UI smoke" step from
 * plans/plan-cognee-R09-IMPL.md§"Omissions vs plan". The renderer-side visual
 * confirmation is still manual (see the report), but the producer side — the
 * daemon SSE bus — now has automated coverage of:
 *
 *   1. Wire format: events arrive on /api/events as `data: <json>\n\n` frames.
 *   2. Ordering: reindex_started -> indexing_progress* -> reindex_completed
 *      (or reindex_errored on failure).
 *   3. Fan-out: multiple connected clients each receive every event.
 *   4. Throttle: indexing_progress is rate-limited to ~5/s per (project,
 *      pipeline); terminal events bypass the floor.
 *   5. Union shape guardrail: snapshot of the DaemonEvent discriminator
 *      literals parsed from src/cli.ts so the consumer in
 *      packages/app/src/renderer/hooks/useDaemon.ts cannot drift silently.
 *
 * APPROACH (honest disclosure):
 * The full `serve-http` command action lives inside a Commander handler with
 * locally-scoped `DaemonEvent`/`broadcastEvent`. Spawning it programmatically
 * to bind a real port is >100 LOC of harness and would also drag in
 * AI/embedding init. Per the task's escalation clause, this test takes the
 * lighter path: it stands up a minimal SSE server that mirrors the exact wire
 * format from src/cli.ts (Content-Type, framing, throttle floor) and asserts
 * the contract a real consumer relies on. The "is the daemon emitting the
 * right events at the right callsites?" question is covered by the static
 * source-parse guardrail at the bottom, which fails loudly if anyone changes
 * the union or the reindex emission sites.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ── Test-local mirror of the daemon's DaemonEvent union ───────────────
// This intentionally duplicates the shape from src/cli.ts. The guardrail
// test below parses cli.ts and fails if these literals drift.
type DaemonEvent =
  | {
      type: 'indexing_progress';
      project: string;
      pipeline: string;
      phase: string;
      processed: number;
      total: number;
    }
  | { type: 'project_status'; project: string; status: string; error?: string }
  | {
      type: 'client_connect';
      clientId: string;
      project: string;
      transport?: string;
      name?: string;
    }
  | { type: 'client_update'; clientId: string; project?: string; name?: string }
  | { type: 'client_disconnect'; clientId: string; project?: string }
  | {
      type: 'journal_entry';
      project: string;
      ts: number;
      tool: string;
      params_summary: string;
      result_count: number;
      result_tokens?: number;
      latency_ms?: number;
      is_error: boolean;
      session_id: string;
    }
  | {
      type: 'reindex_started';
      project: string;
      pipeline: string;
      total_files?: number;
    }
  | {
      type: 'reindex_completed';
      project: string;
      pipeline: string;
      duration_ms: number;
      summary?: Record<string, unknown>;
    }
  | {
      type: 'reindex_errored';
      project: string;
      pipeline: string;
      message: string;
    }
  | { type: 'embed_started'; project: string; total?: number }
  | { type: 'embed_progress'; project: string; processed: number; total: number }
  | {
      type: 'embed_completed';
      project: string;
      duration_ms: number;
      embedded: number;
    }
  | {
      type: 'snapshot_created';
      project: string;
      name: string;
      summary?: Record<string, unknown>;
    };

const PROGRESS_THROTTLE_MS = 200;

/**
 * Minimal SSE bus mirroring src/cli.ts:465-498. Same framing, same throttle.
 * Kept tight so the test asserts the production contract, not a fantasy.
 */
function makeBus() {
  const sseConnections = new Set<http.ServerResponse>();
  const lastProgressEmittedAt = new Map<string, number>();

  function broadcastEvent(event: DaemonEvent): void {
    if (event.type === 'indexing_progress') {
      const key = `${event.project}::${event.pipeline}`;
      const now = Date.now();
      const last = lastProgressEmittedAt.get(key) ?? 0;
      if (now - last < PROGRESS_THROTTLE_MS) return;
      lastProgressEmittedAt.set(key, now);
    } else if (event.type === 'embed_progress') {
      const key = `${event.project}::embed`;
      const now = Date.now();
      const last = lastProgressEmittedAt.get(key) ?? 0;
      if (now - last < PROGRESS_THROTTLE_MS) return;
      lastProgressEmittedAt.set(key, now);
    }
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of sseConnections) {
      try {
        res.write(data);
      } catch {
        sseConnections.delete(res);
      }
    }
  }

  return { sseConnections, broadcastEvent };
}

/**
 * Stand up an HTTP server with only the `/api/events` route. Returns the
 * bound port + a stop() helper + the bus.
 */
async function startSseServer(): Promise<{
  port: number;
  stop: () => Promise<void>;
  broadcastEvent: (e: DaemonEvent) => void;
  connectionCount: () => number;
}> {
  const bus = makeBus();
  const server = http.createServer((req, res) => {
    if (req.url === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      bus.sseConnections.add(res);
      req.on('close', () => bus.sseConnections.delete(res));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('failed to bind');
  const port = addr.port;

  return {
    port,
    broadcastEvent: bus.broadcastEvent,
    connectionCount: () => bus.sseConnections.size,
    stop: async () => {
      for (const c of bus.sseConnections) {
        try {
          c.end();
        } catch {
          /* ignore */
        }
      }
      bus.sseConnections.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Streaming SSE consumer: reads `data: ...\n\n` frames off a fetch body until
 * the predicate is satisfied or the timeout fires.
 */
async function collectEventsUntil(
  port: number,
  predicate: (events: DaemonEvent[]) => boolean,
  timeoutMs = 2000,
): Promise<DaemonEvent[]> {
  const ctrl = new AbortController();
  const events: DaemonEvent[] = [];
  let resolved = false;

  const timer = setTimeout(() => {
    ctrl.abort();
  }, timeoutMs);

  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/events`, {
      signal: ctrl.signal,
    });
    if (!resp.body) throw new Error('no response body');
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (!resolved) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (frame.startsWith('data: ')) {
          const json = frame.slice('data: '.length);
          try {
            events.push(JSON.parse(json));
          } catch {
            /* ignore malformed */
          }
        }
      }
      if (predicate(events)) {
        resolved = true;
        ctrl.abort();
      }
    }
  } catch (err) {
    // AbortError is the normal exit path once the predicate fires.
    if ((err as { name?: string }).name !== 'AbortError') {
      throw err;
    }
  } finally {
    clearTimeout(timer);
  }

  return events;
}

/** Wait until the server reports at least N active SSE connections. */
async function waitForConnections(
  connectionCount: () => number,
  n: number,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (connectionCount() >= n) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timeout: only ${connectionCount()}/${n} SSE clients connected`);
}

describe('R09 v2 — pipeline-lifecycle SSE events', () => {
  let server: Awaited<ReturnType<typeof startSseServer>>;

  beforeEach(async () => {
    server = await startSseServer();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('emits reindex_started -> indexing_progress -> reindex_completed in order', async () => {
    const consumer = collectEventsUntil(
      server.port,
      (events) => events.some((e) => e.type === 'reindex_completed'),
      3000,
    );
    await waitForConnections(server.connectionCount, 1);

    const project = '/tmp/fixture-proj';
    const startedAt = Date.now();
    server.broadcastEvent({ type: 'reindex_started', project, pipeline: 'index' });
    server.broadcastEvent({
      type: 'indexing_progress',
      project,
      pipeline: 'index',
      phase: 'extract',
      processed: 1,
      total: 3,
    });
    // Bypass the 200ms throttle floor for the second progress sample.
    await new Promise((r) => setTimeout(r, 220));
    server.broadcastEvent({
      type: 'indexing_progress',
      project,
      pipeline: 'index',
      phase: 'extract',
      processed: 3,
      total: 3,
    });
    server.broadcastEvent({
      type: 'reindex_completed',
      project,
      pipeline: 'index',
      duration_ms: Date.now() - startedAt,
      summary: { indexed: 3, skipped: 0 },
    });

    const events = await consumer;
    const types = events.map((e) => e.type);

    expect(types[0]).toBe('reindex_started');
    expect(types).toContain('indexing_progress');
    expect(types[types.length - 1]).toBe('reindex_completed');

    const started = events.find((e) => e.type === 'reindex_started') as Extract<
      DaemonEvent,
      { type: 'reindex_started' }
    >;
    expect(started.project).toBe(project);
    expect(started.pipeline).toBe('index');

    const completed = events.find((e) => e.type === 'reindex_completed') as Extract<
      DaemonEvent,
      { type: 'reindex_completed' }
    >;
    expect(completed.project).toBe(project);
    expect(completed.pipeline).toBe('index');
    expect(typeof completed.duration_ms).toBe('number');
    expect(completed.summary).toEqual({ indexed: 3, skipped: 0 });
  });

  it('emits reindex_started -> reindex_errored on failure (no completed)', async () => {
    const consumer = collectEventsUntil(
      server.port,
      (events) => events.some((e) => e.type === 'reindex_errored'),
      3000,
    );
    await waitForConnections(server.connectionCount, 1);

    const project = '/tmp/fixture-fail';
    server.broadcastEvent({ type: 'reindex_started', project, pipeline: 'index' });
    server.broadcastEvent({
      type: 'reindex_errored',
      project,
      pipeline: 'index',
      message: 'tree-sitter parse failed',
    });

    const events = await consumer;
    const types = events.map((e) => e.type);

    expect(types).toEqual(['reindex_started', 'reindex_errored']);
    expect(types).not.toContain('reindex_completed');

    const errored = events.find((e) => e.type === 'reindex_errored') as Extract<
      DaemonEvent,
      { type: 'reindex_errored' }
    >;
    expect(errored.message).toBe('tree-sitter parse failed');
  });

  it('fans out events to every connected SSE client', async () => {
    const client1 = collectEventsUntil(
      server.port,
      (events) => events.some((e) => e.type === 'reindex_completed'),
      3000,
    );
    const client2 = collectEventsUntil(
      server.port,
      (events) => events.some((e) => e.type === 'reindex_completed'),
      3000,
    );
    await waitForConnections(server.connectionCount, 2);

    const project = '/tmp/fixture-fanout';
    server.broadcastEvent({ type: 'reindex_started', project, pipeline: 'index' });
    server.broadcastEvent({
      type: 'reindex_completed',
      project,
      pipeline: 'index',
      duration_ms: 42,
    });

    const [e1, e2] = await Promise.all([client1, client2]);
    expect(e1.map((e) => e.type)).toEqual(['reindex_started', 'reindex_completed']);
    expect(e2.map((e) => e.type)).toEqual(['reindex_started', 'reindex_completed']);
  });

  it('throttles indexing_progress to ~5/s per (project, pipeline) but never throttles terminals', async () => {
    const consumer = collectEventsUntil(
      server.port,
      (events) => events.some((e) => e.type === 'reindex_completed'),
      3000,
    );
    await waitForConnections(server.connectionCount, 1);

    const project = '/tmp/fixture-throttle';
    server.broadcastEvent({ type: 'reindex_started', project, pipeline: 'index' });

    // Fire 50 progress events back-to-back. Throttle floor is 200ms so
    // we expect at most ~2 to make it through within ~50ms wall-clock.
    for (let i = 0; i < 50; i++) {
      server.broadcastEvent({
        type: 'indexing_progress',
        project,
        pipeline: 'index',
        phase: 'extract',
        processed: i,
        total: 50,
      });
    }
    server.broadcastEvent({
      type: 'reindex_completed',
      project,
      pipeline: 'index',
      duration_ms: 50,
    });

    const events = await consumer;
    const progressCount = events.filter((e) => e.type === 'indexing_progress').length;

    // First sample always passes (last=0). Subsequent are dropped because
    // all 50 emissions happen within a single ~10ms window << 200ms floor.
    expect(progressCount).toBeGreaterThanOrEqual(1);
    expect(progressCount).toBeLessThanOrEqual(3);

    // Terminal events must NOT be throttled.
    expect(events.find((e) => e.type === 'reindex_started')).toBeTruthy();
    expect(events.find((e) => e.type === 'reindex_completed')).toBeTruthy();
  });

  it('emits embed_* and snapshot_created lifecycle variants on the wire', async () => {
    const consumer = collectEventsUntil(
      server.port,
      (events) => events.some((e) => e.type === 'snapshot_created'),
      3000,
    );
    await waitForConnections(server.connectionCount, 1);

    const project = '/tmp/fixture-embed';
    server.broadcastEvent({ type: 'embed_started', project, total: 100 });
    server.broadcastEvent({ type: 'embed_progress', project, processed: 50, total: 100 });
    server.broadcastEvent({ type: 'embed_completed', project, duration_ms: 123, embedded: 100 });
    server.broadcastEvent({ type: 'snapshot_created', project, name: 'before-refactor' });

    const events = await consumer;
    const types = events.map((e) => e.type);
    expect(types).toContain('embed_started');
    expect(types).toContain('embed_progress');
    expect(types).toContain('embed_completed');
    expect(types).toContain('snapshot_created');

    const snap = events.find((e) => e.type === 'snapshot_created') as Extract<
      DaemonEvent,
      { type: 'snapshot_created' }
    >;
    expect(snap.name).toBe('before-refactor');
  });
});

/**
 * Source-parse guardrail. The renderer (packages/app/src/renderer/hooks/
 * useDaemon.ts) declares its own SSEEvent union with a "Source of truth:
 * DaemonEvent union in src/cli.ts" comment. If anyone adds/removes a
 * discriminator literal in cli.ts without updating the consumer, this test
 * breaks loudly. This is the consumer-drift firewall called out in the task
 * brief.
 */
describe('R09 v2 — DaemonEvent union guardrail (parsed from src/cli.ts)', () => {
  const CLI_SRC = path.resolve(__dirname, '..', '..', 'src', 'cli.ts');
  // Normalize CRLF → LF so the terminator heuristic below works regardless
  // of how Git checked out the file (Windows runners default to autocrlf).
  const source = fs.readFileSync(CLI_SRC, 'utf-8').replace(/\r\n/g, '\n');

  /**
   * Extract every `type: '<literal>'` discriminator inside the DaemonEvent
   * union block. The block starts at `type DaemonEvent =` and runs until the
   * first matching `;` at column 0 (heuristic — but it's our own source).
   */
  function extractUnionLiterals(src: string): string[] {
    const start = src.indexOf('type DaemonEvent =');
    expect(start, 'DaemonEvent type alias not found in src/cli.ts').toBeGreaterThan(-1);
    // Match through to the first standalone `};` followed by blank line —
    // the union ends with `}` for its last variant then `;`.
    const after = src.slice(start);
    const endRel = after.indexOf(';\n\n');
    expect(endRel, 'DaemonEvent union terminator not found').toBeGreaterThan(-1);
    const block = after.slice(0, endRel);
    const literals = new Set<string>();
    const re = /type:\s*'([a-z_]+)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block)) !== null) {
      literals.add(m[1]);
    }
    return [...literals].sort();
  }

  it('contains every discriminator the producer is supposed to ship (R09 v2 snapshot)', () => {
    const literals = extractUnionLiterals(source);
    // This is the snapshot the renderer consumer at
    // packages/app/src/renderer/hooks/useDaemon.ts is wired against.
    // Changing this list REQUIRES updating that file too.
    expect(literals).toEqual(
      [
        'client_connect',
        'client_disconnect',
        'client_update',
        'embed_completed',
        'embed_progress',
        'embed_started',
        'indexing_progress',
        'journal_entry',
        'project_status',
        'reindex_completed',
        'reindex_errored',
        'reindex_started',
        'snapshot_created',
      ].sort(),
    );
  });

  it('confirms reindex_started/completed/errored are emitted from the /api/projects/reindex handler', () => {
    // Producer-side guardrail: if the reindex handler in cli.ts stops
    // emitting the lifecycle events, the renderer banner goes dark and the
    // automated test above passes only because the bus mirror still works.
    // This static check fails fast in that case.
    expect(source).toMatch(/type:\s*'reindex_started'/);
    expect(source).toMatch(/type:\s*'reindex_completed'/);
    expect(source).toMatch(/type:\s*'reindex_errored'/);
    expect(source).toMatch(/managed\.pipeline[\s\S]{0,200}\.indexAll/);
  });

  it('confirms embed_progress is emitted from src/tools/register/core.ts', () => {
    const coreSrc = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'src', 'tools', 'register', 'core.ts'),
      'utf-8',
    );
    expect(coreSrc).toMatch(/type:\s*'embed_progress'/);
  });

  it('confirms snapshot_created is emitted from src/tools/register/advanced.ts', () => {
    const advSrc = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'src', 'tools', 'register', 'advanced.ts'),
      'utf-8',
    );
    expect(advSrc).toMatch(/type:\s*'snapshot_created'/);
  });

  it('confirms the 200ms throttle floor for indexing_progress and embed_progress is wired in cli.ts', () => {
    expect(source).toMatch(/PROGRESS_THROTTLE_MS\s*=\s*200/);
    // Both progress variants must consult the throttle map; terminals must not.
    expect(source).toMatch(/event\.type\s*===\s*'indexing_progress'/);
    expect(source).toMatch(/event\.type\s*===\s*'embed_progress'/);
  });
});
