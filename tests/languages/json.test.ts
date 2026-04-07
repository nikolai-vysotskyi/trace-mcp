import { describe, it, expect } from 'vitest';
import { JsonLanguagePlugin } from '../../src/indexer/plugins/language/json-lang/index.js';

const plugin = new JsonLanguagePlugin();

async function parse(source: string, filePath = 'config.json') {
  const result = await plugin.extractSymbols(filePath, Buffer.from(source));
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

describe('JsonLanguagePlugin', () => {
  // ── Manifest ──

  it('has correct manifest', () => {
    expect(plugin.manifest.name).toBe('json-language');
    expect(plugin.supportedExtensions).toContain('.json');
    expect(plugin.supportedExtensions).toContain('.jsonc');
  });

  // ── Generic JSON ──

  describe('generic', () => {
    it('extracts first-level keys as constants', async () => {
      const r = await parse('{"host": "localhost", "port": 8080, "debug": true}');
      expect(r.symbols.some(s => s.name === 'host' && s.kind === 'constant')).toBe(true);
      expect(r.symbols.some(s => s.name === 'port' && s.kind === 'constant')).toBe(true);
      expect(r.symbols.some(s => s.name === 'debug' && s.kind === 'constant')).toBe(true);
      // generic dialect => no jsonDialect in metadata
      expect(r.metadata?.jsonDialect).toBeUndefined();
    });

    it('handles empty object', async () => {
      const r = await parse('{}');
      expect(r.symbols).toHaveLength(0);
    });

    it('handles array at top level', async () => {
      const r = await parse('[1, 2, 3]');
      expect(r.symbols).toHaveLength(0);
    });
  });

  // ── package.json ──

  describe('package-json', () => {
    it('extracts name, scripts as functions, dependencies as import edges', async () => {
      const r = await parse(
        JSON.stringify({
          name: 'my-package',
          version: '1.0.0',
          scripts: { build: 'tsc', test: 'vitest' },
          dependencies: { express: '^4.18.0' },
          devDependencies: { vitest: '^1.0.0' },
        }),
        'package.json',
      );

      expect(r.metadata?.jsonDialect).toBe('package-json');
      expect(r.symbols.some(s => s.name === 'my-package' && s.kind === 'constant')).toBe(true);
      expect(r.symbols.some(s => s.name === 'build' && s.kind === 'function')).toBe(true);
      expect(r.symbols.some(s => s.name === 'test' && s.kind === 'function')).toBe(true);
      // import edges for deps
      expect(r.edges!.some(e => (e.metadata as any).module === 'express')).toBe(true);
      expect(r.edges!.some(e => (e.metadata as any).module === 'vitest' && (e.metadata as any).dev === true)).toBe(true);
    });
  });

  // ── tsconfig.json ──

  describe('tsconfig', () => {
    it('extracts compilerOptions keys and extends as import', async () => {
      const r = await parse(
        JSON.stringify({
          extends: '@tsconfig/node18/tsconfig.json',
          compilerOptions: { strict: true, target: 'ES2022', outDir: './dist' },
        }),
        'tsconfig.json',
      );

      expect(r.metadata?.jsonDialect).toBe('tsconfig');
      expect(r.symbols.some(s => s.name === 'strict' && s.kind === 'constant')).toBe(true);
      expect(r.symbols.some(s => s.name === 'target' && s.kind === 'constant')).toBe(true);
      expect(r.edges!.some(e => (e.metadata as any).module === '@tsconfig/node18/tsconfig.json')).toBe(true);
    });
  });

  // ── .eslintrc.json ──

  describe('eslint', () => {
    it('extracts rules as constants, extends and plugins as imports', async () => {
      const r = await parse(
        JSON.stringify({
          extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
          plugins: ['@typescript-eslint'],
          rules: { 'no-unused-vars': 'warn', 'semi': 'error' },
        }),
        '.eslintrc.json',
      );

      expect(r.metadata?.jsonDialect).toBe('eslint');
      expect(r.symbols.some(s => s.name === 'no-unused-vars' && s.kind === 'constant')).toBe(true);
      expect(r.symbols.some(s => s.name === 'semi' && s.kind === 'constant')).toBe(true);
      // extends
      expect(r.edges!.some(e => (e.metadata as any).module === 'eslint:recommended')).toBe(true);
      expect(r.edges!.some(e => (e.metadata as any).module === 'plugin:@typescript-eslint/recommended')).toBe(true);
      // plugins
      expect(r.edges!.some(e => (e.metadata as any).module === '@typescript-eslint')).toBe(true);
    });
  });

  // ── composer.json ──

  describe('composer', () => {
    it('extracts name, require as imports, scripts as functions, autoload namespaces', async () => {
      const r = await parse(
        JSON.stringify({
          name: 'vendor/my-package',
          require: { 'php': '>=8.1', 'laravel/framework': '^10.0' },
          'require-dev': { 'phpunit/phpunit': '^10.0' },
          scripts: { test: 'phpunit', lint: 'phpcs' },
          autoload: { 'psr-4': { 'App\\': 'src/' } },
        }),
        'composer.json',
      );

      expect(r.metadata?.jsonDialect).toBe('composer');
      expect(r.symbols.some(s => s.name === 'vendor/my-package' && s.kind === 'constant')).toBe(true);
      expect(r.symbols.some(s => s.name === 'test' && s.kind === 'function')).toBe(true);
      expect(r.symbols.some(s => s.name === 'lint' && s.kind === 'function')).toBe(true);
      expect(r.symbols.some(s => s.name === 'App\\' && s.kind === 'namespace')).toBe(true);
      // import edges
      expect(r.edges!.some(e => (e.metadata as any).module === 'laravel/framework')).toBe(true);
      expect(r.edges!.some(e => (e.metadata as any).module === 'phpunit/phpunit' && (e.metadata as any).dev === true)).toBe(true);
    });
  });

  // ── angular.json ──

  describe('angular', () => {
    it('extracts project names as namespace, architect targets as function', async () => {
      const r = await parse(
        JSON.stringify({
          projects: {
            'my-app': {
              root: '',
              architect: {
                build: { builder: '@angular-devkit/build-angular:browser' },
                serve: { builder: '@angular-devkit/build-angular:dev-server' },
              },
            },
          },
        }),
        'angular.json',
      );

      expect(r.metadata?.jsonDialect).toBe('angular');
      expect(r.symbols.some(s => s.name === 'my-app' && s.kind === 'namespace')).toBe(true);
      expect(r.symbols.some(s => s.name === 'build' && s.kind === 'function')).toBe(true);
      expect(r.symbols.some(s => s.name === 'serve' && s.kind === 'function')).toBe(true);
    });
  });

  // ── .vscode/settings.json ──

  describe('vscode-settings', () => {
    it('extracts setting keys as constants', async () => {
      const r = await parse(
        JSON.stringify({
          'editor.fontSize': 14,
          'editor.tabSize': 2,
          'files.autoSave': 'afterDelay',
        }),
        '.vscode/settings.json',
      );

      expect(r.metadata?.jsonDialect).toBe('vscode-settings');
      expect(r.symbols.some(s => s.name === 'editor.fontSize' && s.kind === 'constant')).toBe(true);
      expect(r.symbols.some(s => s.name === 'editor.tabSize' && s.kind === 'constant')).toBe(true);
      expect(r.symbols.some(s => s.name === 'files.autoSave' && s.kind === 'constant')).toBe(true);
    });
  });
});
