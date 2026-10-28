import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

type Connection = { kind: string; state: 'headers' | 'request' | 'idle'; requestId: number };

/** Records only route classes and lifecycle state; never URLs, peers, headers or bodies. */
export function trackHttpConnections(server: Server) {
  const connections = new Map<Socket, Connection>();

  server.on('connection', (socket: Socket) => {
    connections.set(socket, { kind: 'unknown', state: 'headers', requestId: 0 });
    socket.on('close', () => connections.delete(socket));
  });
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const connection = connections.get(req.socket);
    if (!connection) return;
    const path = (req.url ?? '').split('?', 1)[0];
    connection.kind =
      path === '/mcp'
        ? 'mcp'
        : path === '/api/events'
          ? 'events'
          : path === '/api/ask'
            ? 'ask'
            : 'other';
    connection.state = 'request';
    const requestId = ++connection.requestId;
    res.once('finish', () => {
      if (connections.get(req.socket) === connection && connection.requestId === requestId) {
        connection.state = 'idle';
      }
    });
  });

  return {
    get size() {
      return connections.size;
    },
    snapshot() {
      const counts: Record<string, number> = {};
      for (const { kind, state } of connections.values()) {
        const key = `${state}:${kind}`;
        counts[key] = (counts[key] ?? 0) + 1;
      }
      return counts;
    },
    /** An incomplete request has no application work to drain. */
    abortIncompleteHeaders() {
      for (const [socket, connection] of connections) {
        if (connection.state === 'headers') socket.destroy();
      }
    },
    /** Called only after the active-request grace period expires. */
    abortRemaining() {
      for (const socket of connections.keys()) socket.destroy();
    },
  };
}
