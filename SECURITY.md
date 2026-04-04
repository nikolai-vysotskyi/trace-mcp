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

1. **Config exclude patterns** — directories and files excluded by default: `vendor/**`, `node_modules/**`, `.git/**`, `storage/**`, `bootstrap/cache/**`, `.nuxt/**`, `.next/**`, `dist/**`, `build/**`.
2. **File watcher ignore** — `@parcel/watcher` is configured with the same ignore list, plus `.idea/`. Double filtering is applied (at subscription level and event processing level).
3. User-configurable `exclude` patterns in the config file (gitignore-style globs).

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
| Directory exclusion | 9 patterns | Yes (`exclude`) |
| Sensitive file exclusion | 26+ patterns | No |
| `.env` value redaction | Always enabled | No |
| `.gitignore` content gating | Always enabled | No |
| Binary file detection | Null-byte scan (8 KB) | No |
| File size limit | 1 MB | Yes (`security.max_file_size_bytes`) |
| File count limit | 10,000 files | Yes (`security.max_files`) |
| Artisan command whitelist | 3 read-only commands | No |
| Secret pattern detection | 7 regex patterns | Yes (`security.secret_patterns`) |
| SQLite WAL mode | Always enabled | No |
| UTF-8 safe decoding | Always enabled | No |
