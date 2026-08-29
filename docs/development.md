---
title: "Contributing to trace-mcp — local setup, build, and test"
description: "How to set up trace-mcp for local development: install, build, run the test suite, and the conventions to follow before opening a PR."
updated: 2026-08-29
---

# Development

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "TechArticle",
  "headline": "Development",
  "description": "Local setup, build, and test instructions for contributing to trace-mcp.",
  "url": "https://trace-mcp.com/development.html",
  "datePublished": "2026-04-05",
  "dateModified": "2026-05-08",
  "author": {
    "@type": "Person",
    "name": "Nikolai Vysotskyi",
    "url": "https://github.com/nikolai-vysotskyi"
  },
  "publisher": {
    "@type": "Person",
    "name": "Nikolai Vysotskyi",
    "url": "https://github.com/nikolai-vysotskyi"
  },
  "mainEntityOfPage": {
    "@type": "WebPage",
    "@id": "https://trace-mcp.com/development.html"
  }
}
</script>
## Setup

```bash
git clone https://github.com/nikolai-vysotskyi/trace-mcp.git
cd trace-mcp
pnpm install
pnpm run build
```

## Scripts

| Script | What it does |
|---|---|
| `pnpm run build` | TypeScript compilation via tsup |
| `pnpm run dev` | Watch mode (tsup --watch) |
| `pnpm run test` | Run all tests (vitest) |
| `pnpm run test:watch` | Watch mode for tests |
| `pnpm run typecheck` | TypeScript type checking (`tsc --noEmit`) |
| `pnpm run lint` | Same as `typecheck` (legacy alias) |
| `pnpm run format` | Auto-format the repo with Biome |
| `pnpm run format:check` | Check formatting without writing |
| `pnpm run biome:ci` | Full Biome check (formatter + linter) — same as CI |
| `pnpm run serve` | Start MCP server (dev) |
| `node scripts/capture-screenshots.mjs` | Regenerate every docs/site screenshot from a seeded demo state |
| `pnpm --filter trace-mcp-app run check:i18n` | Fail on a user-facing string left inline in an extracted surface |

## Code style — Biome

