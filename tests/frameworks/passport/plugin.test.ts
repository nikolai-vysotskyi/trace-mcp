import { beforeEach, describe, expect, it } from 'vitest';
import { KNOWN_PACKAGES } from '../../../src/analytics/known-packages.js';
import {
  extractPassportSignals,
  PassportPlugin,
} from '../../../src/indexer/plugins/integration/framework/passport/index.js';
import type { ProjectContext, ResolveContext } from '../../../src/plugin-api/types.js';

describe('PassportPlugin', () => {
  let plugin: PassportPlugin;

  beforeEach(() => {
    plugin = new PassportPlugin();
  });

  describe('detect()', () => {
    it('detects passport in dependencies', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/x',
        packageJson: { dependencies: { passport: '^0.7.0' } },
        configFiles: [],
        detectedVersions: [],
        allDependencies: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('detects @nestjs/passport', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/x',
        packageJson: { dependencies: { '@nestjs/passport': '^10.0.0' } },
        configFiles: [],
        detectedVersions: [],
        allDependencies: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('detects passport-jwt strategy package', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/x',
        packageJson: { dependencies: { 'passport-jwt': '^4.0.0' } },
        configFiles: [],
        detectedVersions: [],
        allDependencies: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns false for unrelated project', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nonexistent-yyy',
        packageJson: { dependencies: { express: '^4.0.0' } },
        configFiles: [],
        detectedVersions: [],
        allDependencies: [],
      };
      expect(plugin.detect(ctx)).toBe(false);
    });
  });

  describe('extractPassportSignals()', () => {
    it('extracts passport.use(new XStrategy())', () => {
      const source = `
        passport.use(new JwtStrategy(opts, verify));
        passport.use(new LocalStrategy(localOpts, verifyLocal));
      `;
      const summary = extractPassportSignals(source);
      const names = summary.strategies.map((s) => s.className);
      expect(names).toEqual(['JwtStrategy', 'LocalStrategy']);
      expect(summary.strategies.every((s) => s.style === 'passport_use')).toBe(true);
    });

    it('extracts NestJS-style strategy classes', () => {
      const source = `
        export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
          constructor() { super({}); }
        }
      `;
      const summary = extractPassportSignals(source);
      expect(summary.strategies).toHaveLength(1);
      expect(summary.strategies[0]).toMatchObject({
        className: 'JwtStrategy',
        baseStrategy: 'Strategy',
        registeredName: 'jwt',
        style: 'nest_extends',
      });
    });

    it('extracts passport.authenticate consumers', () => {
      const source = `
        app.get('/me', passport.authenticate('jwt'), handler);
        app.post('/login', passport.authenticate(['local', 'jwt']), handler);
      `;
      const summary = extractPassportSignals(source);
      expect(summary.consumers).toHaveLength(2);
      expect(summary.consumers[0]).toEqual({ kind: 'authenticate', strategies: ['jwt'] });
      expect(summary.consumers[1].strategies.sort()).toEqual(['jwt', 'local']);
    });

    it('extracts NestJS AuthGuard consumers', () => {
      const source = `
        @UseGuards(AuthGuard('jwt'))
        export class MeController {}

        @UseGuards(AuthGuard(['google', 'jwt']))
        class Other {}
      `;
      const summary = extractPassportSignals(source);
      const guard = summary.consumers.filter((c) => c.kind === 'guard');
      expect(guard).toHaveLength(2);
      expect(guard[0].strategies).toEqual(['jwt']);
      expect(guard[1].strategies.sort()).toEqual(['google', 'jwt']);
    });

    it('flags serializer presence', () => {
      const source = `
        passport.serializeUser((user, done) => done(null, user.id));
      `;
      const summary = extractPassportSignals(source);
      expect(summary.hasSerializers).toBe(true);
    });

    it('ignores passport.use() inside a line comment', () => {
      const summary = extractPassportSignals(`
        // passport.use(new FakeStrategy())
        const x = 1;
      `);
      expect(summary.strategies).toHaveLength(0);
      expect(summary.consumers).toHaveLength(0);
    });

    it('ignores AuthGuard() inside a block comment', () => {
      const summary = extractPassportSignals(`
        /**
         * Example: @UseGuards(AuthGuard('legacy-jwt'))
         */
        @UseGuards(AuthGuard('jwt'))
        export class C {}
      `);
      // Only the real call is recorded — the JSDoc one is gone.
      expect(summary.consumers).toEqual([{ kind: 'guard', strategies: ['jwt'] }]);
    });

    it('returns empty summary for unrelated source', () => {
      const summary = extractPassportSignals('const x = 1;');
      expect(summary.strategies).toHaveLength(0);
      expect(summary.consumers).toHaveLength(0);
      expect(summary.hasSerializers).toBe(false);
    });

    it('extracts both strategies from chained passport.use().use(...)', () => {
      const source = `
        passport
          .use(new LocalStrategy(opts, verify))
          .use(new JwtStrategy(jwtOpts, jwtVerify));
      `;
      const summary = extractPassportSignals(source);
      const names = summary.strategies.map((s) => s.className).sort();
      expect(names).toEqual(['JwtStrategy', 'LocalStrategy']);
    });

    it('extracts strategy and consumer from the same file', () => {
      const source = `
        export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {}
        @UseGuards(AuthGuard('jwt'))
        export class FooController {}
      `;
      const summary = extractPassportSignals(source);
      expect(summary.strategies).toHaveLength(1);
      expect(summary.consumers).toHaveLength(1);
      expect(summary.consumers[0].kind).toBe('guard');
    });
  });

  describe('extractNodes()', () => {
    it('emits STRATEGY routes for registered strategies', () => {
      const source = `passport.use(new JwtStrategy(opts, verify));`;
      const result = plugin.extractNodes('auth.ts', Buffer.from(source), 'typescript');
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('passport_strategy');
      const route = parsed.routes!.find((r) => r.method === 'STRATEGY')!;
      expect(route.uri).toBe('passport:JwtStrategy');
    });

    it('emits GUARD routes for AuthGuard consumers', () => {
      const source = `
        @UseGuards(AuthGuard('jwt'))
        export class FooController {}
      `;
      const result = plugin.extractNodes('foo.controller.ts', Buffer.from(source), 'typescript');
      const parsed = result._unsafeUnwrap();
      const guard = parsed.routes!.find((r) => r.method === 'GUARD');
      expect(guard?.uri).toBe('passport:jwt');
      expect(parsed.frameworkRole).toBe('passport_consumer');
    });

    it('skips files with no passport signals', () => {
      const result = plugin.extractNodes('plain.ts', Buffer.from('const x = 1;'), 'typescript');
      expect(result._unsafeUnwrap().symbols).toHaveLength(0);
    });

    it('skips non-JS/TS files', () => {
      const result = plugin.extractNodes('a.py', Buffer.from(''), 'python');
      expect(result._unsafeUnwrap().symbols).toHaveLength(0);
    });
  });

  describe('manifest', () => {
    it('has expected name and category', () => {
      expect(plugin.manifest.name).toBe('passport');
      expect(plugin.manifest.category).toBe('framework');
    });
  });

  describe('catalog wiring', () => {
    it.each([
      'passport',
      'passport-local',
      'passport-jwt',
      'passport-google-oauth20',
      'passport-github2',
      'passport-facebook',
      'passport-oauth2',
    ])('%s is mapped to the passport plugin', (pkg) => {
      expect(KNOWN_PACKAGES[pkg]?.plugin).toBe('passport');
    });
  });

  describe('resolveEdges()', () => {
    it('links AuthGuard consumer to NestJS strategy class registered with same name', () => {
      const strategySrc = `
        export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
          constructor() { super({}); }
        }
      `;
      const consumerSrc = `
        @UseGuards(AuthGuard('jwt'))
        export class MeController {}
      `;
      const ctx: ResolveContext = {
        rootPath: '/x',
        getAllFiles: () => [
          { id: 1, path: 'jwt.strategy.ts', language: 'typescript' },
          { id: 2, path: 'me.controller.ts', language: 'typescript' },
        ],
        getSymbolsByFile: (id: number) =>
          id === 1
            ? [{ id: 100, symbolId: 'js', name: 'JwtStrategy', kind: 'class', fqn: null }]
            : [{ id: 200, symbolId: 'mc', name: 'MeController', kind: 'class', fqn: null }],
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 0,
        readFile: (p) =>
          p === 'jwt.strategy.ts'
            ? strategySrc
            : p === 'me.controller.ts'
              ? consumerSrc
              : undefined,
      } as unknown as ResolveContext;

      const edges = plugin.resolveEdges(ctx)._unsafeUnwrap();
      const auth = edges.filter((e) => e.edgeType === 'passport_authenticates');
      expect(auth).toHaveLength(1);
      expect(auth[0].sourceRefId).toBe(200);
      expect(auth[0].targetRefId).toBe(100);
      expect((auth[0].metadata as { kind: string }).kind).toBe('guard');
    });

    it('falls back to className-derived name when @UseGuards has no explicit name', () => {
      // class JwtStrategy extends PassportStrategy(Strategy)  — no second arg
      const strategySrc = `
        export class JwtStrategy extends PassportStrategy(Strategy) {}
      `;
      const consumerSrc = `
        @UseGuards(AuthGuard('jwt'))
        export class MeController {}
      `;
      const ctx: ResolveContext = {
        rootPath: '/x',
        getAllFiles: () => [
          { id: 1, path: 'jwt.strategy.ts', language: 'typescript' },
          { id: 2, path: 'me.controller.ts', language: 'typescript' },
        ],
        getSymbolsByFile: (id: number) =>
          id === 1
            ? [{ id: 100, symbolId: 'js', name: 'JwtStrategy', kind: 'class', fqn: null }]
            : [{ id: 200, symbolId: 'mc', name: 'MeController', kind: 'class', fqn: null }],
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 0,
        readFile: (p) =>
          p === 'jwt.strategy.ts'
            ? strategySrc
            : p === 'me.controller.ts'
              ? consumerSrc
              : undefined,
      } as unknown as ResolveContext;

      const edges = plugin.resolveEdges(ctx)._unsafeUnwrap();
      const auth = edges.filter((e) => e.edgeType === 'passport_authenticates');
      expect(auth).toHaveLength(1);
    });

    it('falls back to className-derived name for passport.use(new X) without explicit name', () => {
      const strategySrc = `passport.use(new JwtStrategy(opts, verify));`;
      const consumerSrc = `
        @UseGuards(AuthGuard('jwt'))
        export class MeController {}
      `;
      const ctx: ResolveContext = {
        rootPath: '/x',
        getAllFiles: () => [
          { id: 1, path: 'auth.ts', language: 'typescript' },
          { id: 2, path: 'me.controller.ts', language: 'typescript' },
        ],
        getSymbolsByFile: (id: number) =>
          id === 1
            ? [{ id: 100, symbolId: 'js', name: 'JwtStrategy', kind: 'class', fqn: null }]
            : [{ id: 200, symbolId: 'mc', name: 'MeController', kind: 'class', fqn: null }],
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 0,
        readFile: (p) =>
          p === 'auth.ts' ? strategySrc : p === 'me.controller.ts' ? consumerSrc : undefined,
      } as unknown as ResolveContext;

      const edges = plugin.resolveEdges(ctx)._unsafeUnwrap();
      const auth = edges.filter((e) => e.edgeType === 'passport_authenticates');
      expect(auth).toHaveLength(1);
      expect(auth[0].targetRefId).toBe(100);
    });

    it('emits ambiguous edges when two strategy classes share a registered name', () => {
      const s1 = `export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {}`;
      const s2 = `export class CustomJwtStrategy extends PassportStrategy(Strategy, 'jwt') {}`;
      const consumer = `@UseGuards(AuthGuard('jwt')) export class C {}`;
      const ctx: ResolveContext = {
        rootPath: '/x',
        getAllFiles: () => [
          { id: 1, path: 's1.ts', language: 'typescript' },
          { id: 2, path: 's2.ts', language: 'typescript' },
          { id: 3, path: 'c.ts', language: 'typescript' },
        ],
        getSymbolsByFile: (id: number) =>
          id === 1
            ? [{ id: 100, symbolId: 's1', name: 'JwtStrategy', kind: 'class', fqn: null }]
            : id === 2
              ? [
                  {
                    id: 200,
                    symbolId: 's2',
                    name: 'CustomJwtStrategy',
                    kind: 'class',
                    fqn: null,
                  },
                ]
              : [{ id: 300, symbolId: 'c', name: 'C', kind: 'class', fqn: null }],
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 0,
        readFile: (p: string) => (p === 's1.ts' ? s1 : p === 's2.ts' ? s2 : consumer),
      } as unknown as ResolveContext;

      const edges = plugin.resolveEdges(ctx)._unsafeUnwrap();
      const auth = edges.filter((e) => e.edgeType === 'passport_authenticates');
      expect(auth).toHaveLength(2);
      const targets = auth.map((e) => e.targetRefId).sort();
      expect(targets).toEqual([100, 200]);
      for (const e of auth) {
        expect((e.metadata as { ambiguous?: number }).ambiguous).toBe(2);
      }
    });

    it('emits passport_strategy self-loop for each registered strategy class', () => {
      const src = `
        export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {}
      `;
      const ctx: ResolveContext = {
        rootPath: '/x',
        getAllFiles: () => [{ id: 1, path: 'j.ts', language: 'typescript' }],
        getSymbolsByFile: () => [
          { id: 100, symbolId: 'j', name: 'JwtStrategy', kind: 'class', fqn: null },
        ],
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 0,
        readFile: () => src,
      } as unknown as ResolveContext;

      const edges = plugin.resolveEdges(ctx)._unsafeUnwrap();
      const strat = edges.filter((e) => e.edgeType === 'passport_strategy');
      expect(strat).toHaveLength(1);
      expect(strat[0].sourceRefId).toBe(100);
      expect((strat[0].metadata as { registeredName: string }).registeredName).toBe('jwt');
    });
  });
});
