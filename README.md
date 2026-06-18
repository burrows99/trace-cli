# trace-cli

A **unified execution tracer & analyzer**. Point it at a running program, give it breakpoint locations and a
trigger, and it prints a full **execution trace** — every hit in order, with the call stack, locals, watched
expressions, and timing — as **one JSON envelope** that's the same shape no matter which target produced it.

The product isn't "a debugger." It's **OpenTelemetry for software execution**: every collector (a debug
protocol, a span exporter, a shell) normalizes to one `Event`, and events are the asset. A debugger is just
one signal source. See [`docs/MIGRATION.md`](docs/MIGRATION.md) for the architecture and north star.

```
trace-cli dynamic   ← breakpoints + a trigger → a full trace   (Node·Chrome via CDP)
trace-cli graph     ← static call graph (the flow tree) for a function/route via LSP call hierarchy
trace-cli journey   ← scripted UI journey across tabs → one motion screencast (Chrome via CDP)
trace-cli serve     ← collector + realtime UI: show ALL traces live (Langfuse-style)
trace-cli doctor    ← which backing tools are installed
trace-cli schema    ← the output JSON Schema (the contract)
```

It is **not coupled to any project** — ports, triggers, and breakpoint files all come from
flags. Runs on plain Node (≥ 18). The transport is delegated to a maintained client —
**CDP via `chrome-remote-interface`** — so the project owns only target discovery and the event model, not the
wire protocol.

## Trace Node & the browser

One engine, one protocol driver — **CDP** for the JS family (Node `--inspect` and Chrome):

```bash
# Node (CDP): attach to a --inspect port, fire a curl, trace the request
trace-cli dynamic --node 9229 \
  --curl 'curl -s http://localhost:3000/v1/dashboard' \
  --bp src/dashboard/dashboard.service.ts:149 \
  --expr 'user.id'

# Chrome (CDP): attach to a running --remote-debugging-port, navigate (breakpoints bind before the first run), trace
trace-cli dynamic --chrome 9222 --url http://localhost:3000/route --bp src/pages/Thing.tsx:42

# …or omit the port — the CLI launches a throwaway headless Chrome itself, traces, records, and tears it down
trace-cli dynamic --chrome --url http://localhost:5173/route --bp src/pages/Thing.tsx:42
```

