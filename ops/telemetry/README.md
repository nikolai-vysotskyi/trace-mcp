# ops/telemetry — local OTLP collector for trace-mcp

A 3-minute Jaeger-in-a-box for validating the trace-mcp observability bridge
(`telemetry.observability`, sink=`otlp`). Spans are kept in memory only — this
is a developer-machine validator, not a production deployment.

## Boot

```bash
cd ops/telemetry
docker compose up -d

# Wait until the UI is up (~5s on a warm Docker daemon).
until curl -sf http://localhost:16686 >/dev/null; do sleep 1; done
open http://localhost:16686
```

If `docker compose` is not installed, see the top-level
[`docs/telemetry.md`](../../docs/telemetry.md) for an alternative recipe using
`jaeger` via `podman` or a remote collector.

## Point trace-mcp at it

Create `.trace-mcp.json` at the project root (gitignored — DO NOT commit):

```json
{
  "telemetry": {
    "observability": {
      "enabled": true,
      "sink": "otlp",
      "sampleRate": 1,
      "otlp": {
        "endpoint": "http://localhost:4318/v1/traces",
        "serviceName": "trace-mcp"
      }
    }
  }
}
```

Then start the daemon / run any tool that exercises the instrumented call
sites:

```bash
pnpm run build
node dist/cli.js eval run --dataset default   # 12x search spans + ai.embed
# OR
node dist/cli.js serve                        # any tool call lands a tool.<name>
```

## What you'll see

In the Jaeger UI, the service dropdown shows `trace-mcp`. Trace topology:

- `ai.embed`, `ai.embed_batch`, `ai.generate`, `ai.generate_stream` — every
  AI provider call, attributes: `ai.provider`, `ai.model`, `ai.input_size`,
  `ai.output_size`, `ai.max_tokens`, `duration_ms`.
- `tool.<name>` — every MCP tool invocation, attributes: `tool.name`,
  `duration_ms`, `tool.is_error`.

Both are root spans for now — async-context propagation (one parent
`tool.search` with a child `ai.embed`) is a P13 follow-up.

## Cleanup

```bash
docker compose down -v
```

Removes containers + the (in-memory) volumes. No host paths are mounted.

## Ports

| Port  | Protocol      | Used by                       |
| ----- | ------------- | ----------------------------- |
| 16686 | HTTP (UI)     | browser                       |
| 4318  | OTLP/HTTP     | `OtlpSink` POST `/v1/traces`  |
| 4317  | OTLP/gRPC     | not used by trace-mcp today   |

If any port collides with another container, edit `docker-compose.yml` and
update the corresponding `otlp.endpoint` in `.trace-mcp.json`.
