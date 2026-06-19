# trace-cli

![license MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![node >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)

Execution tracer & analyzer. Point it at a running program, give it breakpoints + a trigger → **one JSON envelope**: every hit in order (call stack, locals, watched expressions, timing), identical shape across Node and Chrome. Static analysis (call graph, deps, complexity, symbols) emits the same envelope without running anything.

**Breakpoints never pause.** They're armed as non-pausing *logpoints* — each hit ships its stack, every in-scope local (read from source, no naming needed), and any `--expression`, then the VM keeps running at full speed. Built for an agent that reads the trace and re-aims breakpoints, not a human stepping by hand.

```
trace-cli run      breakpoints + a trigger → a full trace   (Node curl · Chrome journey + video, via CDP)
trace-cli graph | deps | complexity | symbols   code structure without running it
trace-cli serve    collector + realtime dashboard: every trace, live
trace-cli doctor | schema   which backing tools are installed · the output JSON Schema
```

A Chrome run also records a **debug-replay video** — the live screen beside the breakpoint panel (stack/locals/watch), paced to each hit:

![Debug replay — Chrome journey + live trace panel](docs/assets/checkout-replay.gif)

*A checkout total drops the cents; the panel steps `sum: 0 → 19 → 43` as the bug compounds. ▶ [full-res mp4](docs/assets/checkout-replay.mp4).*

## Install

- **CLI / library (npm):** `npm i -g trace-cli` for the global `trace-cli`, or `npm i trace-cli` to import the classes. Node ≥ 18.
- **Claude Code plugin** (bundles the `trace` skill + the `bin/` binary):
  ```bash
  claude plugin marketplace add /path/to/trace-cli
  claude plugin install trace@trace-oss
  ```
- `trace-cli doctor` reports which backing tools (chrome, ffmpeg, language servers, …) are present.

Native-first: `run`, `graph`, `deps`, `complexity`, `symbols`, `doctor`, `schema` all run directly on the host — no Docker. Docker is only for the optional collector (below).

## Usage

One engine, one protocol driver — **CDP** for the JS family (Node `--inspect` and Chrome).

```bash
# Node: attach to a --inspect port, fire a curl, trace the request
trace-cli run --node 9229 \
  --curl 'curl -s http://localhost:3000/v1/dashboard' \
  --breakpoint src/dashboard/dashboard.service.ts:149 \
  --expression 'user.id'

# Chrome: drive a scripted UI journey on a --remote-debugging-port, recording a screen + trace-panel video
trace-cli run --chrome 9222 --breakpoint src/pages/Login.tsx:42 \
  --url http://localhost:3000/login --step 'type:#email=me@example.com' --step 'click:text=Sign in'

# …or omit the port — the CLI launches a throwaway headless Chrome, traces, records, and tears it down
trace-cli run --chrome --url http://localhost:5173/route --breakpoint src/pages/Route.tsx:42
```

- **Where to observe:** `--breakpoint <file:line | file@substring>`, repeatable. In-scope locals are captured automatically; `--expression '<js>'` adds computed values per hit.
- **What drives it:** Node → `--curl`. Chrome → `--url` (one navigation) and/or `--step` — an ordered journey (`goto`/`click`/`type`/`waitfor`/`wait`/`newtab`/`eval`; `text=…` or CSS selectors). Chrome needs ≥1 `--breakpoint`.
- **Output:** `stdout` = the trace render; `--json [path]` for the envelope (`--concise` trims it for agents, `--detailed` for everything); `stderr` = structured logs (`-v`/`-q`). Exit `0` ok · `1` runtime · `2` usage.
- **Chrome always records** a replay → uploaded to S3 if `S3_ENDPOINT` is set (`data.recording.url`), else a local path; `--output <mp4>` overrides. `console.*` and uncaught exceptions land in `data.console`.

<details>
<summary>Library (TypeScript)</summary>

```ts
import { DynamicCommand, Trace } from "trace-cli"; // DynamicCommand powers `trace run`

const { trace } = await new DynamicCommand().run({
  target: "node", port: 9229,
  curl: 'curl -s http://127.0.0.1:3100/price?qty=3',
  breakpoints: ["test/servers/node-api/server.js:42"],
});
const envelope = trace.toJSON();             // domain → wire JSON
const restored = Trace.fromPlain(envelope);  // rehydrate a stored envelope
```

Also exported: `Tracer`, `CdpDriver` (`ProtocolDriver`), `LineageAnalyzer`, `Recorder`, `S3ArtifactStore`, `Collector`/`PostgresSessionStore`.
</details>

## Realtime dashboard

`trace-cli serve` is a **collector + live web dashboard** (standalone Next.js: session list over SSE + a per-trace timeline of stack, locals, watched expressions, mutation lineage, and the replay video).

![Realtime dashboard — a Chrome session with its replay video and mutation lineage](docs/assets/dashboard.png)

```bash
export DATABASE_URL=postgres://user:pass@localhost:5432/trace
trace-cli serve --port 4000                  # → http://localhost:4000  (table auto-created, no migrations)
```

Any trace **auto-streams to a collector running locally** — no flag needed. Override the target with `--emit <url>` or `TRACE_COLLECTOR_URL`. Each envelope becomes one `trace_sessions` row (JSONB + summary); Chrome replays upload to S3 and play inline. API: `POST /v1/traces` · `GET /api/sessions[/:id]` · `GET /api/stream` (SSE).

Docker Compose bundles the dashboard, Postgres, and a mock S3 for one-command local setup:

```bash
docker compose up --build                # dashboard :14747 · Postgres :65432 · S3 :19000 (console :19001)
# then run the CLI natively from where your target is reachable; it auto-detects the collector
export S3_ENDPOINT=http://localhost:19000
trace-cli run --chrome 9222 --url http://localhost:3000 --breakpoint src/App.tsx:9
```

## Static analysis

Code structure **without running anything** — same envelope, no live target.

```bash
trace-cli graph --entry src/auth/auth.service.ts:42:9   # call graph (also file@symbol); root + LSP server auto-detected
trace-cli deps --entry src/index.ts                     # module-import graph + circular groups   (madge)
trace-cli complexity src                                # per-function cyclomatic complexity        (lizard)
trace-cli symbols src/app.ts                            # a file's definition outline               (tree-sitter)
```

`graph` uses a real **language server over LSP** (`prepareCallHierarchy` + `callHierarchy/outgoingCalls`) — the IDE *Show Call Hierarchy* engine, so it's type-accurate across DI, interfaces, and imports, not a regex guess. TS/JS is bundled; point `--server` at any call-hierarchy LSP for other languages (`pyright`, `gopls`, `rust-analyzer`, `clangd`, `jdtls`).

## The trace envelope

Every subcommand emits the same envelope; only `data` varies. `Event` is the unifier — a CDP hit, a span, and a UI action all become `Event`s on one timeline (`source` + `sessionId` for cross-source correlation).

```jsonc
{
  "tool": "trace", "command": "run.node", "ok": true,
  "meta": { "sessionId": "…", "durationMs": 142 },
  "target": { "kind": "node", "source": "cdp", "trigger": "curl …" },
  "data": {
    "breakpoints": [ { "file": "server.js", "line": 42, "bound": true } ],
    "events": [ { "sequence": 1, "kind": "breakpoint", "location": { "file": "server.js", "line": 42 },
      "label": "priceFor", "time": 12, "attributes": { "stack": ["…"], "locals": {}, "exprs": {} } } ],
    "lineage": [ { "name": "total", "kind": "expr", "changes": 2,
      "series": [ { "sequence": 1, "value": 0 }, { "sequence": 2, "value": 9.99, "changed": true } ] } ],
    "response": { "exitCode": 0, "body": "…" }
  },
  "diagnostics": []
}
```

**Mutation lineage** (`data.lineage`) is *derived*: per watched value, how it changed as flow continued (`total: 0 → 9.99 → 14.49`) — value-over-time across hits, not per-hit snapshots. Full schema: `trace-cli schema`.

## Try it

Sample servers under `test/servers/` — a Node order-API and a React checkout, each with a planted bug:

```bash
# Node
PORT=3100 node --inspect=9230 test/servers/node-api/server.js &
trace-cli run --node 9230 --curl 'curl -s "http://127.0.0.1:3100/checkout?cart=widget:2,gadget:1&coupon=SAVE10&region=US"' \
  --breakpoint "test/servers/node-api/server.js@subtotal += it.lineTotal" --expression subtotal --expression 'it.sku'

# React (Chrome) — frontend through Vite source maps; bare --chrome launches headless Chrome itself
( cd test/servers/react-app && npm install && npm run dev ) &   # :5180
trace-cli run --chrome --url http://localhost:5180 \
  --breakpoint "test/servers/react-app/src/price.ts@sum = sum + parseInt" --expression sum
```

Run `trace-cli serve` first (or `docker compose up`) and both land live in the dashboard. `test/servers/scenarios.sh` runs the full set.

## Roadmap

- **Built:** Node · Chrome over CDP (attach or auto-launch, scripted journeys + replay video) · static analysis (`graph`/`deps`/`complexity`/`symbols`) · collector + dashboard · Docker.
- **Next** (same envelope): **DAP languages** (Python, Go, Java, C/C++) via a second `ProtocolDriver` · OTel span ingest · the cross-tier `traceparent` handshake. See [`docs/MIGRATION.md`](docs/MIGRATION.md).

## Contributing

Open an issue or PR. Branch from `master`, keep the class-first / domain-driven layout, and run `npm test` (it builds first). A new tracing target implements `ProtocolDriver`; a new static analyzer is a `TraceCommand` under `src/cli/commands/` — both behind the same envelope.

## License

MIT © 2026 Raunak Burrows — see [LICENSE](LICENSE).
