# Contributing to trace-mcp

Thank you for your interest in contributing!

## Contributor License Agreement (CLA)

Before your pull request can be merged, you must sign the [Contributor License Agreement](https://cla-assistant.io/nikolai-vysotskyi/trace-mcp). This is a one-time process — CLA Assistant will prompt you automatically when you open a PR.

The full CLA text is available in [CLA.md](CLA.md). Key points:

- You **keep your copyright** — the CLA is a license grant, not an assignment.
- You grant the maintainer a broad, perpetual license to use, sublicense, and distribute your contributions under any license terms (including commercial).
- You grant a patent license for claims necessarily infringed by your contribution.
- You represent that the work is original and you have authority to contribute it.
- All contributions remain subject to the [Ethical Use Addendum](LICENSE).

### Commit identity for AI agents

`license/cla` matches a commit's author against a **GitHub login**. An address like
`some-agent@users.noreply.github.com` belongs to no account, resolves to no login, and the
check sits at `pending` forever — the PR looks red even when every required check is green.

So: **do not override the repository's git identity when committing.** Leave `user.name` /
`user.email` as configured for the checkout and record which agent did the work as a message
trailer instead:

```
fix(indexer): skip symlinked dirs during walk

Agent: Design/UX Agent
```

Use a plain `Agent:` trailer, not `Co-authored-by:` — a co-author address that maps to no
GitHub account re-creates the same unresolvable check.

## Review Model

trace-mcp currently has a single maintainer with commit access. `master` is protected by required status checks (CodeQL, Semgrep, `impact-report`) — these run on every PR and must pass before merge. There is no required-approving-review count: with one collaborator, a "1 approval" rule can never be satisfied by anyone but the PR author, so it was dropped rather than kept as a check that always reads "satisfied" without anyone having looked. If a second maintainer joins, review requirements will be reinstated.

Branch protection deliberately does **not** require a branch to be up to date with `master`
before merging (`strict: false`, set 2026-09-01). The four required checks — CodeQL,
`Semgrep scan`, `impact-report`, `scope-guard` — all read the pull request's own diff, so
re-running them against a base that moved five minutes ago adds no signal. Work lands here
from several agents in parallel and `master` moves faster than those checks take to finish,
so requiring an up-to-date branch turned every merge into a race that most attempts lost:
update the branch, wait ~4 minutes for the scans, find the branch behind again. Correctness
against a moving base is what `test` and `build` are for — they run on every PR and again on
`master` after merge. Don't switch strict mode back on to fix a bad merge; set up GitHub's
merge queue instead, which handles the same problem without the busy-wait.

## How to Contribute

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-change`)
3. Make your changes
4. Run tests (`pnpm test`)
5. Commit and push
6. Open a Pull Request

## Development

This project uses [pnpm](https://pnpm.io/) as its package manager — the version is pinned via the `packageManager` field in `package.json`. The simplest way to match it is via [Corepack](https://nodejs.org/api/corepack.html):

```bash
corepack enable
corepack prepare pnpm@10.33.0 --activate
pnpm install
pnpm run build
pnpm test
```

npm/yarn are not officially supported for contributor workflows — please use pnpm to ensure the lockfile and script set stay consistent.

### Changing the desktop app's UI

Read **[DESIGN.md](DESIGN.md)** first. It is the design system the app is actually built on — tokens, type scale, 4pt geometry, the glass-on-navigation-only material model, the `lattice/ui` primitives, and the accessibility floors — plus a review checklist to run against a new screen. Colour and contrast are enforced in CI by `packages/app/scripts/design-tokens.mjs`: a new raw hex or Tailwind grey in the renderer, or any text token under 4.5:1, fails the build.

### The desktop app ships the server

A DMG user never runs npm, so the app carries its own copy of the server and
installs the daemon itself on first launch and after every version change
(`packages/app/src/main/daemon-install.ts`). It runs that copy through the app's
own binary with `ELECTRON_RUN_AS_NODE=1`, which is why the DMG needs no Node on
the machine at all.

`packages/app/scripts/stage-server.mjs` assembles the payload from `dist/` plus
the handful of packages tsup leaves external. Two consequences for a change to
the server's dependencies:

- **A new native or wasm dependency must be added to `NATIVE_EXTERNALS` in
  `tsup.config.ts` AND to `PAYLOAD_ROOTS` in that script.** A test fails if the
  two drift, because a package missing from the payload is a daemon that starts
  fine from npm and dies inside the DMG.
- **Both macOS architectures are packaged from one runner**, because
  electron-updater needs a single `latest-mac.yml` listing both. That works
  because `pnpm.supportedArchitectures` in the root `package.json` installs
  every platform package for both architectures and the stage script picks the
  target's. A new native dependency that resolves its binary any other way
  needs its own answer here — `assertStagedArch` fails the build if the payload
  ends up with nothing loadable on the target.

## License

All contributions are licensed under the [MIT License](LICENSE).
