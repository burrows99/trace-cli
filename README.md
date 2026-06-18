# trace-cli

A **unified execution tracer & analyzer**. Point it at a running program, give it breakpoint locations and a
trigger, and it prints a full **execution trace** — every hit in order, with the call stack, locals, watched
expressions, and timing — as **one JSON envelope** that's the same shape no matter which target produced it.

The product isn't "a debugger." It's **OpenTelemetry for software execution**: every collector (a debug
protocol, a span exporter, a shell) normalizes to one `Event`, and events are the asset. A debugger is just
one signal source. See [`docs/MIGRATION.md`](docs/MIGRATION.md) for the architecture and north star.

```
trace dynamic   ← breakpoints + a trigger → a full trace   (Node·Chrome via CDP)
trace serve     ← collector + realtime UI: show ALL traces live (Langfuse-style)
trace doctor    ← which backing tools are installed
trace schema    ← the output JSON Schema (the contract)
```

It is **not coupled to any project** — ports, triggers, breakpoint files, and the source root all come from
flags. Runs on plain Node (≥ 18). The transport is delegated to a maintained client —
**CDP via `chrome-remote-interface`** — so the project owns only target discovery and the event model, not the
wire protocol.

## Trace Node & the browser

One engine, one protocol driver — **CDP** for the JS family (Node `--inspect` and Chrome):

```bash
# Node (CDP): attach to a --inspect port, fire a curl, trace the request
trace dynamic --node 9229 \
  --curl 'curl -s http://localhost:3000/v1/dashboard' \
  --bp src/dashboard/dashboard.service.ts:149 \
  --expr 'user.id'

# Chrome (CDP): attach to --remote-debugging-port, navigate/reload, trace the render
trace dynamic --chrome 9222 --url http://localhost:3000/route --bp src/pages/Thing.tsx:42
```

