/**
 * LSP JSON-RPC client over stdio.
 * Implements Content-Length message framing and request/response tracking.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { logger } from '../logger.js';
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  InitializeParams,
  InitializeResult,
  CallHierarchyItem,
  CallHierarchyIncomingCall,
  CallHierarchyOutgoingCall,
  DidOpenTextDocumentParams,
  DidCloseTextDocumentParams,
  TextDocumentItem,
  Location,
} from './protocol.js';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

export class LspClient {
  private proc: ChildProcess | null = null;
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();
  private buffer = Buffer.alloc(0);
  private initialized = false;
  private serverCapabilities: InitializeResult['capabilities'] | null = null;
  private openedFiles = new Set<string>();

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly cwd: string,
    private readonly timeoutMs: number = 30_000,
  ) {}

  get capabilities(): InitializeResult['capabilities'] | null {
    return this.serverCapabilities;
  }

  get supportsCallHierarchy(): boolean {
    return this.serverCapabilities?.callHierarchyProvider != null
      && this.serverCapabilities.callHierarchyProvider !== false;
  }

  // ── Lifecycle ───────────────────────────────────────────────

  async initialize(rootUri: string, initOptions?: Record<string, unknown>): Promise<InitializeResult> {
    this.proc = spawn(this.command, this.args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: '' }, // avoid inheriting debug flags
    });

    this.proc.stdout!.on('data', (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr!.on('data', (chunk: Buffer) => {
      logger.debug({ lsp: this.command, stderr: chunk.toString().trim() }, 'LSP stderr');
    });
    this.proc.on('error', (err) => {
      logger.warn({ lsp: this.command, error: err.message }, 'LSP process error');
      this.rejectAll(new Error(`LSP process error: ${err.message}`));
    });
    this.proc.on('exit', (code, signal) => {
      logger.debug({ lsp: this.command, code, signal }, 'LSP process exited');
      this.rejectAll(new Error(`LSP process exited: code=${code} signal=${signal}`));
    });

    const params: InitializeParams = {
      processId: process.pid,
      rootUri,
      capabilities: {
        textDocument: {
          callHierarchy: { dynamicRegistration: false },
          definition: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
        },
      },
      initializationOptions: initOptions,
      workspaceFolders: [{ uri: rootUri, name: 'root' }],
    };

    const result = await this.request<InitializeResult>('initialize', params);
    this.serverCapabilities = result.capabilities;
    this.initialized = true;

    // Notify initialized
    this.notify('initialized', {});

    return result;
  }

  async shutdown(): Promise<void> {
    if (!this.proc || this.proc.exitCode !== null) return;

    try {
      await this.request('shutdown', null, 5_000);
      this.notify('exit', null);
    } catch {
      // Server didn't respond to shutdown — kill it
    }

    // Wait for process to exit, kill after timeout
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        this.proc?.kill('SIGKILL');
        resolve();
      }, 3_000);

      this.proc!.on('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });

      // If already exited
      if (this.proc!.exitCode !== null) {
        clearTimeout(killTimer);
        resolve();
      }
    });

    this.proc = null;
    this.initialized = false;
    this.openedFiles.clear();
  }

  isAlive(): boolean {
    return this.proc !== null && this.proc.exitCode === null && this.initialized;
  }

  // ── LSP Methods ─────────────────────────────────────────────

  async prepareCallHierarchy(uri: string, line: number, character: number): Promise<CallHierarchyItem[]> {
    const result = await this.request<CallHierarchyItem[] | null>(
      'textDocument/prepareCallHierarchy',
      { textDocument: { uri }, position: { line, character } },
    );
    return result ?? [];
  }

  async incomingCalls(item: CallHierarchyItem): Promise<CallHierarchyIncomingCall[]> {
    const result = await this.request<CallHierarchyIncomingCall[] | null>(
      'callHierarchy/incomingCalls',
      { item },
    );
    return result ?? [];
  }

  async outgoingCalls(item: CallHierarchyItem): Promise<CallHierarchyOutgoingCall[]> {
    const result = await this.request<CallHierarchyOutgoingCall[] | null>(
      'callHierarchy/outgoingCalls',
      { item },
    );
    return result ?? [];
  }

  async getDefinition(uri: string, line: number, character: number): Promise<Location[]> {
    const result = await this.request<Location | Location[] | null>(
      'textDocument/definition',
      { textDocument: { uri }, position: { line, character } },
    );
    if (!result) return [];
    return Array.isArray(result) ? result : [result];
  }

  async openDocument(uri: string, languageId: string, text: string): Promise<void> {
    if (this.openedFiles.has(uri)) return;
    const params: DidOpenTextDocumentParams = {
      textDocument: { uri, languageId, version: 1, text } as TextDocumentItem,
    };
    this.notify('textDocument/didOpen', params);
    this.openedFiles.add(uri);
  }

  async closeDocument(uri: string): Promise<void> {
    if (!this.openedFiles.has(uri)) return;
    const params: DidCloseTextDocumentParams = {
      textDocument: { uri },
    };
    this.notify('textDocument/didClose', params);
    this.openedFiles.delete(uri);
  }

  // ── JSON-RPC Transport ──────────────────────────────────────

  async request<T>(method: string, params: unknown, timeoutOverride?: number): Promise<T> {
    if (!this.proc?.stdin?.writable) {
      throw new Error(`LSP client not connected (${this.command})`);
    }

    const id = ++this.requestId;
    const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timeout = timeoutOverride ?? this.timeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request timeout: ${method} (${timeout}ms)`));
      }, timeout);

      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        method,
      });

      this.send(msg);
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.proc?.stdin?.writable) return;
    const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    this.send(msg);
  }

  private send(msg: JsonRpcRequest | JsonRpcNotification): void {
    const body = JSON.stringify(msg);
    const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
    this.proc!.stdin!.write(header + body);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.processBuffer();
  }

  private processBuffer(): void {
    while (true) {
      // Find header end
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      // Parse Content-Length
      const header = this.buffer.subarray(0, headerEnd).toString();
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        // Malformed header — skip to after \r\n\r\n
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;

      if (this.buffer.length < bodyEnd) break; // incomplete body

      const body = this.buffer.subarray(bodyStart, bodyEnd).toString();
      this.buffer = this.buffer.subarray(bodyEnd);

      try {
        const msg = JSON.parse(body);
        this.onMessage(msg);
      } catch (e) {
        logger.debug({ lsp: this.command, error: (e as Error).message }, 'Failed to parse LSP message');
      }
    }
  }

  private onMessage(msg: JsonRpcResponse | JsonRpcNotification): void {
    // Response to a request
    if ('id' in msg && msg.id != null) {
      const pending = this.pending.get(msg.id as number);
      if (pending) {
        this.pending.delete(msg.id as number);
        clearTimeout(pending.timer);
        const resp = msg as JsonRpcResponse;
        if (resp.error) {
          pending.reject(new Error(`LSP error [${resp.error.code}]: ${resp.error.message}`));
        } else {
          pending.resolve(resp.result);
        }
      }
      return;
    }

    // Server notifications (log, diagnostics, etc.) — ignore
    const notif = msg as JsonRpcNotification;
    if (notif.method === 'window/logMessage' || notif.method === 'window/showMessage') {
      const params = notif.params as { type?: number; message?: string } | undefined;
      logger.debug({ lsp: this.command, lspMsg: params?.message }, 'LSP notification');
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
