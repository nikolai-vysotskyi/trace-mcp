# Security Controls

trace-mcp indexes source code from local projects and exposes a dependency graph via MCP. This document describes the security controls that protect against common risks when handling arbitrary codebases.

---

## Path Traversal Prevention

All user-supplied paths are validated before any file is read.

* **`validatePath(filePath, rootPath)`** resolves both paths to absolute form and verifies the target starts with `rootPath + path.sep` (or equals `rootPath` exactly).
* Applied in `indexSingleFile()` (pipeline), `guardPath()` (MCP server tool handler), and `.env` indexing.
* Paths such as `../../etc/passwd` or absolute paths outside the project root are rejected with a `SECURITY_VIOLATION` error.

---

## Symlink Escape Protection

Symlinks can be used to escape the project root and read arbitrary files.

* **Symlinked files are always skipped at extraction time** — `fs.lstatSync()` detects symlinks without following them, regardless of any config setting. When a symlink is encountered during indexing, it is logged as a warning and excluded. This is a hard security boundary with no opt-out.
* **Directory symlinks are not followed during file discovery by default** (`follow_symlinks: false`). This prevents a directory symlink that cycles back to an ancestor — e.g. Ansible Molecule's `roles/<role>/molecule/<scenario>/roles/<role> -> ../../../` layout — from making the glob walker recurse until the OS raises `ENAMETOOLONG` (#218).
* Setting `follow_symlinks: true` only widens *discovery* (which directories the glob walker descends into) — it does not disable the always-on file-level symlink rejection above. Enable it only for trees known to be free of symlink cycles; on a tree with a cycle it can silently truncate traversal once fast-glob's internal error suppression kicks in.

---

## Default Ignore Policy

Files are filtered through multiple layers:

1. **Config exclude patterns** — directories excluded by default: `node_modules`, `.git`, `dist`, `build`, `.next`, `__pycache__`, `.venv`, `vendor`, `coverage`.
2. **File watcher ignore** — `@parcel/watcher` is configured with the same ignore list. Double filtering is applied (at subscription level and event processing level).
3. **`.traceignore`** — project-root file (gitignore syntax) that **completely excludes** matched files from indexing. Unlike `.gitignore` (which only hides content from AI output but keeps graph metadata), `.traceignore` prevents files from being parsed or stored at all. Intended for generated code, vendored dependencies, and large data files.
4. User-configurable `exclude` patterns and `ignore.directories` / `ignore.patterns` in the config file.

---

## Secret File Exclusion

Files matching known secret patterns are blocked from indexing entirely.

**Excluded patterns include:**

* Environment files: `.env`, `.env.*`, `*.env`
* Certificates & keys: `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.crt`, `*.cer`
* Keystores: `*.keystore`, `*.jks`
* Credential files: `*.credentials`, `*.token`, `*.secrets`, `credentials.json`, `service-account*.json`
* SSH keys: `id_rsa`, `id_rsa.*`, `id_ed25519`, `id_ed25519.*`, `id_dsa`, `id_ecdsa`
* Auth files: `.htpasswd`, `.netrc`, `.npmrc`, `.pypirc`
* Broad pattern: `*secret*` (with a documentation file exemption — `.md`, `.txt`, `.rst` files are not blocked by this pattern)

When a sensitive file is detected, a warning is logged. Sensitive files are never stored in the index.

---

## .env File Handling — Keys and Types Only

`.env` files receive special treatment. They are **not** indexed as regular source files. Instead, a dedicated parser (`env-parser.ts`) extracts only metadata:

* **Stored:** key name, value type (`string`, `number`, `boolean`, `empty`), value format (`url`, `email`, `uuid`, `dsn`, etc.), comment, quoted status, line number.
* **Never stored:** the actual value.

When `.env` files are read through MCP tools, values are redacted — e.g., `DATABASE_URL=postgres://...` becomes `DATABASE_URL=<string:url>`.

To completely exclude `.env` files from indexing (including metadata extraction), add them to `.traceignore`.

---

## File Size Limits

* **Default maximum:** 1 MB per file (configurable via `security.max_file_size_bytes` in config).
* Files exceeding the limit are skipped during indexing with a warning.
* Prevents out-of-memory conditions and excessive parsing time on generated or minified files.

---

## File Count Limit

