---
layout: default
title: "Privacy — what trace-mcp sends, and how to turn it off"
description: "Everything trace-mcp sends off your machine: one anonymous daily ping, its complete field list, both opt-outs, and how to delete the local state it keeps."
updated: 2026-09-06
---

# Privacy

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "TechArticle",
  "headline": {{ page.title | jsonify }},
  "description": {{ page.description | jsonify }},
  "url": "https://trace-mcp.com/privacy.html",
  "datePublished": "2026-09-06",
  "dateModified": {{ page.updated | jsonify }},
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
    "@id": "https://trace-mcp.com/privacy.html"
  }
}
</script>

trace-mcp runs entirely on your machine. Indexing is local, the index lives in `~/.trace/`, and semantic search uses bundled ONNX embeddings with no API keys and no outbound calls. There is no account and no server of ours in the path — see [Architecture](architecture.md) for what runs where.

Exactly one thing leaves your machine on its own: an anonymous daily ping that counts active installs. This page is the complete description of it.

---

## The daily ping

At most one per day, per install. Sent from `src/telemetry/usage-ping.ts` at server startup, over [GA4's Measurement Protocol](https://developers.google.com/analytics/devguides/collection/protocol/ga4) — a single HTTP POST, not a custom backend or an SDK.

### Everything it sends

- A random install id — a UUID generated locally, stored in `~/.trace/telemetry-state.json`. This is the only per-install identifier.
- The trace-mcp version, and the version the previous ping came from.
- Whether this run is a first install, an upgrade, a downgrade, or another day on the same version.
- Node major version and OS platform (`darwin`, `linux`, `win32`).
- The country your machine's timezone belongs to — `DE`, not a city and not an IP.
- The name of the MCP client that connected (`claude-code`, `cursor`), and the model it mostly drove (`claude-opus-4-6`).
- How many repositories you have indexed — the number, never their names or paths.
- Your machine's class: CPU architecture, core count, RAM in whole gigabytes, OS kernel version.
- The tool preset the session ran with (`minimal`, `dev`, `full`, …) and how many tools it advertised — the count, never which ones.
- Two aggregate counters since the previous ping: how many tool calls you made and the estimated tokens they saved. These are the same totals `trace-mcp analytics savings` prints locally.
- Two counters for background-daemon reliability: how many times the daemon started, and how many of those starts followed a run that died without shutting down. Counts only — no exit codes, no timestamps, no reasons, and nothing about what was running.

### What it never sends

No IP address — `ip_override` is deliberately left unset, so Google derives nothing about your network from the request. No device fingerprint, no demographics, no account, email, hostname or username. No repository name, no file path, no query content, and no code. No per-tool or per-project breakdown.

It is also suppressed entirely when `CI` is set, so build jobs never count as installs.

### Its credentials are public by design

The GA4 measurement id and its write-only `api_secret` are compiled into the published bundle as plaintext, so anyone can read exactly where the ping goes and verify this page against the wire. The trade is deliberate and its consequence is stated in [SECURITY.md](https://github.com/nikolai-vysotskyi/trace-mcp/blob/master/SECURITY.md#telemetry-credentials--public-by-design): the counts are unauthenticated and therefore inflatable.

---

## Turning it off

Either one disables the ping completely:

```bash
# Environment variable — also accepts 0 and false.
export TRACE_MCP_TELEMETRY=off
```

```jsonc
// ~/.trace/.config.json
{
  "telemetry": { "usage_ping": false }
}
```

**`telemetry.usage_ping` is not `telemetry.enabled`.** The `enabled` key next to it switches on a *local* latency database in `~/.trace/telemetry.db` that never leaves your machine, and `telemetry.observability.*` exports spans to a collector *you* configure — see [MCP tracing](telemetry.md). Neither of those has anything to do with the ping. Every key is listed in the [config index](config-index.md).

The first time trace-mcp runs, it prints one line to stderr naming the ping and both opt-outs, then records that it has done so and never prints it again.

## Deleting local state

`~/.trace/` is the whole footprint — index, telemetry state file, savings totals, logs. Deleting it removes everything trace-mcp has stored about you, including the install id, which means a later ping counts as a new install rather than as you.

```bash
rm -rf ~/.trace          # or ~/.trace-mcp on an install that hasn't migrated
```

To remove a single project's index instead, use `trace-mcp remove <path>` — details in [Configuration](configuration.md).

## Your AI client is a separate question

trace-mcp returns graph results over MCP. What your client (Claude Code, Cursor, Codex, Windsurf) then forwards to a model, and under whose privacy policy, is governed by that client, not by us.

Outbound calls to a remote LLM provider — used by a few optional features — require explicit consent first: `trace-mcp consent grant <provider>`. Nothing calls a remote provider without it.
