import { readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Plugin } from 'esbuild';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

// tsup runs every config object in the array below concurrently, each as its
// own esbuild pass. A per-config `clean: true` races the other pass's writes
// — whichever runs its "clean" step last wins, and can delete outputs the
// other pass already finished writing. Wipe dist/ exactly once here, before
// either pass starts, and leave `clean: false` on both configs below.
rmSync('dist', { recursive: true, force: true });

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
  'tree-sitter-wasm',
  // NAPI binding with platform-specific .node binaries — not bundle-able.
  // Used by the AST codemod engine (src/tools/refactoring/codemod-ast.ts).
  '@ast-grep/napi',
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

/**
 * Keep `./local-backend.js` and `./snapshot-backend.js` (StdioSession's
 * dynamic imports in session.ts) genuine runtime imports instead of inlined
 * modules — used ONLY for the `proxy` build below.
 *
 * `external: [...]` alone does not do this: it only takes effect where esbuild
 * resolves the specifier itself, and the catch-all `noExternal` wins that
 * resolution for every path, native packages included — which is exactly why
 * they need `cjsViaCreateRequire()`'s onResolve above to get a real, if
 * different, escape hatch. This plugin is the equivalent one for plain
 * project files: it intercepts resolution before `noExternal` ever gets a say
 * and marks the result `external: true` directly, so proxy.js keeps a literal
 * `import('./local-backend.js')` / `import('./snapshot-backend.js')` instead
 * of inlining either one's whole dependency tree (PluginRegistry,
 * better-sqlite3, tree-sitter, the full MCP tool surface) — TRA-970.
 *
 * Deliberately NOT applied to the cli/index build below: cli.js already pulls
 * in that whole tree through its own commands (`add`, `search`, `serve-http`,
 * ...), so externalizing there buys zero RSS and only adds first-use latency —
 * which would blow TRA-948's <400ms snapshot-fast-path budget the moment a
 * session actually takes that path. Scoping this to the proxy build is what
 * keeps both budgets: proxy.js never pays either tree unless it needs to,
 * cli.js's snapshot path stays exactly as fast as TRA-948 shipped it.
 */
function heavyBackendsExternal(): Plugin {
  return {
    name: 'heavy-backends-external',
    setup(build) {
      build.onResolve({ filter: /^\.\/(local|snapshot)-backend\.js$/ }, (args) => {
        if (args.kind === 'entry-point') return null;
        return { path: args.path, external: true };
      });
    },
  };
}

const common = {
  format: ['esm'],
  dts: true,
  sourcemap: true,
  target: process.env.TSUP_TARGET || 'node22',
  splitting: false,
  // Force-bundle all dependencies into the output. Natives matched by the
  // plugin below are rewritten to `createRequire(...)` shims; everything else
  // is inlined so the runtime never resolves node_modules.
  noExternal: [/.*/],
  external: NATIVE_EXTERNALS,
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
    // Default GA4 Measurement Protocol credentials for the anonymous
    // active-install ping (src/telemetry/usage-ping.ts), supplied by CI from
    // TRACE_MCP_GA_MEASUREMENT_ID/TRACE_MCP_GA_API_SECRET in the `npm` GitHub
    // Actions environment.
    //
    // These are PUBLIC BY DESIGN, not confidential: inlining them here means
    // they ship as plaintext literals in every published dist/ bundle and are
    // readable by anyone who runs `npm install trace-mcp`. A GA4 Measurement
    // Protocol api_secret is write-only — it cannot read the property — so the
    // exposure is bounded to "anyone can send us fake events". They live in
    // GitHub secrets for convenience of rotation, not for confidentiality.
    // Rotating them changes nothing; the next release republishes the new
    // value. See SECURITY.md "Telemetry Credentials".
    //
    // Local dev builds get empty strings, so the ping stays inert unless the
    // runtime env vars of the same name are set. Fully disabled at runtime
    // via TRACE_MCP_TELEMETRY=off.
    GA_MEASUREMENT_ID_INJECTED: JSON.stringify(process.env.TRACE_MCP_GA_MEASUREMENT_ID ?? ''),
    GA_API_SECRET_INJECTED: JSON.stringify(process.env.TRACE_MCP_GA_API_SECRET ?? ''),
  },
} as const;

export default defineConfig([
  {
    ...common,
    entry: {
      index: 'src/index.ts',
      cli: 'src/cli.ts',
      // Worker entry. Built next to cli.js so the pool can resolve it via
      // `new URL('./extract-worker.js', import.meta.url)`.
      'extract-worker': 'src/indexer/extract-worker.ts',
    },
    // dist/ is wiped once above, before either config runs — see the rmSync
    // comment at the top of this file.
    clean: false,
    esbuildPlugins: [cjsViaCreateRequire()],
  },
  {
    ...common,
    entry: {
      // Thin stdio<->daemon proxy (TRA-970). The launcher shim execs this
      // directly instead of cli.js when a daemon is already reachable, so it
      // must never drag in Commander, PluginRegistry, better-sqlite3 or
      // tree-sitter — see `heavyBackendsExternal()` above, which is what
      // actually keeps that tree out of this bundle.
      proxy: 'src/proxy-entry.ts',
      // StdioSession's local (non-daemon) fallback, built as its own sibling
      // file in flat dist/ (same convention extract-worker.js relies on) so
      // proxy.js's dynamic `import('./local-backend.js')` resolves to a real,
      // separately-loaded chunk instead of being inlined.
      'local-backend': 'src/daemon/router/local-backend.ts',
      // StdioSession's instant-snapshot backend (TRA-948) — same reasoning.
      // Only reachable from proxy.js: proxy-entry.ts disables the snapshot
      // fast path (`trySnapshotFastPath: false`), since the launcher shim
      // already confirmed a daemon is reachable before launching it, so
      // there's nothing here for it to actually swap in from.
      'snapshot-backend': 'src/daemon/router/snapshot-backend.ts',
    },
    // dist/ is wiped once above, before either config runs.
    clean: false,
    esbuildPlugins: [cjsViaCreateRequire(), heavyBackendsExternal()],
  },
]);
