/**
 * SocketIoPlugin — detects Socket.io projects and extracts event listeners,
 * event emitters, and namespace definitions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok, type TraceMcpResult } from '../../../../../errors.js';
import type {
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  FileParseResult,
  RawEdge,
  ResolveContext,
} from '../../../../../plugin-api/types.js';

// socket.on('eventName', handler) or io.on('connection', ...)
const LISTENER_RE = /(?:socket|io|server|namespace)\s*\.\s*on\s*\(\s*['"`]([^'"`]+)['"`]/g;

// socket.emit('eventName', ...) or io.emit(...) or socket.broadcast.emit(...)
const EMITTER_RE =
  /(?:socket|io|server|namespace)(?:\.broadcast)?\s*\.\s*emit\s*\(\s*['"`]([^'"`]+)['"`]/g;

// io.of('/namespace')
const NAMESPACE_RE = /(?:io|server)\s*\.\s*of\s*\(\s*['"`]([^'"`]+)['"`]/g;

interface SocketEvent {
  name: string;
  type: 'listener' | 'emitter';
}

/** Extract event listeners and emitters from Socket.io source code. */
export function extractSocketEvents(source: string): SocketEvent[] {
  const events: SocketEvent[] = [];

  const listenerRe = new RegExp(LISTENER_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = listenerRe.exec(source)) !== null) {
    events.push({ name: match[1], type: 'listener' });
  }

  const emitterRe = new RegExp(EMITTER_RE.source, 'g');
  while ((match = emitterRe.exec(source)) !== null) {
    events.push({ name: match[1], type: 'emitter' });
  }

  return events;
}

/** Extract namespace definitions from Socket.io source code. */
export function extractSocketNamespaces(source: string): string[] {
  const namespaces: string[] = [];
  const re = new RegExp(NAMESPACE_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    namespaces.push(match[1]);
  }
  return namespaces;
}

export class SocketIoPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'socketio',
    version: '1.0.0',
    priority: 25,
    category: 'realtime',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    if (ctx.packageJson) {
      const deps = {
        ...(ctx.packageJson.dependencies as Record<string, string> | undefined),
        ...(ctx.packageJson.devDependencies as Record<string, string> | undefined),
      };
      if ('socket.io' in deps) return true;
    }

    try {
      const pkgPath = path.join(ctx.rootPath, 'package.json');
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);
      const deps = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
      };
      return 'socket.io' in deps;
    } catch {
      return false;
    }
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'socketio_event', category: 'socketio', description: 'Event listener/emitter' },
        { name: 'socketio_namespace', category: 'socketio', description: 'Namespace definition' },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (!['typescript', 'javascript'].includes(language)) {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const result: FileParseResult = { status: 'ok', symbols: [], routes: [], edges: [] };

    const events = extractSocketEvents(source);
    if (events.length > 0) {
      result.frameworkRole = 'socketio_handler';
      for (const evt of events) {
        result.routes!.push({
          method: 'EVENT',
          uri: evt.name,
        });
      }
    }

    const namespaces = extractSocketNamespaces(source);
    if (namespaces.length > 0) {
      result.frameworkRole = result.frameworkRole ?? 'socketio_handler';
      for (const ns of namespaces) {
        result.routes!.push({
          method: 'NAMESPACE',
          uri: ns,
        });
      }
    }

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];
    return ok(edges);
  }
}
