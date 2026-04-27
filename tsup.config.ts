import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Plugin } from 'esbuild';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

/**
 * Node's ESM loader mis-resolves CJS packages when the install path contains
 * an unescaped space (e.g. Herd's `~/Library/Application Support/Herd/...`).
 * Wrapping each native package in `createRequire` bypasses the ESM→CJS
 * translator and uses Node's CJS resolver, which handles spaced paths.
 *
 * We keep native/wasm packages external (they can't be bundled), but rewrite
 * the import site to load via createRequire. Pure-JS deps are inlined below
 * via `noExternal`, so they never hit the runtime resolver at all.
 */
const NATIVE_EXTERNALS = [
  'better-sqlite3',
  '@parcel/watcher',
  'oxc-resolver',
  'web-tree-sitter',
  '@huggingface/transformers',
  'tree-sitter-wasms',
  // Pure JS, but pulls dynamic requires on dozens of optional template
  // engines (marko, twig, coffee-script, etc.) via `consolidate` — not
  // bundle-able. Keep external, load via createRequire.
  '@vue/compiler-sfc',
];

const buildRequire = createRequire(import.meta.url);

function cjsViaCreateRequire(): Plugin {
  return {
    name: 'cjs-via-createRequire',
    setup(build) {
      const filter = new RegExp(
        '^(' +
          NATIVE_EXTERNALS.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') +
          ')(/.*)?$',
      );
      build.onResolve({ filter }, (args) => {
        if (args.kind === 'entry-point') return null;
        return { path: args.path, namespace: 'cjs-shim' };
      });
      build.onLoad({ filter: /.*/, namespace: 'cjs-shim' }, (args) => {
        let namedExportsSrc = '';
        try {
          const mod = buildRequire(args.path) as Record<string, unknown>;
          if (mod && typeof mod === 'object') {
            const keys = Object.keys(mod).filter(
              (k) => k !== 'default' && /^[_a-zA-Z][_a-zA-Z0-9]*$/.test(k),
            );
            namedExportsSrc = keys
              .map((k) => `export const ${k} = _m[${JSON.stringify(k)}];`)
              .join('\n');
          }
        } catch {
          // Optional deps (e.g. @huggingface/transformers) may not be installed;
          // emit a default-only shim that throws on use if that's the case.
        }
        return {
          contents: `import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);
const _m = _require(${JSON.stringify(args.path)});
const _default = _m && _m.__esModule && 'default' in _m ? _m.default : _m;
export default _default;
${namedExportsSrc}`,
          loader: 'js',
        };
      });
    },
  };
}

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.ts',
    // Worker entry. Built next to cli.js so the pool can resolve it via
    // `new URL('./extract-worker.js', import.meta.url)`.
    'extract-worker': 'src/indexer/extract-worker.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: process.env.TSUP_TARGET || 'node20',
  splitting: false,
  // Force-bundle all dependencies into the output. Natives matched by the
  // plugin below are rewritten to `createRequire(...)` shims; everything else
  // is inlined so the runtime never resolves node_modules.
  noExternal: [/.*/],
  external: NATIVE_EXTERNALS,
  esbuildPlugins: [cjsViaCreateRequire()],
  // Bundled CJS modules call `require('events')` etc. at runtime. In an ESM
  // output there is no real `require`, so esbuild stubs one that throws on
  // dynamic calls. Inject a real CJS require via createRequire so built-in
  // modules (and our native shims) resolve.
  banner: {
    js: `import { createRequire as __tmcpCreateRequire } from 'node:module';
const require = __tmcpCreateRequire(import.meta.url);`,
  },
  define: {
    PKG_VERSION_INJECTED: JSON.stringify(version),
  },
});
