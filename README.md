# trace-cli

A **unified, language-agnostic execution tracer & analyzer**. Point it at a running program, give it
breakpoint locations and a trigger, and it prints a full **execution trace** — every hit in order, with the
call stack, locals, watched expressions, and timing — as **one JSON envelope** that's the same shape no
matter which language or protocol produced it.

The product isn't "a debugger." It's **OpenTelemetry for software execution**: every collector (a debug
protocol, a span exporter, a shell) normalizes to one `Event`, and events are the asset. A debugger is just
one signal source. See [`docs/MIGRATION.md`](docs/MIGRATION.md) for the architecture and north star.

```
trace dynamic   ← breakpoints + a trigger → a full trace   (Node·Chrome via CDP, Python via DAP)
trace serve     ← collector + realtime UI: show ALL traces live (Langfuse-style)
trace doctor    ← which backing tools are installed
trace schema    ← the output JSON Schema (the contract)
```

It is **not coupled to any project** — ports, triggers, breakpoint files, and the source root all come from
flags. Runs on plain Node (≥ 18). Both transports are delegated to maintained clients —
**CDP via `chrome-remote-interface`**, **DAP via `@vscode/debugadapter-testsupport`** — so the project owns
only target discovery and the event model, not the wire protocol.

## Trace any backend, any language

One engine, two protocol drivers — **CDP** for the JS family, **DAP** for everything else:

```bash
# Node (CDP): attach to a --inspect port, fire a curl, trace the request
trace dynamic --node 9229 \
  --curl 'curl -s http://localhost:3000/v1/dashboard' \
  --bp src/dashboard/dashboard.service.ts:149 \
  --expr 'user.id'

# Python (DAP/debugpy): the server calls debugpy.listen((host, port)); attach + fire a curl
trace dynamic --python 5678 \
  --curl 'curl -s http://127.0.0.1:3001/price?qty=3' \
  --bp app/service.py:42

# Chrome (CDP): attach to --remote-debugging-port, navigate/reload, trace the render
trace dynamic --chrome 9222 --url http://localhost:3000/route --bp src/pages/Thing.tsx:42
```

The target just needs to speak DAP (Go via `dlv dap`, Java via `java-debug`, C/C++/Rust via `lldb-dap` all
work through the same driver as adapters are added):

```python
import debugpy
debugpy.listen(("127.0.0.1", 5678))   # then serve as normal — trace-cli attaches on demand
```

Shared flags: `--bp <file:line | file@substring>` (repeatable) · `--expr '<js/py>'` (repeatable, evaluated
at every hit) · `--frames N` · `--max-hits N` · `--root <dir>` · `--json [path]` (envelope to a file, or
bare `--json` for JSON on stdout) · `--emit <url>` (POST to a collector) · `--check` (verify a bp binds, then
exit). Chrome adds `--shot <png>`; it also **records a debug-replay video by default** (`--no-record` to
skip) — uploaded to S3 if `S3_ENDPOINT` is set, with the link attached to the trace (`data.recording.url`),
else kept as a local path. `stdout` is the trace, `stderr` is `[trace]` logs; exit `0` ok · `1` runtime · `2` usage.

See installed tooling with `trace doctor`.

## Show all traces live — `trace serve` + Docker

`trace serve` runs a **collector + realtime web UI** (Langfuse-style): a session list that updates live over
SSE, and a per-trace timeline with stack, locals, watched expressions, and response. Point any trace at it
with `--emit`.

```bash
# locally
trace serve --port 4747                 # → http://localhost:4747
trace dynamic --node 9229 --bp app.js:42 --curl '…' --emit http://localhost:4747

# as a Docker service: collector + UI + a mock-aws (S3) for recordings
docker compose up --build               # → http://localhost:4747 (UI), :9000 (S3), :9001 (S3 console)
# then, from the host where your debug target is reachable:
export S3_ENDPOINT=http://localhost:9000
trace dynamic --chrome 9222 --url http://localhost:3000 --bp src/App.tsx:9 --emit http://localhost:4747
```

