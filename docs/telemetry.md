---
title: "Telemetry & Observability — OpenTelemetry spans for every MCP tool call"
description: "trace-mcp's pluggable observability bridge emits OpenTelemetry-compatible spans for every AI provider call and every MCP tool call."
updated: 2026-09-02
---

# Telemetry & Observability

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "TechArticle",
  "headline": {{ page.title | jsonify }},
  "description": {{ page.description | jsonify }},
  "url": "https://trace-mcp.com/telemetry.html",
  "datePublished": "2026-05-13",
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
    "@id": "https://trace-mcp.com/telemetry.html"
  }
}
</script>
trace-mcp ships a pluggable observability bridge (P13) that emits
OpenTelemetry-compatible spans for every AI provider call and every MCP tool
invocation. The default sink is `noop` — opt-in only, and switched on with the
`telemetry.*` keys described in [configuration](configuration.md). Turning it on
also unlocks the persistent `window` values of `analyze_perf`, which is
otherwise limited to the current session ([analytics](analytics.md)).

> **This page is about spans you export to your own collector.** It is not the
> anonymous daily install ping, which is a separate subsystem reporting to the
> maintainer. That one's published field list — everything it sends and how to
> turn it off — lives in the README under
> [Usage telemetry](https://github.com/nikolai-vysotskyi/trace-mcp#usage-telemetry),
> with the source in `src/telemetry/usage-ping.ts`. Nothing on this page
> phones home.

## Quickstart (3 commands)

```bash
# 1. Stand up a local OTLP collector (Jaeger all-in-one).
cd ops/telemetry && docker compose up -d && cd -

# 2. Enable the bridge for this project (.trace.json is gitignored).
cat > .trace.json <<'JSON'
{
  "telemetry": {
    "observability": {
      "enabled": true,
      "sink": "otlp",
      "otlp": { "endpoint": "http://localhost:4318/v1/traces" }
    }
  }
}
JSON

# 3. Run anything — spans land in Jaeger UI at http://localhost:16686.
pnpm run build && node dist/cli.js eval run --dataset default
```

## Where spans appear

Open <http://localhost:16686>, pick `trace-mcp` from the **Service** dropdown,
click **Find Traces**.

## Span topology

| Span name              | Origin                                | Key attributes                                                                                |
| ---------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------- |
| `tool.<name>`          | `src/server/tool-gate.ts`             | `tool.name`, `duration_ms`, `tool.is_error`                                                   |
| `ai.embed`             | `TrackedEmbeddingService.embed`       | `ai.provider`, `ai.model`, `ai.url`, `ai.input_size`, `ai.output_size`, `duration_ms`         |
| `ai.embed_batch`       | `TrackedEmbeddingService.embedBatch`  | as above + batch counts                                                                       |
| `ai.generate`          | `TrackedInferenceService.generate`    | `ai.provider`, `ai.model`, `ai.max_tokens`, `ai.temperature`, `ai.input_size`, `duration_ms`  |
| `ai.generate_stream`   | `TrackedInferenceService.generateStream` | as above                                                                                   |

Errors thrown by the wrapped call surface as a span `exception` event
(`exception.type`, `exception.message`, `exception.stacktrace`) with span
status `ERROR`. The error is rethrown so caller control flow is unchanged.

## Switching sinks

In `.trace.json` (or `~/.trace/.config.json` for a global default):

| Goal                         | Config                                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------------------- |
| Disabled (default)           | `telemetry.observability.enabled: false` or omit the block                                          |
| Local Jaeger / collector     | `sink: "otlp"`, `otlp.endpoint: "http://localhost:4318/v1/traces"`                                  |
| Hosted OTLP (e.g. Honeycomb) | `sink: "otlp"`, `otlp.endpoint: "https://api.honeycomb.io/v1/traces"`, `otlp.headers: { "x-honeycomb-team": "…" }` |
| Langfuse cloud               | `sink: "langfuse"`, `langfuse.publicKey: "pk-…"`, `langfuse.secretKey: "sk-…"`                      |
| Fan-out to both              | `sink: "multi"` + both `otlp` and `langfuse` blocks                                                 |
| Probabilistic sampling       | `sampleRate: 0.1` (10% of spans kept)                                                               |

All sinks lazy-load — paying for `noop` is free, paying for `otlp` only loads
when `sink === "otlp"`.

## Adding a custom span from your own code

The public API lives in `src/telemetry/index.ts`:

```ts
import {
  getGlobalTelemetrySink,
  instrumentAsync,
} from './telemetry/index.js';

// Time an async function and auto-record exceptions.
await instrumentAsync(
  getGlobalTelemetrySink(),
  'my.operation',
  { 'my.attr': 42 },
  async (span) => {
    // ... your work ...
    span.setAttribute('result.count', items.length);
    return items;
  },
);

// Manual span lifecycle.
const span = getGlobalTelemetrySink().startSpan('my.op', { foo: 'bar' });
try {
  // ...
  span.setStatus('ok');
} catch (err) {
  span.recordError(err);
  throw err;
} finally {
  span.end();
}
```

`instrumentAiCall` and `instrumentToolCall` convenience wrappers exist for
the two standardised attribute schemas — prefer them when emitting AI or
tool-flavoured spans so dashboards stay consistent.

## Cleanup

```bash
cd ops/telemetry && docker compose down -v
rm .trace.json   # if you don't want telemetry enabled going forward
```

## Performance

- `noop` sink: a class allocation per span + 4 no-op method calls. Measured
  overhead is below the per-call jitter floor (~sub-microsecond).
- `otlp` sink: buffers spans in memory; flushes when 50 spans accumulate or
  every 5 s. Each flush is a single POST to `/v1/traces`. The export is
  fire-and-forget — `onError` logs at `warn` but never blocks the caller.
- `sampleRate < 1`: a `SamplingSink` wraps the real sink and rolls a
  `Math.random()` per `startSpan` / `emit`. Kept spans cost the full export
  path; dropped spans are noop.

## Troubleshooting

- **No spans in Jaeger.** Confirm `telemetry.observability.enabled` resolves
  to `true` (`node dist/cli.js config show`). Confirm the endpoint matches
  the Jaeger OTLP HTTP port (`4318` by default). Watch the trace-mcp log for
  `telemetry.otlp_export_failed` — most often a 404 on the path or a
  hostname typo.
- **Spans appear once then never refresh.** Jaeger memory store evicts after
  ~10k traces. Restart the container or switch to `badger` storage.
- **Container can't reach trace-mcp.** This direction never happens — the
  SDK is the client; Jaeger is the server. Always `http://localhost:4318`
  from the trace-mcp side.
