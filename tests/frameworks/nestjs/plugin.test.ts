import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { KNOWN_PACKAGES } from '../../../src/analytics/known-packages.js';
import {
  extractConstructorDeps,
  extractControllerRoutes,
  extractGatewayMeta,
  extractModuleInfo,
  NestJSPlugin,
} from '../../../src/indexer/plugins/integration/framework/nestjs/index.js';
import type { ProjectContext, ResolveContext } from '../../../src/plugin-api/types.js';

const FIXTURE_DIR = path.resolve(__dirname, '../../fixtures/nestjs-basic');

describe('NestJSPlugin', () => {
  let plugin: NestJSPlugin;

  beforeEach(() => {
    plugin = new NestJSPlugin();
  });

  describe('detect()', () => {
    it('returns true when packageJson has @nestjs/core', () => {
      const ctx: ProjectContext = {
        rootPath: FIXTURE_DIR,
        packageJson: { dependencies: { '@nestjs/core': '^10.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns true when reading package.json from disk', () => {
      const ctx: ProjectContext = {
        rootPath: FIXTURE_DIR,
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns false for non-NestJS project', () => {
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
      expect(names).toContain('nest_module_imports');
      expect(names).toContain('nest_provides');
      expect(names).toContain('nest_injects');
      expect(names).toContain('nest_guards');
      expect(names).toContain('nest_pipes');
      expect(names).toContain('nest_interceptors');
    });

    it('all edge types have nestjs category', () => {
      const schema = plugin.registerSchema();
      for (const et of schema.edgeTypes) {
        expect(et.category).toBe('nestjs');
      }
    });
  });

  describe('extractControllerRoutes()', () => {
    it('extracts routes from controller with base path', () => {
      const source = fs.readFileSync(
        path.join(FIXTURE_DIR, 'src/users/users.controller.ts'),
        'utf-8',
      );
      const { basePath, routes } = extractControllerRoutes(source, 'users.controller.ts');
      expect(basePath).toBe('users');
      expect(routes).toHaveLength(3);

      const methods = routes.map((r) => r.method);
      expect(methods).toContain('GET');
      expect(methods).toContain('POST');

      const uris = routes.map((r) => r.uri);
      expect(uris).toContain('/users');
      expect(uris).toContain('/users/:id');
    });

    it('extracts guards', () => {
      const source = fs.readFileSync(
        path.join(FIXTURE_DIR, 'src/users/users.controller.ts'),
        'utf-8',
      );
      const { guards } = extractControllerRoutes(source, 'users.controller.ts');
      expect(guards).toContain('AuthGuard');
    });
  });

  describe('extractModuleInfo()', () => {
    it('extracts module imports and providers', () => {
      const source = fs.readFileSync(path.join(FIXTURE_DIR, 'src/users/users.module.ts'), 'utf-8');
      const info = extractModuleInfo(source);
      expect(info).not.toBeNull();
      expect(info!.controllers).toContain('UsersController');
      expect(info!.providers).toContain('UsersService');
    });

    it('extracts root module imports', () => {
      const source = fs.readFileSync(path.join(FIXTURE_DIR, 'src/app.module.ts'), 'utf-8');
      const info = extractModuleInfo(source);
      expect(info).not.toBeNull();
      expect(info!.imports).toContain('UsersModule');
    });
  });

  describe('extractConstructorDeps()', () => {
    it('extracts constructor injection types', () => {
      const source = fs.readFileSync(
        path.join(FIXTURE_DIR, 'src/users/users.controller.ts'),
        'utf-8',
      );
      const deps = extractConstructorDeps(source);
      expect(deps).toContain('UsersService');
    });
  });

  describe('extractNodes()', () => {
    it('detects controller role and routes', () => {
      const content = fs.readFileSync(path.join(FIXTURE_DIR, 'src/users/users.controller.ts'));
      const result = plugin.extractNodes('users.controller.ts', content, 'typescript');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('nest_controller');
      expect(parsed.routes!.length).toBeGreaterThanOrEqual(3);
    });

    it('detects injectable role', () => {
      const content = fs.readFileSync(path.join(FIXTURE_DIR, 'src/users/users.service.ts'));
      const result = plugin.extractNodes('users.service.ts', content, 'typescript');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('nest_injectable');
    });

    it('detects module role', () => {
      const content = fs.readFileSync(path.join(FIXTURE_DIR, 'src/app.module.ts'));
      const result = plugin.extractNodes('app.module.ts', content, 'typescript');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('nest_module');
    });

    it('skips non-typescript files', () => {
      const result = plugin.extractNodes('test.php', Buffer.from(''), 'php');
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().symbols).toHaveLength(0);
    });
  });

  describe('manifest', () => {
    it('has correct name and priority', () => {
      expect(plugin.manifest.name).toBe('nestjs');
      expect(plugin.manifest.priority).toBe(25);
    });
  });

  describe('extractGatewayMeta()', () => {
    it('extracts namespace from object options', () => {
      const source = `
        @WebSocketGateway({ namespace: '/chat', cors: true })
        export class ChatGateway {
          @WebSocketServer()
          server: Server;
        }
      `;
      const meta = extractGatewayMeta(source);
      expect(meta.namespace).toBe('/chat');
      expect(meta.cors).toBe(true);
      expect(meta.hasServerInjection).toBe(true);
    });

    it('extracts port from positional argument', () => {
      const source = `@WebSocketGateway(8080) class G {}`;
      const meta = extractGatewayMeta(source);
      expect(meta.port).toBe(8080);
    });

    it('extracts port + options combo', () => {
      const source = `@WebSocketGateway(81, { namespace: '/n' }) class G {}`;
      const meta = extractGatewayMeta(source);
      expect(meta.port).toBe(81);
      expect(meta.namespace).toBe('/n');
    });

    it('returns hasServerInjection=false when @WebSocketServer() absent', () => {
      const meta = extractGatewayMeta(`@WebSocketGateway() class G {}`);
      expect(meta.hasServerInjection).toBe(false);
    });

    it('handles nested cors object literal', () => {
      const meta = extractGatewayMeta(`
        @WebSocketGateway({
          namespace: '/chat',
          cors: { origin: '*', credentials: true },
        })
        class G {}
      `);
      expect(meta.namespace).toBe('/chat');
      expect(meta.cors).toBe(true);
    });

    it('handles options preceded by other deeply nested fields', () => {
      const meta = extractGatewayMeta(`
        @WebSocketGateway({
          transports: ['websocket'],
          adapters: { foo: { bar: 1 } },
          namespace: '/y',
        })
        class G {}
      `);
      expect(meta.namespace).toBe('/y');
    });
  });

  describe('extractNodes() — bare @WebSocketGateway (no parens)', () => {
    it('still flags the class as nest_gateway', () => {
      const source = `
        @WebSocketGateway
        export class G {
          @SubscribeMessage('msg') onMsg() {}
        }
      `;
      const result = plugin.extractNodes('g.gateway.ts', Buffer.from(source), 'typescript');
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('nest_gateway');
      const ws = parsed.routes!.find((r) => r.method === 'WS');
      expect(ws?.uri).toBe('msg');
    });
  });

  describe('extractNodes() — gateway with @WebSocketGateway options', () => {
    it('records namespace + ws routes with metadata', () => {
      const source = `
        @WebSocketGateway({ namespace: '/chat' })
        export class ChatGateway {
          @WebSocketServer()
          server: Server;

          @SubscribeMessage('message')
          onMessage() {}
        }
      `;
      const result = plugin.extractNodes('chat.gateway.ts', Buffer.from(source), 'typescript');
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('nest_gateway');
      const ns = parsed.routes!.find((r) => r.method === 'NAMESPACE');
      expect(ns?.uri).toBe('/chat');
      const ws = parsed.routes!.find((r) => r.method === 'WS');
      expect(ws?.uri).toBe('message');
      expect((ws?.metadata as { namespace?: string }).namespace).toBe('/chat');
    });
  });

  describe('catalog wiring (issue #126)', () => {
    it('@nestjs/platform-socket.io is mapped to the nestjs plugin', () => {
      expect(KNOWN_PACKAGES['@nestjs/platform-socket.io']?.plugin).toBe('nestjs');
    });

    it('@nestjs/platform-ws is mapped to the nestjs plugin', () => {
      expect(KNOWN_PACKAGES['@nestjs/platform-ws']?.plugin).toBe('nestjs');
    });
  });

  describe('resolveEdges() — gateway events (issue #126)', () => {
    it('emits ONE aggregated nest_gateway_event self-loop with every event in metadata', () => {
      const src = `
        @WebSocketGateway({ namespace: '/chat' })
        export class ChatGateway {
          @SubscribeMessage('message') onMessage() {}
          @SubscribeMessage('typing') onTyping() {}
          @SubscribeMessage('disconnect') onDisconnect() {}
        }
      `;
      const ctx: ResolveContext = {
        rootPath: '/x',
        getAllFiles: () => [{ id: 1, path: 'chat.gateway.ts', language: 'typescript' }],
        getSymbolsByFile: () => [
          { id: 100, symbolId: 'g', name: 'ChatGateway', kind: 'class', fqn: null },
        ],
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 0,
        readFile: () => src,
      } as unknown as ResolveContext;

      const edges = plugin.resolveEdges(ctx)._unsafeUnwrap();
      const gw = edges.filter((e) => e.edgeType === 'nest_gateway_event');
      expect(gw).toHaveLength(1);
      expect(gw[0].sourceRefId).toBe(100);
      expect(gw[0].targetRefId).toBe(100);
      const meta = gw[0].metadata as {
        count: number;
        events: string[];
        namespace?: string;
      };
      expect(meta.count).toBe(3);
      expect(meta.events.sort()).toEqual(['disconnect', 'message', 'typing']);
      expect(meta.namespace).toBe('/chat');
    });

    it('does not emit nest_gateway_event when class has no @SubscribeMessage', () => {
      const src = `
        @WebSocketGateway() export class EmptyGateway {}
      `;
      const ctx: ResolveContext = {
        rootPath: '/x',
        getAllFiles: () => [{ id: 1, path: 'empty.gateway.ts', language: 'typescript' }],
        getSymbolsByFile: () => [
          { id: 1, symbolId: 'e', name: 'EmptyGateway', kind: 'class', fqn: null },
        ],
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 0,
        readFile: () => src,
      } as unknown as ResolveContext;

      const edges = plugin.resolveEdges(ctx)._unsafeUnwrap();
      expect(edges.filter((e) => e.edgeType === 'nest_gateway_event')).toHaveLength(0);
    });

    it('emits aggregated nest_message_pattern + nest_event_pattern for microservice handlers', () => {
      const src = `
        export class OrdersController {
          @MessagePattern('cmd.create') createOrder() {}
          @MessagePattern('cmd.cancel') cancelOrder() {}
          @EventPattern('order.placed') onPlaced() {}
        }
      `;
      const ctx: ResolveContext = {
        rootPath: '/x',
        getAllFiles: () => [{ id: 1, path: 'orders.controller.ts', language: 'typescript' }],
        getSymbolsByFile: () => [
          { id: 200, symbolId: 'o', name: 'OrdersController', kind: 'class', fqn: null },
        ],
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 0,
        readFile: () => src,
      } as unknown as ResolveContext;

      const edges = plugin.resolveEdges(ctx)._unsafeUnwrap();
      const mp = edges.find((e) => e.edgeType === 'nest_message_pattern');
      const ep = edges.find((e) => e.edgeType === 'nest_event_pattern');
      expect(mp).toBeTruthy();
      expect(ep).toBeTruthy();
      expect((mp!.metadata as { patterns: string[] }).patterns.sort()).toEqual([
        'cmd.cancel',
        'cmd.create',
      ]);
      expect((ep!.metadata as { patterns: string[] }).patterns).toEqual(['order.placed']);
    });
  });
});
