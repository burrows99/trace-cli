# trace-cli

![license MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![node >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)

Execution tracer & analyzer — one JSON envelope across breakpoint traces (Node/Chrome CDP) and static analysis.

Point it at a running program, give it breakpoints + a trigger → a full **execution trace** (every hit in order: call stack, locals, watched expressions, timing) as **one JSON envelope**, identical shape across targets.

- **Breakpoints never pause the program.** They're armed as non-pausing *logpoints*: each hit captures its stack, every in-scope local (read statically from the source — no naming needed), and any extra `--expression`, then ships it out without halting the VM. The app runs at full speed, hot paths are cheap, and there's no human-style "stop and wait" — built for an agent that reads the trace and re-aims breakpoints, not a human stepping by hand. (Trade-off: capturing *all* locals automatically needs source the runtime can read by name — perfect for Node and dev-mode frontends; a minified production bundle yields mangled local names, though `--expression` and the stack still work.)
  - *The one exception — "THE ONE PAUSE":* a Chrome run that opens by navigating a fresh tab briefly halts **once, during setup**, to bind a breakpoint before the page's first-run/on-mount code executes (CDP `beforeScriptExecution`). It never halts on a hit and drops itself as soon as binding settles. It lives in `TabTracer` (grep `THE ONE PAUSE`). Removing it loses on-mount capture entirely — measured 3 → 0 hits.
- Not "a debugger" — **OpenTelemetry for software execution**: every source (debug protocol, span exporter, shell) normalizes to one `Event`; events are the asset. See [`docs/MIGRATION.md`](docs/MIGRATION.md).

```
trace-cli run       ← breakpoints + a trigger → a full trace   (Node curl · Chrome scripted journey + video, via CDP)
trace-cli graph|deps|complexity|symbols  ← code structure without running it (graph via LSP call hierarchy · deps · complexity · symbols)
trace-cli serve     ← collector + realtime UI: show ALL traces live (Langfuse-style)
trace-cli doctor    ← which backing tools are installed
trace-cli schema    ← the output JSON Schema (the contract)
```

- **Not coupled to any project** — ports, triggers, breakpoint files all come from flags. Runs on plain Node (≥ 18).
- Transport delegated to **CDP via `chrome-remote-interface`** — the project owns target discovery + the event model, not the wire protocol.

## Table of Contents

- [Install](#install)
- [Native-first runtime model](#native-first-runtime-model)
- [Usage](#usage)
- [Realtime UI and Docker](#realtime-ui-and-docker)
- [Static analysis](#static-analysis)
- [The trace envelope](#the-trace-envelope)
- [Claude Code plugin](#claude-code-plugin)
- [Try it](#try-it)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

## Install

- **As a Claude Code plugin** — bundles the `trace` skill + the `bin/` binary:
  ```bash
  claude plugin marketplace add /path/to/trace-cli
  claude plugin install trace@trace-oss
  ```
- **As a CLI / library (npm)** — `npm i -g trace-cli` for the global `trace-cli` command, or `npm i trace-cli` to import the classes. Requires **Node ≥ 18**.
- Check backing tools (chrome, ffmpeg, language servers, …) with `trace-cli doctor`.

## Native-first runtime model

- `trace-cli` is **native-first**. The CLI is meant to run directly on the host where your debug target is reachable.
- The CLI is fully usable without Docker: `run`, `graph`, `deps`, `complexity`, `symbols`, `doctor`, and `schema` all run natively.
- `trace-cli serve` is an **optional collector service** for ingest + UI.
- Docker Compose exists to run supporting services for that collector mode (collector UI/API, Postgres session store, optional S3-compatible object store).
- Practical rule: run tracing commands natively; use Compose only when you want centralized capture/history/replay UI.

## Usage

One engine, one protocol driver — **CDP** for the JS family (Node `--inspect` and Chrome).

### CLI

```bash
# Node (CDP): attach to a --inspect port, fire a curl, trace the request
trace-cli run --node 9229 \
  --curl 'curl -s http://localhost:3000/v1/dashboard' \
  --breakpoint src/dashboard/dashboard.service.ts:149 \
  --expression 'user.id'

# Chrome (CDP): attach to a --remote-debugging-port and drive a scripted UI journey, recording a screen + trace-panel video
trace-cli run --chrome 9222 --breakpoint src/pages/Thing.tsx:42 \
  --url http://localhost:3000/login --step 'type:#email=me@example.com' --step 'click:text=Sign in'
# --url alone is the single-navigation shorthand (one goto: step); --output <mp4> sets the recording path

# …or omit the port — the CLI launches a throwaway headless Chrome itself, traces, records, and tears it down
trace-cli run --chrome --url http://localhost:5173/route --breakpoint src/pages/Thing.tsx:42
```

- **Flags (both targets):** `--breakpoint <file:line | file@substring>` (repeatable) · `--expression '<js>'` (repeatable, evaluated per hit) · `--json [path]` (to a file, or bare `--json` → stdout).
- **Trigger:** Node → `--curl`; Chrome → `--url` (one navigation) and/or `--step` — an ordered UI journey (`goto`/`click`/`type`/`waitfor`/`wait`/`newtab`/`eval`, validated against a fixed vocabulary); `--output <mp4>` sets the recording path.
- **Chrome requires ≥1 `--breakpoint`** — debug + video are produced together. `--chrome <port>` attaches to a browser you launched (a real, logged-in session); bare `--chrome` launches a throwaway headless Chrome.
- **Chrome always records** a debug-replay video (motion screencast + the live trace panel: stack/locals/watch) → uploaded to S3 if `S3_ENDPOINT` is set (`data.recording.url`), else kept as a local path.
- **The app's own output is captured too:** every `console.*` call and uncaught exception during the run lands in `data.console` (and the human render), so you see what the app *said* and *threw*, not just where it stopped.
- **Progress is narrated** on `stderr` as it runs — attach → breakpoints armed → trigger fired → a heartbeat while waiting for hits → capture/record — so a slow trigger reads as progress, not a hang.
- **I/O & exit:** `stdout` = the trace; `stderr` = structured logs. Verbosity: `-v`/`--verbose` (every phase + CDP transport) · `-q`/`--quiet` (errors only), or the `TRACE_LOG_LEVEL=debug|info|warn|error|silent` / `TRACE_LOG_FORMAT=json|pretty` env vars; exit `0` ok · `1` runtime · `2` usage.
- Inputs **and** the emitted envelope are validated (class-validator) before anything runs or ships. Other knobs (hit cap, stack depth, source root, attach timeout) use sane defaults — kept off the flag surface.
- One `ProtocolDriver` interface → more debug protocols (DAP: Python/Go/Java/C/C++/Rust) are a new driver behind the same envelope — see the [Roadmap](#roadmap).

### Library

Class-first / domain-driven TypeScript (`domain/` entities, `transport/` drivers, `engine/`, `analysis/`, `storage/`, `collector/`, `cli/`). `npm run build`, then:

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

- Also exported: `Tracer`, `CdpDriver` (`ProtocolDriver`), `LineageAnalyzer`, `S3ArtifactStore` (`ArtifactStore`), `Collector`/`PostgresSessionStore` (`SessionStore`).

## Realtime UI and Docker

- This section is optional infrastructure. It is for collecting and visualizing traces, not for running the CLI itself.
- `trace-cli serve` = **collector + realtime web UI** (Langfuse-style): a live session list over SSE + a per-trace timeline (stack, locals, watched expressions, response).
- Point any trace at it with `TRACE_COLLECTOR_URL` → every run POSTs its envelope.
- Sessions persist in **Postgres** — `DATABASE_URL` (or `POSTGRES_URL`, or `--database-url <url>`); the schema is auto-created on first use, no migrations.

```bash
# locally (point at any Postgres; the trace_sessions table is created automatically)
export DATABASE_URL=postgres://user:pass@localhost:5432/trace
trace-cli serve --port 4747                 # → http://localhost:4747
TRACE_COLLECTOR_URL=http://localhost:4747 trace-cli run --node 9229 --breakpoint app.js:42 --curl '…'

# optional Docker services for collector mode: UI/API + Postgres + mock-aws (S3)
docker compose up --build               # → http://localhost:4747 (UI), :5432 (Postgres), :9000/:9001 (S3)
# then run the CLI natively from the host where your debug target is reachable:
export S3_ENDPOINT=http://localhost:9000
TRACE_COLLECTOR_URL=http://localhost:4747 trace-cli run --chrome 9222 --url http://localhost:3000 --breakpoint src/App.tsx:9
```

- Each envelope = one `trace_sessions` row (full envelope as JSONB + a precomputed summary).
- Chrome recordings upload to S3 (`mock-aws` locally; point `S3_ENDPOINT` at real AWS in prod — same code, AWS SDK); the video link rides in the trace + plays in the UI.
- Ingest is strict — a malformed envelope is rejected with `400` + the offending fields.
- **API:** `POST /v1/traces` (ingest) · `GET /api/sessions` · `GET /api/sessions/:id` · `GET /api/stream` (SSE).
- UI is a **Next.js app** (App Router, static export) in [`ui/`](ui/); `npm run build` exports it (`output: 'export'` → `ui/out`) into `dist/collector/ui`, served at `/` by the collector — one process, no extra port.

```bash
trace-cli serve --port 4000        # collector + API (data source)
npm run dev:ui                 # Next.js dev → http://localhost:3000 (reads :4000 via ui/.env.development)
```

## Static analysis

Code structure **without running anything** — the same envelope, no live target.

- `trace-cli graph` — call graph / flow tree ("what calls what") for a function or route, via a **language server over LSP** (`prepareCallHierarchy` + `callHierarchy/outgoingCalls`) — the IDE *Show Call Hierarchy* engine, so it's type-accurate (DI-injected services, interface→impl, cross-file imports), not a regex guess.

```bash
# the common case — just the entry; root + language server are auto-detected
trace-cli graph --entry src/auth/auth.service.ts:42:9
trace-cli graph --entry src/auth/auth.service.ts@exchangeToken     # …or by symbol
```

- **Only required input:** the entry (`file:line`, `file:line:col`, or `file@symbol`). **Root** auto-found (nearest `tsconfig.json`/`package.json`/`.git`); **LSP server** chosen by file extension (TS/JS bundled). `--depth <n>` bounds it; `--server <cmd>` / `--root <dir>` override.
- **Payload:** normalized `{ nodes, edges }` (the schema's `Graph` shape) under `data.graph`; the human render is a flow tree marking shared callees (`→ shared`), recursion (`↻ cycle`), external code (`⊗ external`).

**Any language with a call-hierarchy LSP server** — point `--server` at it:

| Language | `--server` | Notes |
| --- | --- | --- |
| TS / JS / React | *(bundled `typescript-language-server`)* | default; `.tsx`/`.jsx` included |
| Python | `pyright` / `basedpyright` | install the server |
| Go | `gopls` | install the server |
| Rust | `rust-analyzer` | install the server |
| C / C++ | `clangd` | needs `compile_commands.json` |
| Java | `jdtls` | install + a custom launch command |

- **Caveats** (server/project, not the tool): the server must be installed + advertise `callHierarchyProvider` (the CLI errors clearly if not); the project must be resolvable (e.g. clangd needs `compile_commands.json`); it's a *call* graph — JSX `<Component/>` composition isn't a call, and calls nested in callbacks attribute to the callback.

**Sibling analyses** share the same envelope, each shelling out to its analyzer (degrading to a clear error diagnostic when the tool isn't installed — `trace-cli doctor` shows what's present):

```bash
trace-cli deps --entry src/index.ts   # module-import graph + circular-dependency groups   (madge)
trace-cli complexity src              # per-function cyclomatic complexity                  (lizard)
trace-cli symbols src/app.ts          # a file's definition outline (functions/classes/…)   (tree-sitter)
```

## The trace envelope

- Every subcommand emits the same envelope; only `data` varies, built from shared shapes (`SourceLocation`/`Symbol`/`Metric`/`Graph`/`Event`).
- `Event` is the unifier — a CDP breakpoint hit, a span, and a UI action all become `Event`s on one timeline, each tagged with `source` (`cdp`/`terminal`/`otel`) + a `sessionId` for cross-source correlation.

```jsonc
{
  "tool": "trace", "version": "0.3.0", "command": "run.node", "ok": true,
  "meta": { "at": "…", "sessionId": "…", "durationMs": 142 },
  "target": { "kind": "node", "source": "cdp", "trigger": "curl …" },
  "data": {
    "breakpoints": [ { "file": "server.js", "line": 42, "bound": true } ],
    "events": [ {
      "sequence": 1, "kind": "breakpoint", "source": "cdp", "sessionId": "…",
      "location": { "file": "server.js", "line": 42 }, "label": "priceFor", "time": 12,
      "attributes": { "stack": [ "…" ], "locals": { }, "exprs": { } }
    } ],
    "lineage": [ { "name": "total", "kind": "expr", "changes": 2,
      "series": [ { "sequence": 1, "value": 0 }, { "sequence": 2, "value": 9.99, "changed": true } ] } ],
    "response": { "exitCode": 0, "body": "…" }
  },
  "diagnostics": []
}
```

- **Mutation lineage** (`data.lineage`): a *derived* per-watched-value series of how it changed as flow continued (`total: 0 → 9.99 → 14.49`) — value-over-time, not per-hit snapshots; surfaces in the human render, the JSON envelope, and the live UI (empty when nothing mutates).
- Print the full JSON Schema with `trace-cli schema` — [`src/shared/trace.schema.json`](src/shared/trace.schema.json).

## Claude Code plugin

This repo is also a [Claude Code plugin](https://code.claude.com/docs/en/plugins) — installing it bundles a usage skill + the `bin/` binary:

```bash
claude plugin marketplace add /path/to/trace-cli
claude plugin install trace@trace-oss
```

- The skill invokes the binary by its install path, `${CLAUDE_PLUGIN_ROOT}/bin/trace`.

## Try it

Sample servers under `test/servers/` — a Node order-API and a React checkout UI, each with a planted bug so the tracer has something to reveal:

```bash
# Node (CDP)
PORT=3100 node --inspect=9230 test/servers/node-api/server.js &
trace-cli run --node 9230 --curl 'curl -s "http://127.0.0.1:3100/checkout?cart=widget:2,gadget:1&coupon=SAVE10&region=US"' \
  --breakpoint "test/servers/node-api/server.js@subtotal += it.lineTotal" --expression subtotal --expression 'it.sku'

# React (Chrome / CDP) — frontend through Vite source maps; bare --chrome → the CLI launches headless Chrome itself
cd test/servers/react-app && npm install && npm run dev &     # serves :5180
trace-cli run --chrome --url http://localhost:5180 \
  --breakpoint "test/servers/react-app/src/price.ts@sum = sum + parseInt" --expression sum
```

- Both emit the same envelope shape; prefix either with `TRACE_COLLECTOR_URL=http://localhost:4747` to watch them land live in the `trace-cli serve` UI.

## Roadmap

- **Built:** backend pillar (`trace-cli run`: Node · Chrome over CDP, attach *or* auto-launch, scripted journeys + debug-replay video) · static pillar (`graph` via LSP call hierarchy, `deps`/madge, `complexity`/lizard, `symbols`/tree-sitter) · collector/UI · Docker.
- **Next** (same envelope): **DAP languages** (Python, Go, Java, C/C++) for *dynamic* tracing via a second `ProtocolDriver` · `trace-cli exec` (OTel spans) · `trace-cli web` (Playwright) · `trace-cli correlate` (the cross-tier `traceparent` handshake).
- See [`docs/MIGRATION.md`](docs/MIGRATION.md).

## Contributing

- **Questions / bugs:** open an issue on the repository. **PRs:** welcome.
- **Before a PR:** branch from `master`, keep the **class-first / domain-driven** layout, and run `npm test` (it builds first) — it must pass.
- **Extending:** a new tracing target implements the `ProtocolDriver` interface behind the same envelope (see [`docs/MIGRATION.md`](docs/MIGRATION.md)); a new static analyzer is a `TraceCommand` under `src/cli/commands/` that emits the shared envelope.

## License

MIT © 2026 Raunak Burrows — see [LICENSE](LICENSE).
