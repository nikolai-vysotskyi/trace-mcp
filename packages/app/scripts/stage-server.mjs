#!/usr/bin/env node

/**
 * Stage the trace-mcp server into `packages/app/server-payload/`, which
 * electron-builder ships as `Contents/Resources/server/` (see `extraResources`
 * in electron-builder.yml).
 *
 * Why the app carries a copy of the server at all: someone who installs the
 * DMG never runs `npm install -g trace-mcp`, so nothing ever writes
 * `~/.trace-mcp/launcher.env`, the LaunchAgent, or the daemon itself. The app
 * has to install its own daemon on a machine with no Node on it (TRA-438). It
 * can: Electron *is* a Node runtime — `ELECTRON_RUN_AS_NODE=1` on our own
 * binary runs `dist/cli.js` with no Node installed anywhere.
 *
 * What lands in the payload:
 *   dist/*.js      — the tsup bundle. Every pure-JS dependency is already
 *                    inlined (tsup.config.ts sets `noExternal` to everything),
 *                    so the only packages the daemon resolves at runtime are
 *                    the native/wasm ones listed in NATIVE_EXTERNALS there.
 *   node_modules/  — exactly those packages and their transitive closure.
 *   hooks/         — launcher shims, read by `trace-mcp init`.
 *   package.json   — the server's own version, read by the CLI.
 *
 * Deliberately NOT included: `@huggingface/transformers`. It is an
 * optionalDependency for a reason — it drags onnxruntime-node and sharp for
 * local embeddings the desktop app already gets from Ollama
 * (packages/app/src/main/ollama-control.ts), and the server's code paths
 * already tolerate its absence. Also excluded: `*.map` and `*.d.ts`, which are
 * 60 MB of the 65 MB `dist/` and nothing reads at runtime.
 *
 * Native modules ship as installed for Node, not rebuilt for Electron: all of
 * them are N-API, so the same `.node` loads under both ABIs. They are, however,
 * built for the *host* architecture, which is why this refuses to stage a
 * cross-architecture build — see assertNativeArch below.
 *
 * Wired to electron-builder's `beforePack` hook, never a separate CI step, so
 * a build cannot forget it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..');
const PAYLOAD = path.join(APP_ROOT, 'server-payload');

/**
 * Keep in sync with NATIVE_EXTERNALS in `tsup.config.ts`, minus
 * `@huggingface/transformers` (see header). `sqlite-vec` is not in that list —
 * it is loaded as a sqlite extension at runtime rather than bundled — so it is
 * named here explicitly.
 */
export const PAYLOAD_ROOTS = [
  'better-sqlite3',
  '@parcel/watcher',
  'oxc-resolver',
  'web-tree-sitter',
  'tree-sitter-wasm',
  '@ast-grep/napi',
  '@vue/compiler-sfc',
  'sqlite-vec',
];

function resolvePackageDir(name, from) {
  let dir = from;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Transitive closure of `roots` over dependencies + optionalDependencies,
 * resolved against the already-installed tree so versions match the lockfile
 * exactly and nothing is fetched at build time.
 *
 * An uninstalled *optional* dependency is not an error — pnpm skips the ones
 * whose `os`/`cpu` don't match this machine, and those are exactly the ones a
 * build for this machine must not ship. A missing *required* dependency is.
 */
export function collectClosure(roots, from, resolve = resolvePackageDir) {
  const found = new Map(); // name -> real directory
  const missing = [];
  const visit = (name, base) => {
    if (found.has(name)) return;
    const dir = resolve(name, base);
    if (!dir) {
      missing.push(name);
      return;
    }
    const real = fs.realpathSync(dir);
    found.set(name, real);
    const pkg = JSON.parse(fs.readFileSync(path.join(real, 'package.json'), 'utf-8'));
    for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep, real);
    for (const dep of Object.keys(pkg.optionalDependencies ?? {})) {
      if (resolve(dep, real)) visit(dep, real);
    }
  };
  for (const root of roots) visit(root, from);
  return { found, missing };
}

