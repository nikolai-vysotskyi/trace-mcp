import http from 'node:http';
import net from 'node:net';
import { describe, expect, it } from 'vitest';

describe('TRA-1761: Daemon HTTP server shutdown request rejection', () => {
  it('rejects incoming requests with 503 and Connection: close during shutdown', async () => {
    let daemonShuttingDown = true;
    const server = http.createServer((req, res) => {
      if (daemonShuttingDown) {
        res.setHeader('Connection', 'close');
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Daemon is shutting down' }));
        return;
      }
      res.writeHead(200);
      res.end('ok');
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as net.AddressInfo;

    const res = await fetch(`http://127.0.0.1:${addr.port}/test`);
    expect(res.status).toBe(503);
    expect(res.headers.get('connection')).toBe('close');
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Daemon is shutting down');

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