Chrome recordings upload to S3 (the `mock-aws` container locally; point `S3_ENDPOINT` at real AWS in prod —
the code talks the S3 API via the AWS SDK, no change), and the video link rides along in the trace + plays
in the UI. `TRACE_COLLECTOR_URL` works as a default for `--emit`. The collector API: `POST /v1/traces` (ingest),
`GET /api/sessions`, `GET /api/sessions/:id`, `GET /api/stream` (SSE).

## The contract: one envelope

Every subcommand emits the same envelope; only `data` varies, built from shared shapes
(`Loc`/`Symbol`/`Metric`/`Graph`/`Event`). `Event` is the unifier — a CDP breakpoint hit, a DAP stop, a
span, and a UI action all become `Event`s on one timeline, each tagged with its `source`
(`cdp`/`dap`/`terminal`/`otel`) and a `sessionId` for cross-source, cross-language correlation.

```jsonc
{
  "tool": "trace", "version": "0.3.0", "command": "dynamic.python", "ok": true,
  "meta": { "at": "…", "sessionId": "…", "durationMs": 142 },
  "target": { "kind": "python", "source": "dap", "trigger": "curl …" },
  "data": {
    "breakpoints": [ { "file": "app.py", "line": 42, "bound": true } ],
    "events": [ {
      "seq": 1, "kind": "breakpoint", "source": "dap", "sessionId": "…",
      "loc": { "file": "app.py", "line": 42 }, "label": "price_for", "t": 12,
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
[`src/schema/trace.schema.json`](src/schema/trace.schema.json).

## As a library

```js
import { traceNode, tracePython, dynamicEnvelope } from "trace-cli";

const result = await tracePython({
  port: 5678,
  curl: 'curl -s http://127.0.0.1:3001/price?qty=3',
  breakpoints: ["app/service.py:42"],
  root: "/path/to/project",
});
const envelope = dynamicEnvelope(result);   // → the unified envelope
```

## As a Claude Code plugin

This repo is also a [Claude Code plugin](https://code.claude.com/docs/en/plugins): installing it bundles a
usage skill and the `bin/` binary.

```bash
claude plugin marketplace add /path/to/trace-cli
claude plugin install trace@trace-oss
```

The skill invokes the binary by its install path, `${CLAUDE_PLUGIN_ROOT}/bin/trace`.

## Try it

Two zero-dependency sample servers with identical business logic live under `test/servers/` — the same
trace works across both:

```bash
# Node (CDP)
PORT=3100 node --inspect=9230 test/servers/node-api/server.js &
trace dynamic --node 9230 --curl 'curl -s "http://127.0.0.1:3100/price?qty=3&code=SAVE10"' \
  --bp "test/servers/node-api/server.js@total = subtotal" --expr rate

# Python (DAP)
PORT=3101 DEBUG_PORT=5679 python3 test/servers/python-api/server.py &
trace dynamic --python 5679 --curl 'curl -s "http://127.0.0.1:3101/price?qty=3&code=SAVE10"' \
  --bp "test/servers/python-api/server.py@total = subtotal" --expr rate

# React (Chrome / CDP) — same logic, traced on the frontend through Vite source maps
cd test/servers/react-app && npm install && npm run dev &     # serves :5180
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --remote-debugging-port=9334 --user-data-dir=/tmp/chrome about:blank &
trace dynamic --chrome 9334 --url http://localhost:5180 --root test/servers/react-app \
  --bp "src/price.ts@total = subtotal" --expr qty --expr code
```

All three emit the same envelope shape; add `--emit http://localhost:4747` to any of them to watch them
land live in the `trace serve` UI.

## Roadmap

Built today: the language-agnostic **backend pillar** (Node·Chrome·Python) + the **collector/UI** + Docker.
Next, behind the same envelope: more DAP languages (Go/Java/C++), the **static** pillar
(`trace static search|complexity|symbols|deps`), `trace exec` (OTel spans), `trace web` (Playwright), and
`trace correlate` (the cross-tier `traceparent` handshake). See [`docs/MIGRATION.md`](docs/MIGRATION.md).

## License

MIT — see [LICENSE](LICENSE).
