import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { trackHttpConnections } from '../../src/server/http-connection-tracker.js';

const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function listen(server: http.Server): Promise<number> {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as net.AddressInfo).port;
}

function connect(port: number): Promise<net.Socket> {
  const socket = net.connect(port, '127.0.0.1');
  return once(socket, 'connect').then(() => socket);
}

describe('HTTP shutdown connection tracking', () => {
  it('identifies and aborts a partial-header socket that closeIdleConnections leaves open', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    const tracker = trackHttpConnections(server);
    const port = await listen(server);
    const socket = await connect(port);
    socket.on('error', () => {});
    socket.write('GET /mcp HTTP/1.1\r\nHost: localhost\r\n');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(tracker.snapshot()).toEqual({ 'headers:unknown': 1 });

    let closed = false;
    const close = new Promise<void>((resolve) =>
      server.close(() => {
        closed = true;
        resolve();
      }),
    );
    server.closeIdleConnections();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(closed).toBe(false);
    tracker.abortIncompleteHeaders();
    await close;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(tracker.size).toBe(0);
    socket.destroy();
  });

  it.each(['/mcp?secret=hidden', '/api/events', '/api/ask'])(
    'classifies %s without recording its query and aborts a long stream',
    async (route) => {
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ready\n\n');
      });
      const tracker = trackHttpConnections(server);
      const port = await listen(server);
      const socket = await connect(port);
      socket.on('error', () => {});
      socket.write(`GET ${route} HTTP/1.1\r\nHost: localhost\r\n\r\n`);
      await once(socket, 'data');
      const kind = route.startsWith('/mcp') ? 'mcp' : route.slice(5);
      expect(tracker.snapshot()).toEqual({ [`request:${kind}`]: 1 });
      expect(JSON.stringify(tracker.snapshot())).not.toContain('secret');

      const close = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      tracker.abortRemaining();
      await close;
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(tracker.size).toBe(0);
      socket.destroy();
    },
  );

  it('lets an in-flight response finish during the grace period', async () => {
    let finish!: () => void;
    const server = http.createServer((_req, res) => {
      finish = () => res.end('done');
    });
    const tracker = trackHttpConnections(server);
    const port = await listen(server);
    const socket = await connect(port);
    socket.on('data', () => {});
    socket.write('GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(tracker.snapshot()).toEqual({ 'request:other': 1 });
    const close = new Promise<void>((resolve) => server.close(() => resolve()));
    finish();
    server.closeIdleConnections();
    await close;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(tracker.size).toBe(0);
    socket.destroy();
  });
});
