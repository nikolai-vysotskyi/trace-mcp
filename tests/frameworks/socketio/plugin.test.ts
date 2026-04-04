import { describe, it, expect, beforeEach } from 'vitest';
import {
  SocketIoPlugin,
  extractSocketEvents,
  extractSocketNamespaces,
} from '../../../src/indexer/plugins/integration/socketio/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

describe('SocketIoPlugin', () => {
  let plugin: SocketIoPlugin;

  beforeEach(() => {
    plugin = new SocketIoPlugin();
  });

  describe('detect()', () => {
    it('returns true when packageJson has socket.io', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nonexistent',
        packageJson: { dependencies: { 'socket.io': '^4.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns true when socket.io is in devDependencies', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nonexistent',
        packageJson: { devDependencies: { 'socket.io': '^4.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns false for non-Socket.io project', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nonexistent-12345',
        packageJson: { dependencies: { express: '^4.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(false);
    });
  });

  describe('registerSchema()', () => {
    it('returns expected edge types', () => {
      const schema = plugin.registerSchema();
      const names = schema.edgeTypes.map((e) => e.name);
      expect(names).toContain('socketio_event');
      expect(names).toContain('socketio_namespace');
    });

    it('all edge types have socketio category', () => {
      const schema = plugin.registerSchema();
      for (const et of schema.edgeTypes) {
        expect(et.category).toBe('socketio');
      }
    });
  });

  describe('extractSocketEvents()', () => {
    it('extracts on() event listeners', () => {
      const source = `
        socket.on('message', (data) => {
          console.log(data);
        });
        socket.on('disconnect', () => {});
      `;
      const events = extractSocketEvents(source);
      const listeners = events.filter((e) => e.type === 'listener');
      expect(listeners).toHaveLength(2);
      expect(listeners.map((l) => l.name)).toContain('message');
      expect(listeners.map((l) => l.name)).toContain('disconnect');
    });

    it('extracts emit() event emitters', () => {
      const source = `
        socket.emit('chat:message', { text: 'hello' });
        io.emit('broadcast', { data: 123 });
      `;
      const events = extractSocketEvents(source);
      const emitters = events.filter((e) => e.type === 'emitter');
      expect(emitters).toHaveLength(2);
      expect(emitters.map((e) => e.name)).toContain('chat:message');
      expect(emitters.map((e) => e.name)).toContain('broadcast');
    });

    it('extracts broadcast.emit events', () => {
      const source = `
        socket.broadcast.emit('user:joined', { userId: '123' });
      `;
      const events = extractSocketEvents(source);
      const emitters = events.filter((e) => e.type === 'emitter');
      expect(emitters).toHaveLength(1);
      expect(emitters[0].name).toBe('user:joined');
    });

    it('extracts io.emit events', () => {
      const source = `
        io.emit('server:announcement', { msg: 'hello all' });
      `;
      const events = extractSocketEvents(source);
      const emitters = events.filter((e) => e.type === 'emitter');
      expect(emitters).toHaveLength(1);
      expect(emitters[0].name).toBe('server:announcement');
    });

    it('extracts both listeners and emitters from mixed source', () => {
      const source = `
        io.on('connection', (socket) => {
          socket.on('join', (room) => {
            socket.emit('joined', { room });
            socket.broadcast.emit('user:joined', { room });
          });
        });
      `;
      const events = extractSocketEvents(source);
      const listeners = events.filter((e) => e.type === 'listener');
      const emitters = events.filter((e) => e.type === 'emitter');
      expect(listeners.length).toBeGreaterThanOrEqual(2);
      expect(emitters.length).toBeGreaterThanOrEqual(2);
    });

    it('returns empty array for source with no socket events', () => {
      const source = `
        const x = 42;
        console.log('hello');
      `;
      const events = extractSocketEvents(source);
      expect(events).toHaveLength(0);
    });
  });

  describe('extractSocketNamespaces()', () => {
    it('extracts io.of() namespace definitions', () => {
      const source = `
        const adminNs = io.of('/admin');
        const chatNs = io.of('/chat');
      `;
      const namespaces = extractSocketNamespaces(source);
      expect(namespaces).toHaveLength(2);
      expect(namespaces).toContain('/admin');
      expect(namespaces).toContain('/chat');
    });

    it('extracts server.of() namespace definitions', () => {
      const source = `
        const ns = server.of('/notifications');
      `;
      const namespaces = extractSocketNamespaces(source);
      expect(namespaces).toHaveLength(1);
      expect(namespaces[0]).toBe('/notifications');
    });

    it('returns empty array when no namespaces present', () => {
      const source = `
        socket.on('message', () => {});
      `;
      const namespaces = extractSocketNamespaces(source);
      expect(namespaces).toHaveLength(0);
    });
  });

  describe('extractNodes()', () => {
    it('sets frameworkRole to socketio_handler and populates routes for events', () => {
      const source = `
        socket.on('message', (data) => {});
        socket.emit('reply', { ok: true });
      `;
      const result = plugin.extractNodes('handler.ts', Buffer.from(source), 'typescript');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('socketio_handler');
      expect(parsed.routes!.length).toBeGreaterThanOrEqual(2);

      const methods = parsed.routes!.map((r) => r.method);
      expect(methods).toContain('EVENT');
    });

    it('populates routes with NAMESPACE method for namespace definitions', () => {
      const source = `
        const adminNs = io.of('/admin');
      `;
      const result = plugin.extractNodes('ns.ts', Buffer.from(source), 'typescript');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('socketio_handler');
      const nsRoutes = parsed.routes!.filter((r) => r.method === 'NAMESPACE');
      expect(nsRoutes).toHaveLength(1);
      expect(nsRoutes[0].uri).toBe('/admin');
    });

    it('includes both events and namespaces in routes', () => {
      const source = `
        const admin = io.of('/admin');
        socket.on('message', () => {});
        socket.emit('reply', {});
      `;
      const result = plugin.extractNodes('mixed.ts', Buffer.from(source), 'typescript');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      const methods = parsed.routes!.map((r) => r.method);
      expect(methods).toContain('EVENT');
      expect(methods).toContain('NAMESPACE');
    });

    it('skips non-JS/TS files', () => {
      const result = plugin.extractNodes('test.go', Buffer.from(''), 'go');
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().symbols).toHaveLength(0);
    });
  });

  describe('manifest', () => {
    it('has correct name and priority', () => {
      expect(plugin.manifest.name).toBe('socketio');
      expect(plugin.manifest.priority).toBe(25);
    });
  });
});