Formatter and linter are unified under [Biome](https://biomejs.dev). Config lives in `biome.jsonc` at the repo root.

- **Formatter**: 2-space indent, single quotes, semicolons, trailing comma all, 100-col line width. Runs across `src/`, `tests/`, and `packages/app/`.
- **Linter**: only a hand-picked subset is enabled as errors today (correctness + style + selected complexity rules). `recommended: false` — we ramp rules in incrementally rather than turning them all on at once. See `biome.jsonc` for the current set.
- **Pre-commit hook**: `simple-git-hooks` + `lint-staged` run `biome check --write` only on staged files. Set `SKIP_SIMPLE_GIT_HOOKS=1` to bypass for emergencies.
- **CI**: a fast `biome` job runs `biome ci --diagnostic-level=error` and gates the heavier `impact-report` and `app-typecheck` jobs.
- **Editor**: `.vscode/extensions.json` recommends the official `biomejs.biome` extension. JetBrains users can install the [Biome plugin](https://plugins.jetbrains.com/plugin/22761-biome).
- **`git blame`**: `.git-blame-ignore-revs` lists the formatter mass-pass commit. Enable locally with `git config blame.ignoreRevsFile .git-blame-ignore-revs`. GitHub honors it on the web.

### Ramping new lint rules

When promoting a new rule:

1. Add it to `biome.jsonc` at severity `warn` first to see the blast radius (`pnpm exec biome lint --reporter=summary`).
2. If the rule has a safe auto-fix, run `pnpm exec biome lint --write --only=<rule-id>`. Review the diff.
3. For unsafe fixes (e.g. `useExhaustiveDependencies` removing deps, `useButtonType` guessing `type="button"`): hand-fix or scope via `overrides` in `biome.jsonc`.
4. Once violations hit zero, promote severity to `error`.
5. Mass-fix commits should be added to `.git-blame-ignore-revs`.

### Remaining warning burndown

`pnpm run biome:ci` exits clean (**0 errors**). The remaining warnings are the
`noExplicitAny` backlog (~170, scoped to `src/` and `packages/app/` — tests are
overridden to `off` because mocks and AST fixtures intentionally use `any`).

These should be fixed incrementally as files are touched, and require real
domain types — not blanket replacement with `unknown`:

- **Python parsers** (`src/indexer/plugins/integration/{framework/fastapi,framework/flask,orm/sqlalchemy}/index.ts`) — tree-sitter `TSNode` shape varies per language; the existing `any` casts should become discriminated unions over node `type`.
- **CLI surface** (`src/cli.ts`) — Commander.js untyped `opts` objects; should be replaced with per-command `interface CliOpts`.
- **Analytics store** (`src/analytics/`) — `better-sqlite3` row callbacks; `Row` types should be defined per query.
- **Doc/refactoring tools** (`src/tools/{project,refactoring,framework,analysis,quality}/*`) — generic graph visitor patterns; need per-visitor type unions.

Promote `suspicious/noExplicitAny` from warn to error once the backlog is gone.

## Tests

```bash
pnpm run test                       # All tests (1668 tests, ~2s)
pnpm run test --run <pattern>  # Run specific test files
pnpm run test:watch             # Watch mode
```

Test files live alongside source or in `tests/`:

```
tests/
├── ai/              # AI pipeline tests
├── ci/              # CI report generator and formatter tests
├── frameworks/      # Framework plugin tests (per-framework)
├── tools/           # MCP tool integration tests
├── integration/     # End-to-end indexing tests
├── e2e/             # CLI and protocol tests
├── db/              # Database layer tests
├── indexer/         # Indexing pipeline tests
├── parsers/         # Language parser tests
├── resolvers/       # Module resolver tests
├── scoring/         # Scoring algorithm tests
└── fixtures/        # Test fixtures (sample projects)
```

---

## Desktop app strings and languages

The app is translated (TRA-379). Every user-facing string lives in a catalogue, not in
the component that renders it, and English is the source language.

```
packages/app/src/shared/i18n/
  locales.ts              # which languages ship, their names, the localStorage key
  catalog/en/<surface>.ts # the strings, one file per surface (= one i18next namespace)
  catalog/ru/<surface>.ts # its translation, same keys
packages/app/src/renderer/i18n/
  index.ts                # i18next init, setLocale, useLocale, t
  format.ts               # Intl wrappers: relativeTime, formatDate, formatNumber
packages/app/src/main/
  i18n.ts                 # the main process's own i18next instance, and its t
  locale.ts               # the choice mirrored to userData, so main can read it
```

**Why i18next.** Plurals. Russian needs four forms where English needs two, and the
only correct way to choose one is `Intl.PluralRules` — which i18next drives, along
with interpolation and a runtime language switch. We install the resolver and none of
its optional backends or detectors, because the catalogues are compiled in: a desktop
app should not wait on a fetch to paint its first label.

**Adding a string.** Put it in `catalog/en/<surface>.ts` (create the file and add one
line to `catalog/en/index.ts` if the surface is new — one file per surface is what
keeps two extraction slices from editing the same catalogue), add the same key to
every other language, then read it in the component:

```tsx
const { t } = useTranslation('settings');   // components: re-renders on a switch
t('title');
t('projectCount', { count });                // plurals: one key, never a ternary
```

Module-level helpers that are not components import `t` from `renderer/i18n` instead.
Never concatenate a sentence, and never format a date or a number by hand — use
`renderer/i18n/format.ts`.

**Adding a language.** Add it to `LOCALES` in `shared/i18n/locales.ts`, copy
`catalog/en/` to `catalog/<code>/` and translate it. `catalog-parity.test.ts` then
fails until every key exists and every `{{placeholder}}` survived; nothing else needs
wiring, and the Language control picks the new entry up from `LOCALES`.

**The checks.**

```bash
pnpm --filter trace-mcp-app run check:i18n   # no inline strings in extracted surfaces
pnpm --filter trace-mcp-app run test         # catalogue parity, plurals, Intl output
```

`check-i18n.mjs` scans an allowlist, not the whole tree: string extraction lands
surface by surface, and the `CHECKED` array at the top of the script is how a finished
slice records that it is finished. Extract a surface → add its path there.

**The main process** (the application menu, the tray, dialogs) has no React and
cannot read the renderer's `localStorage`, so the language is mirrored to a one-line
file in `userData` — exactly the arrangement `main/appearance.ts` uses for the theme.
The renderer's `setLocale` sends `set-locale` over IPC, and `main/menu.ts` writes the
file, switches its instance and rebuilds both surfaces: `Menu.setApplicationMenu`
replaces the menu wholesale, there is no per-item relabel. Main-process code calls
`t('menu:file')` from `main/i18n`. Standard macOS items stay on their Electron
`role` — the OS supplies those labels already translated, and hand-translating one
is how a menu ends up half in each language.

## Desktop app update channels

The Electron app updates itself differently per platform, and the split is
deliberate. `packages/app/src/main/update-channel.ts` is the single place that
decides which one a platform gets; no platform ever runs both.

| Platform | Mechanism | Why |
| --- | --- | --- |
| macOS | Staged zip (`scripts/postinstall-app.mjs` + `scripts/apply-pending-update.mjs`) | Squirrel.Mac, which electron-updater uses on macOS, validates the replacement bundle's code signature. We ship ad-hoc signed (`Signature=adhoc`, `TeamIdentifier=not set`), so it would need a paid Apple Developer ID — ruled out. The npm postinstall drops a verified zip next to the `.app` and a detached helper swaps the bundle on exit. |
| Windows | `electron-updater` + NSIS | Windows imposes no signature requirement on the swap, so the standard mechanism works unsigned. Driven by `latest.yml`, generated from the `win.publish` block in `packages/app/electron-builder.yml` and uploaded to the GitHub release by `.github/workflows/release.yml`. A missing `latest.yml` fails the release. |
| Linux | none | No packaged target today (`linux.target: []`). |

Consequences worth knowing before touching this:

- `publish` lives under `win:`, not at the top level. Hoisting it would make
  electron-builder emit `latest-mac.yml` and point macOS installs at an update
  path that cannot succeed.
- `electron-updater` is the app's only production `dependency`. Everything the
  renderer imports is bundled by Vite and therefore belongs in
  `devDependencies` — that is what keeps the packaged `node_modules` small.

---

## Adding a new integration plugin

1. Create a directory under the appropriate category in `src/indexer/plugins/integration/`:

```
src/indexer/plugins/integration/framework/my-framework/
├── index.ts
└── helpers.ts (optional)
```

2. Implement `FrameworkPlugin`:

```typescript
import { FrameworkPlugin, PluginManifest } from '../../../../plugin-api/types.js';

const manifest: PluginManifest = {
  name: 'my-framework',
  version: '1.0.0',
  languages: ['typescript'],
  priority: 20,
};

export const MyFrameworkPlugin: FrameworkPlugin = {
  manifest,

  detect(ctx) {
    // Check package.json, config files, etc.
    return ctx.hasDependency('my-framework');
  },

  registerSchema() {
    return {
      nodeTypes: ['my_framework_route'],
      edgeTypes: ['my_framework_handles'],
    };
  },

  extractNodes(filePath, content, language) {
    // Parse file and return symbols
    return { symbols: [], edges: [] };
  },

  resolveEdges(ctx) {
    // Resolve cross-file relationships
    return [];
  },
};
```

3. Register the plugin in `src/indexer/plugins/integration/framework/index.ts` (or the appropriate category index).

4. Write tests in `tests/frameworks/my-framework.test.ts`.

---

## Adding a new language plugin

1. Create files in `src/indexer/plugins/language/my-lang/`:

```
src/indexer/plugins/language/my-lang/
├── index.ts
└── helpers.ts
```

2. Use tree-sitter for parsing. See existing plugins for patterns (e.g., `typescript/index.ts`).

3. Register in `src/indexer/plugins/language/index.ts`.

---

## Plugin test harness

The `src/plugin-api/test-harness.ts` module provides utilities for testing plugins in isolation:

```typescript
import { createTestHarness } from '../src/plugin-api/test-harness.js';

const harness = createTestHarness(MyPlugin);
const result = await harness.indexFile('test.ts', sourceCode);
expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'myFunction' }));
```

---

## Desktop app updates — the staged-zip path is the only one

**Decision (TRA-357):** the desktop app updates through our own staged-zip flow.
`electron-updater` is not a fallback and is not planned. Releases publish
`*-mac.zip` / `*-arm64-mac.zip` / `Setup.exe` plus `.sha256` siblings — there is
no `latest-mac.yml` and no DMG, so `electron-updater` has no feed to read. We
either commit to one path or maintain two half-working ones; this is the commit.

The flow, and where each part lives:

1. `npm install -g trace-mcp` runs `scripts/postinstall-app.mjs`. It locates the
   installed bundle via `scripts/locate-app.mjs`, downloads the release zip,
   verifies its SHA-256 against the release's checksum asset, and — because the
   app is usually running — stages `.trace-mcp-pending.zip` next to the `.app`.
2. On quit or restart, `scripts/apply-pending-update.mjs` swaps the bundle.
3. `packages/app/src/main/index.ts` owns the in-app side: the `apply-update` IPC
   runs the npm install, and `repairStaleBundle()` re-runs the postinstall
   out-of-band when the CLI moved but the bundle did not.

Two invariants this path depends on:

- **Only an installed bundle may become the update target.** An
  `electron-builder` output under `release/mac-arm64/` is a real, correctly
  signed-looking bundle, so plist validation alone accepts it;
  `isPlausibleInstallPath` (duplicated in `scripts/locate-app.mjs` and
  `packages/app/src/main/install-path.ts`, kept honest by
  `install-path.test.ts`) is what rejects build trees and checkouts. Recording
  one in `~/.trace-mcp/app-location.json` froze a user's install for three
  major versions.
- **A bundle that could not be replaced is never reported as up to date.** The
  suppression marker in `update-state.ts` stops re-prompting, and the sidebar
  renders that state as "needs a manual install" with a release link.

## Screenshots — one script, one seeded state

Every screenshot in `README.md` and on trace-mcp.com is produced by
`scripts/capture-screenshots.mjs`. Do not take them by hand: hand-taken shots
carry whatever happened to be on the machine — a developer's own project list,
a `Daemon unreachable` banner, half-loaded skeletons — and nothing records what
version of the app they show.

```bash
pnpm run build                       # the CLI bundle the demo daemon runs from
pnpm --dir packages/app run build    # the renderer being photographed
node scripts/capture-screenshots.mjs             # regenerate everything
node scripts/capture-screenshots.mjs app-graph   # just one (marker left alone)
node scripts/capture-screenshots.mjs --check     # are the committed ones stale?
```

The run launches the real Electron window against a seeded demo state and
writes WebP files into `docs/images/`. It does not touch the daemon you already
have running, your `~/.trace-mcp`, or your project registry: the demo daemon
gets its own port and its own `TRACE_MCP_DATA_DIR`, the demo projects are
`git archive` extracts of this repo at HEAD placed under `/tmp/trace-mcp-demo`,
and Electron gets a throwaway Chromium profile. Nothing in the frame identifies
a machine or a person.

**The frame is a photograph of the window, not of the web contents.** macOS
draws the traffic lights, the rounded corners and the sidebar's vibrancy
outside the renderer, so `Page.captureScreenshot` — the obvious way to do this —
returns something indistinguishable from a browser tab, and that is what got
published once (TRA-390). Instead the script asks the main process for the
window's CGWindowID over its Node inspector and hands it to
`screencapture -o -l<id>`: the real window, no drop shadow, rounded corners
returned as alpha. This makes the script macOS-only, and it steals focus for
the length of the run — the window has to be key, or the buttons photograph
grey.

**Every frame is inspected before it becomes a file.** `checkWindowChrome`
looks for the two things a capture of the web contents can never have —
transparent rounded corners, and the three buttons in colour in the top-left
strip — and throws with the reason when either is missing. A chrome-less
capture fails the run instead of quietly replacing a good image.

**Adding a screenshot is a data change.** Append an entry to
`scripts/screenshots.manifest.json` — the surface to open, which controls to
click, the appearance, and the `alt` text — and re-run the script. The `alt` in
the manifest is the same string that belongs in `README.md` and
`docs/index.html`; keep them equal when a screenshot's content changes, because
stale alt text is both an accessibility bug and an SEO one.

**Freshness.** `docs/images/screenshots.json` records the app version and the
commit of the last change under `packages/app/src/renderer` / `src/main`.
`--check` compares that against HEAD and exits non-zero with a reason when the
UI has moved on — that is the signal the docs and SEO autopilots read, so they
never have to eyeball an image to know whether it is current.