/**
 * The staged `.node` binaries are whatever `pnpm install` compiled or fetched
 * for the machine running this. electron-builder will happily package them
 * into a bundle for another architecture, and the result is a DMG whose daemon
 * dies on first launch with ERR_DLOPEN_FAILED — invisible until a user on that
 * architecture downloads it. Refuse instead.
 */
export function assertNativeArch(targetArch, hostArch = process.arch) {
  if (!targetArch || targetArch === hostArch) return;
  throw new Error(
    `refusing to stage the server payload for ${targetArch} on a ${hostArch} host: ` +
      `the bundled native modules (better-sqlite3, @ast-grep/napi, @parcel/watcher, oxc-resolver) ` +
      `are built for ${hostArch} and would fail to load. Build each architecture on a runner of ` +
      `that architecture.`,
  );
}

/** Copy a tree, dereferencing symlinks (pnpm's store is all symlinks). */
function copyTree(src, dest, filter) {
  fs.cpSync(src, dest, { recursive: true, dereference: true, filter });
}

export function stageServer({ targetArch } = {}) {
  assertNativeArch(targetArch);

  const distDir = path.join(REPO_ROOT, 'dist');
  if (!fs.existsSync(path.join(distDir, 'cli.js'))) {
    throw new Error(
      `${path.join(distDir, 'cli.js')} is missing — run \`pnpm run build\` at the repo root before packaging the app`,
    );
  }

  fs.rmSync(PAYLOAD, { recursive: true, force: true });
  fs.mkdirSync(PAYLOAD, { recursive: true });

  copyTree(distDir, path.join(PAYLOAD, 'dist'), (src) => {
    const base = path.basename(src);
    return !base.endsWith('.map') && !base.endsWith('.d.ts');
  });

  copyTree(path.join(REPO_ROOT, 'hooks'), path.join(PAYLOAD, 'hooks'));

  // A trimmed manifest, not a copy of the root one. `type: module` is what
  // makes Node treat the ESM bundle in dist/ as ESM, and the CLI reads its own
  // version out of `version`; the rest of the root manifest is build-time
  // configuration that only confuses tooling that stumbles into the payload.
  const rootPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
  fs.writeFileSync(
    path.join(PAYLOAD, 'package.json'),
    `${JSON.stringify(
      {
        name: rootPkg.name,
        version: rootPkg.version,
        type: rootPkg.type,
        bin: rootPkg.bin,
        engines: rootPkg.engines,
        private: true,
      },
      null,
      2,
    )}\n`,
  );

  // Read by src/updater.ts::isAppBundled. Without it the bundled daemon tries
  // to `npm install -g trace-mcp` over itself on every start — a copy npm
  // cannot reach, so it fails once per launch, forever.
  fs.writeFileSync(
    path.join(PAYLOAD, 'bundled-in-app'),
    'This copy of trace-mcp ships inside the desktop app. The app updates it.\n',
  );

  const { found, missing } = collectClosure(PAYLOAD_ROOTS, REPO_ROOT);
  if (missing.length > 0) {
    throw new Error(
      `native payload dependencies not installed: ${missing.join(', ')} — run \`pnpm install\` at the repo root`,
    );
  }
  for (const [name, dir] of found) {
    copyTree(dir, path.join(PAYLOAD, 'node_modules', name));
  }

  const { version } = JSON.parse(fs.readFileSync(path.join(PAYLOAD, 'package.json'), 'utf-8'));
  console.log(`[stage-server] staged trace-mcp ${version} + ${found.size} packages → ${PAYLOAD}`);
  return { version, packages: found.size };
}

/** electron-builder `beforePack` entry point. */
export default function beforePack(context) {
  stageServer({ targetArch: context?.arch === undefined ? undefined : archName(context.arch) });
}

/** electron-builder passes `Arch` enum values, not strings. */
function archName(arch) {
  // electron-builder's Arch enum: ia32=0, x64=1, armv7l=2, arm64=3, universal=4.
  return ['ia32', 'x64', 'armv7l', 'arm64', 'universal'][arch] ?? String(arch);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stageServer();
}