* **Default maximum:** 10,000 files per indexing run (configurable via `security.max_files` in config).
* When the limit is exceeded, files are truncated with a warning — prevents runaway indexing in extremely large repositories or monorepos.
* Can be overridden for large projects that genuinely need more files indexed.

---

## Binary File Detection

Binary files are excluded using a two-stage check:

1. **Extension-based filtering** — `fast-glob` targets known source code extensions only; binary extensions are never matched.
2. **Content-based detection** — after reading a file, `isBinaryBuffer()` scans the first 8 KB for null bytes. Files containing null bytes are treated as binary and skipped, even if the extension suggests source code.

Tree-sitter parsers provide a third layer: non-parseable content is flagged as a parse error and excluded from the symbol graph.

---

## .gitignore Respect — Content Gating for AI

Files matching `.gitignore` patterns are **indexed for graph metadata** (symbols, edges, relationships) but their **source content is never served to AI models**.

* The project's `.gitignore` is parsed at the start of each indexing run.
* Matching files are flagged with `gitignored = 1` in the database.
* When MCP tools read source code (`readByteRange`, `readFileSafe`), gitignored files return `[content hidden — file is gitignored]` instead of actual source.
* The AI summarization pipeline skips gitignored files entirely.
* This mirrors the `.env` approach: metadata is available for graph traversal, but content is not exposed.

---

## Encoding Safety

* All file reads use explicit UTF-8 encoding (`'utf-8'` parameter or `Buffer.toString('utf8')`).
* Invalid UTF-8 bytes are automatically replaced with the Unicode replacement character (U+FFFD) by Node.js.
* Byte-range reads (`readByteRange()`) validate that `byteEnd > byteStart` and `byteStart >= 0`.
* Read errors are caught and logged — corrupted or inaccessible files do not crash the indexer.

---

## Code-Scanning Alert Triage Policy

CodeQL and Semgrep run on every push/PR with `security-extended` + OWASP/nodejsscan rulesets, which surfaces a structural false-positive shape specific to this codebase: **`js/path-injection`**. Nearly every MCP tool takes a `file_path`-shaped argument, and the sanitizer (`validatePath()` / `guardPath()`, see above) runs in the tool-registration wrapper (`src/tools/register/*.ts`) one call away from the implementation function CodeQL flags — interprocedural taint tracking doesn't follow the sanitizer across that boundary. Per the precedent set in alerts #1068/#1069 ("local read-only search under the registered project root, same trust domain as the CLI/MCP user"), this bucket is dismissed in bulk as **won't fix** whenever the flagged path either passes through `validatePath()`/`guardPath()` before use, or is sourced from already-validated indexed data (e.g. `file_path` columns populated at index time). New `js/path-injection` alerts should be checked against this pattern and dismissed with the same justification rather than left to accumulate — but a path that reaches a sink *without* going through the wrapper is a real bug, not this exception.

OpenSSF Scorecard contributes a second structural bucket: **`TokenPermissionsID` on `.github/workflows/release.yml`**. Scorecard flags any `contents: write`, but release-please *is* the release: it pushes release commits, creates tags, and publishes GitHub Releases, so the workflow cannot function without that scope. These alerts are dismissed as **won't fix** with the justification "release-please requires `contents: write` to create tags and releases; the permission is scoped to a job in a workflow gated on `master`", and re-dismissed the same way when a Scorecard run re-raises them. The exception is deliberately narrow — it covers `release.yml` only. A `contents: write` grant in any other workflow, or one at the top level rather than scoped to the job that needs it, is a real finding and gets fixed (as `ga4-snapshot.yml` was). Two adjacent Scorecard results are also expected and not gaps: `Signed-Releases: 0` reflects that release assets carry `actions/attest-build-provenance` attestations, which Scorecard does not look for (it only counts `.sig`/`.asc`/`.intoto.jsonl` uploaded as release assets), and the legacy branch-protection API reporting `allow_force_pushes: true` on `master` is overridden by the active `default` ruleset's `non_fast_forward` rule with an empty bypass list.

