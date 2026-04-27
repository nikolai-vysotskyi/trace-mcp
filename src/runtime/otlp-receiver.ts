/**
 * Minimal OTLP/HTTP JSON receiver using node:http.
 * Accepts POST /v1/traces with application/json body.
 * Zero external dependencies.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { logger } from '../logger.js';
import type { OtlpExportRequest } from './types.js';

interface OtlpReceiverOptions {
  host: string;
  port: number;
  maxBodyBytes: number;
  onSpans: (request: OtlpExportRequest) => void;
}

export class OtlpReceiver {
  private server: Server | null = null;

  constructor(private options: OtlpReceiverOptions) {}

  async start(): Promise<void> {
    if (this.options.port === 0) return; // disabled

    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));

      this.server.on('error', (err) => {
        logger.error({ error: err }, 'OTLP receiver error');
        reject(err);
      });

      this.server.listen(this.options.port, this.options.host, () => {
        logger.info({ host: this.options.host, port: this.options.port }, 'OTLP receiver started');
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server!.close(() => {
        logger.info('OTLP receiver stopped');
        resolve();
      });
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // Only accept POST /v1/traces
    if (req.method !== 'POST' || req.url !== '/v1/traces') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"Not found. Use POST /v1/traces"}');
      return;
    }

    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.includes('application/json')) {
      res.writeHead(415, { 'Content-Type': 'application/json' });
      res.end('{"error":"Only application/json is supported"}');
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let destroyed = false;

    req.on('data', (chunk: Buffer) => {
      if (destroyed) return;
      size += chunk.length;
      if (size > this.options.maxBodyBytes) {
        destroyed = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end('{"error":"Request body too large"}');
        req.removeAllListeners('data');
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (res.writableEnded) return; // already responded (413)

      try {
        const body = Buffer.concat(chunks).toString('utf-8');
        const payload = JSON.parse(body) as OtlpExportRequest;

        if (!payload.resourceSpans || !Array.isArray(payload.resourceSpans)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{"error":"Invalid OTLP payload: missing resourceSpans"}');
          return;
        }

        this.options.onSpans(payload);

        // OTLP spec: 200 with empty JSON on success
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      } catch (e) {
        logger.warn({ error: e }, 'Failed to parse OTLP request');
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"Invalid JSON"}');
      }
    });

    req.on('error', (e) => {
      logger.warn({ error: e }, 'OTLP request error');
    });
  }
}
