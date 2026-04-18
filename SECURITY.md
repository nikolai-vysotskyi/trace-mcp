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

* **Symlinks are always skipped** — `fs.lstatSync()` detects symlinks without following them.
* When a symlink is encountered during indexing, it is logged as a warning and excluded.
* There is no option to follow symlinks — this is a hard security boundary.

---

## Default Ignore Policy

Files are filtered through multiple layers:

1. **Config exclude patterns** — directories excluded by default: `node_modules`, `.git`, `dist`, `build`, `.next`, `__pycache__`, `.venv`, `vendor`, `.trace-mcp`, `coverage`, `.turbo`.
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

* The SQLite database defaults to `.trace-mcp/index.db` (project-relative, hidden directory).
* Configurable via `db.path` in config or `TRACE_MCP_DB_PATH` environment variable.
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

* `protobufjs >= 7.5.5` — closes the prototype-pollution RCE (GHSA-xq3m-2v4x-88gg) reachable through the optional `@huggingface/transformers` → `onnxruntime-web` chain.
* `hono >= 4.12.14` and `@hono/node-server >= 1.19.14` — closes cookie, `ipRestriction`, `serveStatic`, and `toSSG` path-traversal advisories reachable through `@modelcontextprotocol/sdk`.
* `vite >= 7.3.2` — closes the dev-server `fs.deny` bypass, `.map` path traversal, and WS file-read advisories reachable through `vitest`.

`npm audit` is expected to report **0 vulnerabilities** on a clean install. Re-check after any lockfile change.

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