The remaining volume buckets (`ajinabraham.njsscan.dos.regex_dos`, `js/insecure-temporary-file`, `js/file-system-race`) are **not** covered by this exception — they involve regex-shape and TOCTOU analysis that has to be judged per call site, not by a single architectural argument, and a lazy blanket dismissal here would hide a real bug class (this tool is designed to scan arbitrary — including untrusted/third-party — codebases, so a crafted file triggering catastrophic backtracking in one of the scanner's own detection regexes is a plausible local DoS). These are tracked for individual review rather than dismissed.

---

## Artisan Command Whitelist

trace-mcp can optionally execute Laravel Artisan commands for runtime metadata (routes, models, events).

* **Only three read-only commands are allowed:** `route:list`, `model:show`, `event:list`.
* All other commands are rejected with a `SECURITY_VIOLATION` error.
* Prevents destructive operations like `migrate:fresh`, `db:seed`, or arbitrary command execution.

---

## Secret Pattern Detection

A regex-based content scanner can detect secrets in source files:

* **Default patterns:** `password`, `secret`, `token`, `key`, `credential`, `api_key`, `private_key` (case-insensitive).
* Customizable via `security.secret_patterns` in config.
* Used to flag files that may contain hardcoded secrets.

---

## Storage Safety

* The SQLite database lives outside the project, at `~/.trace/index/<name>-<hash>.db`. The location is not configurable.
* **WAL mode** enabled for safe concurrent reads during indexing + tool queries.
* **Foreign key constraints** enforced to maintain referential integrity.
* **Busy timeout** set to 5 seconds to handle lock contention gracefully.

---

## Error Handling

All security checks return structured `TraceMcpResult` values with a dedicated `SECURITY_VIOLATION` error code. Security violations are:

* Logged with context (file path, size, violation type).
* Returned to the caller as structured errors — never silently swallowed.
* Never exposed to MCP clients with internal path details beyond what is necessary.

---

## Dependency Hygiene

Transitive advisories are pinned to patched versions via `overrides` in `package.json`, so fixes apply even when upstream packages have not yet released a bump:

* `protobufjs >= 8.6.6` — closes the prototype-pollution RCE (GHSA-xq3m-2v4x-88gg) reachable through the optional `@huggingface/transformers` → `onnxruntime-web` chain.
* `hono >= 4.12.25` and `@hono/node-server >= 2.0.5` — closes cookie, `ipRestriction`, `serveStatic`, and `toSSG` path-traversal advisories reachable through `@modelcontextprotocol/sdk`.
* `vite >= 8.0.16` — closes the dev-server `fs.deny` bypass, `.map` path traversal, and WS file-read advisories reachable through `vitest`.
* `fast-uri >= 4.1.3` — closes four host-confusion / SSRF advisories reachable through `@modelcontextprotocol/sdk` → `ajv`.
* `qs >= 6.16.0` — closes the array-limit bypass and DoS advisories reachable through `@modelcontextprotocol/sdk` → `express` → `body-parser`.

The **0 vulnerabilities** invariant is enforced, not assumed: the `audit` job in `.github/workflows/ci.yml` runs `pnpm audit --prod --audit-level=moderate` on every push and PR, and a `moderate`-or-worse advisory in the production tree fails the build. An advisory we consciously accept is recorded in `pnpm.auditConfig.ignoreGhsas` in `package.json` — next to the `overrides`, so the exception is written down rather than remembered.

---

## Auto-Update Hardening (macOS Electron App)

The npm package ships a `postinstall` hook that keeps the optional menu-bar app (`~/Applications/trace-mcp.app`) in sync with the latest GitHub release. The hook is security-hardened to prevent a compromised release or MITM from silently replacing the installed app:

* **Opt-out:** Set `TRACE_MCP_NO_AUTO_UPDATE=1` to skip the hook entirely. `npm install --ignore-scripts` also disables it.
* **Scope:** Runs only on macOS, and only if `~/Applications/trace-mcp.app` already exists. Fresh machines are never touched by the hook.
* **SHA-256 verification:** A sibling checksum asset (`<zip>.sha256`, `SHASUMS256.txt`, or `checksums.txt`) is required in the release. The downloaded zip is hashed in-stream and compared; a missing or mismatched digest aborts the update without touching the installed app.
* **Gatekeeper verification:** The new bundle is extracted to a temp staging directory and validated with `/usr/sbin/spctl -a -t exec` before being swapped in. An unsigned or tampered bundle fails verification and is discarded.
* **Atomic swap with rollback:** The installed app is renamed to a backup path, the verified bundle is moved into place, and the backup is removed only on success. Any failure restores the original bundle.
* **No shell execution:** `unzip` is invoked via `execFileSync` (no shell), and asset names are restricted to `^[A-Za-z0-9._-]+\.zip$` to prevent argument injection via hostile release metadata.
* **Silent by design:** The hook still swallows all errors so a failed update never breaks `npm install`; the installed app is simply left at its current version.

Release workflow must publish the checksum asset (e.g., `shasum -a 256 trace-mcp-arm64.zip > trace-mcp-arm64.zip.sha256`). Without it, the updater no-ops.

---

## npm Package Provenance

Every release published from the `master` branch is signed with an npm provenance attestation via GitHub OIDC. The attestation links the published package to the exact source commit and the GitHub Actions workflow run that built it, making the entire build-to-publish pipeline auditable.

### Verifying provenance (consumers)

**Option 1 — npm CLI (npm ≥ 9.5 / Node 20+)**

```bash
npm audit signatures
```

This command verifies the registry signatures and provenance attestations for every package in your `node_modules`. A successful run prints `audited N packages` with no integrity errors.

**Option 2 — inspect on the npm registry**

Open `https://www.npmjs.com/package/trace-mcp` and click the **Provenance** badge on any version. The panel shows the source repository, the git tag, and a link to the Actions workflow run that produced the package.

**Option 3 — query the registry API**

```bash
npm view trace-mcp dist.attestations --json
```

The `attestations` field lists each sigstore bundle URL. Download and verify with the [sigstore CLI](https://github.com/sigstore/sigstore):

```bash
cosign verify-blob --bundle <bundle-url> <tarball>
```

### What the attestation covers

| Field | Value |
| --- | --- |
| Builder | `https://github.com/actions/runner` |
| Source repository | `https://github.com/nikolai-vysotskyi/trace-mcp` |
| Trigger | Push to `master` (release tag) or `workflow_dispatch` |
| Workflow | `.github/workflows/release.yml` |
| Build environment | `ubuntu-latest`, Node 22 |

A missing or invalid attestation means the package was **not** built by the official GitHub Actions pipeline and should be treated as suspect.

---

## CI Secret Scoping

A repository-level GitHub Actions secret is readable by **any** workflow in the
repo that names it, on any branch. The trigger on a given workflow file
(`on: push: branches: [master]`) protects that file, not the secret. Credentials
whose loss cannot be undone by rotating a config value therefore live in a
branch-gated **environment**, so they are simply not injected into a job running
outside a protected branch:

| Environment | Secrets | Consumer |
| --- | --- | --- |
| `apple-signing` | `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | `release.yml` :: `build-app-mac` |
| `npm` | npm publish (OIDC), `TRACE_MCP_GA_*` | `release.yml` :: `publish` |

`CSC_LINK` is the Developer ID Application private key: whoever holds it can
sign and notarize arbitrary software as *Mykola Vysotskyi (UWBRFD57K5)*, and the
only remedy is revoking the identity — which invalidates every artifact already
signed with it. That asymmetry is why it gets an environment and, for example,
`GA4_SA_KEY` (read-only analytics service account, consumed by
`ga4-snapshot.yml`) deliberately does not: rotating it costs one key swap.

Removing `environment:` from a job that consumes these secrets un-gates them
silently — the release still succeeds. Treat that line as part of the control.

---

## Repository Security Settings

Two controls live in GitHub's repository settings rather than in this repo, so
they are recorded here — settings have no diff and no reviewer.

* **Actions SHA pinning is enforced by the platform** (`sha_pinning_required:
  true`, enabled 2026-09-03). Every third-party action must be pinned to a full
  40-character commit SHA; `uses: some/action@v4` is rejected. All 17 `uses:`
  references were already SHA-pinned by review discipline when this was turned
  on, so the switch is a ratchet, not a migration.
* **Secret scanning covers provider patterns only, and cannot be widened on this
  plan.** Scanning and push protection are on (free for public repos), but
  *non-provider patterns* (private keys, connection strings, custom bearer
  tokens) and *validity checks* require GitHub Secret Protection, which is sold
  for organization-owned repositories on Team/Enterprise. This repo is
  user-owned on the free plan: `PATCH /repos/{o}/{r}` accepts
  `secret_scanning_non_provider_patterns` / `secret_scanning_validity_checks`
  with HTTP 200 and silently leaves both `disabled`. Verified 2026-09-03 —
  don't re-attempt the API call, it looks like it worked. Generic secrets are
  caught by review, not by the platform.

---

## Telemetry Credentials — Public by Design

The anonymous active-install ping (`src/telemetry/usage-ping.ts`) uses GA4's
Measurement Protocol. Its two credentials — a measurement id and an
`api_secret` — are **inlined into the published bundle at build time**
(`tsup.config.ts`, `define` block) and are therefore readable as plaintext by
anyone who runs `npm install trace-mcp`. This is intended, not a leak.

* **A GA4 `api_secret` is write-only.** It can send events to the property; it
  cannot read reports, users, or any other data. Baking one into a distributed
  client is the documented way GA4 Measurement Protocol works for client-side
  apps.
* **They are stored as GitHub Actions secrets for convenience, not
  confidentiality.** The `npm` environment keeps them out of git history and
  makes rotation a one-place edit. It does not — and is not meant to — keep
  them out of users' hands.
* **Rotating them is not a mitigation.** The next release republishes the new
  value. Report an actual problem with the property (spam, quota abuse)
  instead; the fix for that is a server-side proxy, not a rotation.
* **The counts are unauthenticated.** Anyone holding the extracted credentials
  can post arbitrary `client_id`s, so active-install numbers are a
  lower-confidence signal that can be inflated by a third party. Treat them as
  directional, not as an auditable metric.

What the ping deliberately does **not** carry: no IP address. The
Measurement Protocol's `ip_override` is left unset, so Google derives nothing
about the network connection from the request. Location is reported at country
granularity only, and it is derived from the machine's own timezone setting
(`Europe/Berlin` → `DE`) via a static table compiled into the bundle
(`src/telemetry/tz-country.ts`) — no geo-IP service is contacted.

Machine attributes are reported as a class, not an identity: CPU
architecture, core count, RAM rounded to whole gigabytes, and the OS kernel
version. None of them narrows a population to a device, and they are not
combined into a hash or an id. The only per-install identifier is a random
UUID generated locally on first run. There is no account, email, hostname, username, MAC address, repository
name, or file path anywhere in the payload, and no device fingerprint. The
repository count is a number; the names are never sent.

This is a standing constraint, not the current state of an evolving payload:
nothing may be added to the ping that makes an install attributable to a
person, a company, or a machine. Handling IP addresses, device identifiers or
demographic attributes would make the project a controller of personal data
under GDPR and equivalent regimes, with the notice, consent, retention and
subject-access duties that follow. The ping stays outside that scope by
design.

Source maps (`dist/*.map`) are published alongside the bundle so that stack
traces from user installs are readable. They contain the same credentials as
the bundle, which — given the above — adds no exposure.

---

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

* **Email:** [vysotskiy@outlook.com](mailto:vysotskiy@outlook.com)
* **Do not** open a public issue for security vulnerabilities.
* We aim to acknowledge reports within 48 hours and provide a fix or mitigation plan within 7 days.

---

## Summary of Controls

| Control | Default | Configurable |
| --- | --- | --- |
| Path traversal validation | Always enabled | No |
| Symlink blocking | Always enabled | No |
| Directory exclusion | 11 patterns | Yes (`exclude`) |
| `.traceignore` exclusion | gitignore syntax | Yes (project-root file) |
| Sensitive file exclusion | 27 patterns | No |
| `.env` value redaction | Always enabled | No |
| `.gitignore` content gating | Always enabled | No |
| Binary file detection | Null-byte scan (8 KB) | No |
| File size limit | 1 MB | Yes (`security.max_file_size_bytes`) |
| File count limit | 10,000 files | Yes (`security.max_files`) |
| Artisan command whitelist | 3 read-only commands | No |
| Secret pattern detection | 7 regex patterns | Yes (`security.secret_patterns`) |
| SQLite WAL mode | Always enabled | No |
| UTF-8 safe decoding | Always enabled | No |
| Transitive CVE overrides | protobufjs, hono, vite pinned to patched | Yes (`overrides` in `package.json`) |
| Auto-update SHA-256 verification | Required, no checksum = no update | No |
| Auto-update Gatekeeper check | `spctl -a -t exec` on staged bundle | No |
| Auto-update opt-out | Disabled when set | Yes (`TRACE_MCP_NO_AUTO_UPDATE=1`) |
| npm provenance attestation | Sigstore/OIDC on every release | No |
| Apple signing secret scope | `apple-signing` environment, protected branches only | No |
| GA4 telemetry credentials | Public by design, ship in `dist/`, write-only | Yes (`TRACE_MCP_TELEMETRY=off`) |
