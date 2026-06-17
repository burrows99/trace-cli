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
flags. Runs on plain Node (≥ 18); the DAP path uses Microsoft's official `@vscode/debugadapter-testsupport`
client (no hand-rolled protocol).

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
at every hit) · `--frames N` · `--max-hits N` · `--root <dir>` · `--format human|json` · `--json <path>`
(write the envelope) · `--emit <url>` (POST to a collector) · `--check` (verify a breakpoint binds, then
exit). Chrome adds `--shot <png>` and `--record <out.mp4>`. `stdout` is the trace, `stderr` is `[trace]`
logs; exit `0` ok · `1` runtime · `2` usage.

See installed tooling with `trace doctor`.

## Show all traces live — `trace serve` + Docker

`trace serve` runs a **collector + realtime web UI** (Langfuse-style): a session list that updates live over
SSE, and a per-trace timeline with stack, locals, watched expressions, and response. Point any trace at it
with `--emit`.

```bash
# locally
trace serve --port 4747                 # → http://localhost:4747
trace dynamic --node 9229 --bp app.js:42 --curl '…' --emit http://localhost:4747

# as a Docker service (persists sessions to ./.trace-data)
docker compose up --build               # → http://localhost:4747
# then, from the host where your debug target is reachable:
trace dynamic --python 5678 --bp app.py:42 --curl '…' --emit http://localhost:4747
```

`TRACE_COLLECTOR_URL` works as a default for `--emit`. The collector API: `POST /v1/traces` (ingest),
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
    "response": { "exitCode": 0, "body": "…" }
  },
  "diagnostics": []
}
```

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
```

## Roadmap

Built today: the language-agnostic **backend pillar** (Node·Chrome·Python) + the **collector/UI** + Docker.
Next, behind the same envelope: more DAP languages (Go/Java/C++), the **static** pillar
(`trace static search|complexity|symbols|deps`), `trace exec` (OTel spans), `trace web` (Playwright), and
`trace correlate` (the cross-tier `traceparent` handshake). See [`docs/MIGRATION.md`](docs/MIGRATION.md).

## License

MIT — see [LICENSE](LICENSE).