The engine is built around one `ProtocolDriver` interface, so additional debug protocols (DAP for Python, Go,
Java, C/C++/Rust) are a new driver behind the same envelope — see the [roadmap](#roadmap).

Flags (both targets): `--bp <file:line | file@substring>` (repeatable) · `--expr '<js>'` (repeatable, evaluated
at every hit) · `--json [path]` (envelope to a file, or bare `--json` for JSON on stdout). The trigger is
target-specific: Node takes `--curl`, Chrome takes `--url`. `--chrome <port>` attaches to a browser you
launched (a real, logged-in session); bare `--chrome` launches a throwaway headless Chrome for you.
Everything else (hit cap, stack depth, source
root, attach timeout) uses sane defaults — kept off the flag surface on purpose. Chrome **always records a
debug-replay video** — a motion screencast of the page with the live trace panel (stack/locals/watch) beside
each moment — uploaded to S3 if `S3_ENDPOINT` is set, with the link attached to the trace
(`data.recording.url`), else kept as a local path. `stdout` is the trace; `stderr` carries structured logs
(`TRACE_LOG_LEVEL=debug|info|warn|error|silent`, `TRACE_LOG_FORMAT=json|pretty`); exit `0` ok · `1` runtime ·
`2` usage. Inputs and the emitted envelope are both validated (class-validator) before anything runs or ships.

See installed tooling with `trace-cli doctor`.

## Show all traces live — `trace-cli serve` + Docker

`trace-cli serve` runs a **collector + realtime web UI** (Langfuse-style): a session list that updates live over
SSE, and a per-trace timeline with stack, locals, watched expressions, and response. Point any trace at it by
setting `TRACE_COLLECTOR_URL` — every run then POSTs its envelope to the collector. Sessions persist in
**Postgres**, so the collector needs a connection string — `DATABASE_URL` (or `POSTGRES_URL`, or `--db <url>`).
The schema is created on first use; no migrations to run.

```bash
# locally (point at any Postgres; the trace_sessions table is created automatically)
export DATABASE_URL=postgres://user:pass@localhost:5432/trace
trace-cli serve --port 4747                 # → http://localhost:4747
TRACE_COLLECTOR_URL=http://localhost:4747 trace-cli dynamic --node 9229 --bp app.js:42 --curl '…'

# as a Docker service: collector + UI + Postgres (session store) + a mock-aws (S3) for recordings
docker compose up --build               # → http://localhost:4747 (UI), :5432 (Postgres), :9000/:9001 (S3)
# then, from the host where your debug target is reachable:
export S3_ENDPOINT=http://localhost:9000
TRACE_COLLECTOR_URL=http://localhost:4747 trace-cli dynamic --chrome 9222 --url http://localhost:3000 --bp src/App.tsx:9
```

Each trace envelope is one `trace_sessions` row (full envelope as JSONB + a precomputed summary). Chrome
recordings upload to S3 (the `mock-aws` container locally; point `S3_ENDPOINT` at real AWS in prod — the code
talks the S3 API via the AWS SDK, no change), and the video link rides along in the trace + plays in the UI.
Set `TRACE_COLLECTOR_URL` to have every trace emit to the collector. Ingest is strict — the collector
validates each envelope and rejects a malformed one with `400` + the offending fields. The collector API:
`POST /v1/traces` (ingest), `GET /api/sessions`, `GET /api/sessions/:id`, `GET /api/stream` (SSE).

The web UI is a **Next.js app** (App Router, static export) that lives in [`ui/`](ui/) as a self-contained
sub-project. `npm run build` static-exports it (`output: 'export'` → `ui/out`) and copies the result into
`dist/collector/ui`, which the collector serves at `/` alongside the API above — so `trace-cli serve` stays a
single process with no extra port. To iterate on the UI with hot reload, run the collector for data and the
Next dev server for the UI:

```bash
trace-cli serve --port 4000        # collector + API (data source)
npm run dev:ui                 # Next.js dev → http://localhost:3000 (reads :4000 via ui/.env.development)
```

## Code graph — the flow tree (`trace-cli graph`)

Static call graph **without running anything**: point it at a function or route and it returns the outgoing-call
tree — the deterministic "what calls what" for that entry. It drives a **language server over the Language
Server Protocol** (`prepareCallHierarchy` + `callHierarchy/outgoingCalls`) — the exact engine an IDE's *Show
Call Hierarchy* uses — so resolution is type-accurate (it follows DI-injected services, interface→impl, and
cross-file imports), not a regex guess.

```bash
# the common case — just the entry; root + language server are auto-detected
trace-cli static graph --entry src/auth/auth.service.ts:42:9
trace-cli static graph --entry src/auth/auth.service.ts@exchangeToken     # …or by symbol
```

The only required input is the entry (`file:line`, `file:line:col`, or `file@symbol`). The project **root** is
found by walking up to the nearest `tsconfig.json`/`package.json`/`.git`, and the **LSP server** is chosen by
file extension — so a TS/JS graph needs no extra flags (`typescript-language-server` ships with the tool).
`--depth <n>` bounds it; `--server <cmd>` and `--root <dir>` override the auto-detection.

The payload is a normalized `{ nodes, edges }` graph (the schema's `Graph` shape) under `data.graph`; the human
render unrolls it into a flow tree, marking shared callees (`→ shared`), recursion (`↻ cycle`), and the
boundary to external/dependency code (`⊗ external`) — which is exactly where a *dynamic* trace takes over.

**Any language with a call-hierarchy LSP server**, not just TS — point `--server` at it:

| Language | `--server` | Notes |
| --- | --- | --- |
| TS / JS / React | *(bundled `typescript-language-server`)* | default; `.tsx`/`.jsx` included |
| Python | `pyright` / `basedpyright` | install the server |
| Go | `gopls` | install the server |
| Rust | `rust-analyzer` | install the server |
| C / C++ | `clangd` | needs `compile_commands.json` |
| Java | `jdtls` | install + a custom launch command |

Caveats, all about the server/project (not the tool): the server must be **installed** and advertise
`callHierarchyProvider` (the CLI checks and errors clearly if not); the project must be **resolvable** by that
server (e.g. clangd needs `compile_commands.json`); and it's a *call* graph — JSX `<Component/>` composition
isn't a call, and calls nested in callbacks attribute to the callback, not the enclosing function.

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

Print the full JSON Schema with `trace-cli schema` — it's at
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
trace-cli dynamic --node 9230 --curl 'curl -s "http://127.0.0.1:3100/checkout?cart=widget:2,gadget:1&coupon=SAVE10&region=US"' \
  --bp "test/servers/node-api/server.js@subtotal += it.lineTotal" --expr subtotal --expr 'it.sku'

# React (Chrome / CDP) — frontend through Vite source maps; bare --chrome → the CLI launches headless Chrome itself
cd test/servers/react-app && npm install && npm run dev &     # serves :5180
trace-cli dynamic --chrome --url http://localhost:5180 \
  --bp "test/servers/react-app/src/price.ts@sum = sum + parseInt" --expr sum
```

Both emit the same envelope shape; prefix either with `TRACE_COLLECTOR_URL=http://localhost:4747` to watch
them land live in the `trace-cli serve` UI.

## Roadmap

Built today: the **backend pillar** (Node · Chrome over CDP, attach *or* auto-launch) + the **static pillar**
(`trace-cli graph` — call graph / flow tree via LSP call hierarchy, any language with a call-hierarchy server) +
the **collector/UI** + Docker. Next, behind the same envelope: **DAP languages** (Python, Go, Java, C/C++) for
*dynamic* tracing via a second `ProtocolDriver`, more static analyzers (`complexity|symbols|deps`), `trace-cli
exec` (OTel spans), `trace-cli web` (Playwright), and `trace-cli correlate` (the cross-tier `traceparent`
handshake). See [`docs/MIGRATION.md`](docs/MIGRATION.md).

## License

MIT — see [LICENSE](LICENSE).