The engine is built around one `ProtocolDriver` interface, so additional debug protocols (DAP for Python, Go,
Java, C/C++/Rust) are a new driver behind the same envelope — see the [roadmap](#roadmap).

Shared flags: `--bp <file:line | file@substring>` (repeatable) · `--expr '<js>'` (repeatable, evaluated at
every hit) · `--frames N` · `--max-hits N` · `--root <dir>` · `--json [path]` (envelope to a file, or bare
`--json` for JSON on stdout) · `--emit <url>` (POST to a collector) · `--attach-timeout-ms <n>` (fail fast if
the debugger connect stalls). Chrome adds `--shot <png>`; it also **records a debug-replay video by default**
(`--no-record` to skip) — uploaded to S3 if `S3_ENDPOINT` is set, with the link attached to the trace
(`data.recording.url`), else kept as a local path. `stdout` is the trace, `stderr` is `[trace]` logs; exit
`0` ok · `1` runtime · `2` usage.

See installed tooling with `trace doctor`.

## Show all traces live — `trace serve` + Docker

`trace serve` runs a **collector + realtime web UI** (Langfuse-style): a session list that updates live over
SSE, and a per-trace timeline with stack, locals, watched expressions, and response. Point any trace at it
with `--emit`. Sessions persist in **Postgres**, so the collector needs a connection string — `DATABASE_URL`
(or `POSTGRES_URL`, or `--db <url>`). The schema is created on first use; no migrations to run.

```bash
# locally (point at any Postgres; the trace_sessions table is created automatically)
export DATABASE_URL=postgres://user:pass@localhost:5432/trace
trace serve --port 4747                 # → http://localhost:4747
trace dynamic --node 9229 --bp app.js:42 --curl '…' --emit http://localhost:4747

# as a Docker service: collector + UI + Postgres (session store) + a mock-aws (S3) for recordings
docker compose up --build               # → http://localhost:4747 (UI), :5432 (Postgres), :9000/:9001 (S3)
# then, from the host where your debug target is reachable:
export S3_ENDPOINT=http://localhost:9000
trace dynamic --chrome 9222 --url http://localhost:3000 --bp src/App.tsx:9 --emit http://localhost:4747
```

Each trace envelope is one `trace_sessions` row (full envelope as JSONB + a precomputed summary). Chrome
recordings upload to S3 (the `mock-aws` container locally; point `S3_ENDPOINT` at real AWS in prod — the code
talks the S3 API via the AWS SDK, no change), and the video link rides along in the trace + plays in the UI.
`TRACE_COLLECTOR_URL` works as a default for `--emit`. The collector API: `POST /v1/traces` (ingest),
`GET /api/sessions`, `GET /api/sessions/:id`, `GET /api/stream` (SSE).

The web UI is a **Next.js app** (App Router, static export) that lives in [`ui/`](ui/) as a self-contained
sub-project. `npm run build` static-exports it (`output: 'export'` → `ui/out`) and copies the result into
`dist/collector/ui`, which the collector serves at `/` alongside the API above — so `trace serve` stays a
single process with no extra port. To iterate on the UI with hot reload, run the collector for data and the
Next dev server for the UI:

```bash
trace serve --port 4000        # collector + API (data source)
npm run dev:ui                 # Next.js dev → http://localhost:3000 (reads :4000 via ui/.env.development)
```

## The contract: one envelope

Every subcommand emits the same envelope; only `data` varies, built from shared shapes
(`Loc`/`Symbol`/`Metric`/`Graph`/`Event`). `Event` is the unifier — a CDP breakpoint hit, a span, and a UI
action all become `Event`s on one timeline, each tagged with its `source` (`cdp`/`terminal`/`otel`) and a
`sessionId` for cross-source correlation.

```jsonc
{
  "tool": "trace", "version": "0.3.0", "command": "dynamic.node", "ok": true,
  "meta": { "at": "…", "sessionId": "…", "durationMs": 142 },
  "target": { "kind": "node", "source": "cdp", "trigger": "curl …" },
  "data": {
    "breakpoints": [ { "file": "server.js", "line": 42, "bound": true } ],
    "events": [ {
      "seq": 1, "kind": "breakpoint", "source": "cdp", "sessionId": "…",
      "loc": { "file": "server.js", "line": 42 }, "label": "priceFor", "t": 12,
      "attrs": { "stack": [ "…" ], "locals": { }, "exprs": { } }
    } ],
    "lineage": [ { "name": "total", "kind": "expr", "changes": 2,
      "series": [ { "seq": 1, "value": 0 }, { "seq": 2, "value": 9.99, "changed": true } ] } ],
    "response": { "exitCode": 0, "body": "…" }
  },
  "diagnostics": []
}
```

**Mutation lineage** (`data.lineage`) is a *derived* view computed in the normalization tier: for every
watched value, the ordered series of how it changed as flow continued (`total: 0 → 9.99 → 14.49`) — so an
agent sees value-over-time, not just per-hit snapshots. It surfaces in the human render, the JSON envelope,
and the live UI. (Empty when nothing mutates, e.g. a single-hit trace.)

Print the full JSON Schema with `trace schema` — it's at
[`src/shared/trace.schema.json`](src/shared/trace.schema.json).

## As a library (class-first, TypeScript)

The codebase is TypeScript with a class-first / domain-driven layout (`domain/` entities, `transport/`
drivers, `engine/`, `analysis/`, `storage/`, `collector/`, `cli/`). Build with `npm run build`, then:

```ts
import { DynamicCommand, Trace } from "trace-cli";

const { trace } = await new DynamicCommand().run({
  target: "node",
  port: 9229,
  curl: 'curl -s http://127.0.0.1:3100/price?qty=3',
  breakpoints: ["test/servers/node-api/server.js:42"],
  root: "/path/to/project",
});

const envelope = trace.toJSON();          // domain Trace → wire JSON
const errors = trace.validate();          // class-validator (class-first contract)
const restored = Trace.fromPlain(envelope); // rehydrate a stored envelope into entities
```

Lower-level building blocks are exported too: `Tracer`, `CdpDriver` (`ProtocolDriver`), `LineageAnalyzer`,
`S3ArtifactStore` (`ArtifactStore`), `Collector`/`PostgresSessionStore` (`SessionStore`).

## As a Claude Code plugin

This repo is also a [Claude Code plugin](https://code.claude.com/docs/en/plugins): installing it bundles a
usage skill and the `bin/` binary.

```bash
claude plugin marketplace add /path/to/trace-cli
claude plugin install trace@trace-oss
```

The skill invokes the binary by its install path, `${CLAUDE_PLUGIN_ROOT}/bin/trace`.

## Try it

Sample servers live under `test/servers/` — a Node order-API and a React checkout UI, each with a planted bug
so the tracer has something to reveal:

```bash
# Node (CDP)
PORT=3100 node --inspect=9230 test/servers/node-api/server.js &
trace dynamic --node 9230 --curl 'curl -s "http://127.0.0.1:3100/checkout?cart=widget:2,gadget:1&coupon=SAVE10&region=US"' \
  --bp "test/servers/node-api/server.js@subtotal += it.lineTotal" --expr subtotal --expr 'it.sku'

# React (Chrome / CDP) — traced on the frontend through Vite source maps
cd test/servers/react-app && npm install && npm run dev &     # serves :5180
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --remote-debugging-port=9334 --user-data-dir=/tmp/chrome about:blank &
trace dynamic --chrome 9334 --url http://localhost:5180 --root test/servers/react-app \
  --bp "src/price.ts@sum = sum + parseInt" --expr sum
```

Both emit the same envelope shape; add `--emit http://localhost:4747` to either of them to watch them land
live in the `trace serve` UI.

## Roadmap

Built today: the **backend pillar** (Node · Chrome over CDP) + the **collector/UI** + Docker. Next, behind the
same envelope: **DAP languages** (Python, Go, Java, C/C++) via a second `ProtocolDriver`, the **static** pillar
(`trace static search|complexity|symbols|deps`), `trace exec` (OTel spans), `trace web` (Playwright), and
`trace correlate` (the cross-tier `traceparent` handshake). See [`docs/MIGRATION.md`](docs/MIGRATION.md).

## License

MIT — see [LICENSE](LICENSE).
