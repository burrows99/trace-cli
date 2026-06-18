# Migration: `trace-cli` → unified tracing/analysis orchestration CLI

**Status:** proposal for review — no implementation code yet.
**From:** v0.2.1 (single-purpose CDP execution tracer)
**To:** v0.3.0 (multi-subcommand `trace` CLI that wraps existing OSS tools across three pillars and normalizes every tool's output to one JSON schema)

> **Naming note (post-rename):** the installed command is now **`trace-cli`** (renamed from `trace` to avoid
> colliding with macOS's `/usr/bin/trace`). The historical examples below predate the rename — read every
> `trace …` invocation as `trace-cli …`. The deliberately-removed flat `trace --port/--chrome` interface is
> unaffected (it no longer exists; see the CLI hard-cut note).

---

## 1. Thesis

The value we add is **a unified interface + one JSON schema**, *not* new analysis engines.
Every subcommand is a thin orchestration shell that:

1. invokes the right existing tool (our own CDP engine, `ripgrep`, `lizard`, `tree-sitter`, `otel-cli`, Playwright, …),
2. parses that tool's native output,
3. normalizes it into **one shared schema**,
4. writes JSON to stdout.

Target: ~50–100 lines of orchestration per subcommand. The schema is the contract everything conforms to.

### The three pillars (from the design notes)

| Pillar | What | Backing tool(s) | Status |
|---|---|---|---|
| **Static** | analysis without running code | `tree-sitter`, `lizard`, `ripgrep`, `madge`/`pydeps` | new |
| **Runtime / backend** | server-side execution traces & spans | `otel-cli exec`, **our CDP engine (Node)** | partial (CDP exists) |
| **Frontend** | browser execution traces | Playwright `--trace on`, **our CDP engine (Chrome)** | partial (CDP exists) |
| **Correlation** | frontend `trace_id` → backend `trace_id` handshake | `traceparent` + network interception | new, highest risk |

The current product *is* the CDP slice of the runtime + frontend pillars. Migration = generalize the
shell around it, not rewrite it.

---

## 2. Target CLI surface

Root command gains subcommands. The old flat `trace --port/--chrome` interface was removed in 0.3.0 — there is
no back-compat shim; every trace runs through `trace-cli dynamic --node|--chrome`.

```
trace dynamic   ...        # today's engine: breakpoints + trigger → hits (Node or Chrome)
trace static    <kind> ... # deps | complexity | symbols | search   (no execution)
trace exec      -- <cmd>   # run a command under otel-cli, capture spans
trace spans     query ...  # query an OTel store (otel-desktop-viewer / DuckDB)
trace web       -- <pw>    # run a Playwright script with --trace on, normalize trace.zip
trace correlate ...        # cross-tier frontend↔backend span graph
trace doctor               # report which backing tools are installed (+ versions)
trace schema               # print the JSON Schema (the contract)

# REMOVED in 0.3.0 — the flat interface no longer exists. Use `trace-cli dynamic …` instead:
#   trace-cli dynamic --node 9229   --curl '…' --bp file:line …
#   trace-cli dynamic --chrome 9222 --url …     --bp file:line …   (Chrome auto-records the replay video)
```

`stdout` = the JSON envelope (or the human render). `stderr` = structured logs
(`TRACE_LOG_LEVEL`/`TRACE_LOG_FORMAT`). Exit codes unchanged (`0` ok · `1` runtime · `2` usage), plus
`3` = required backing tool missing.

### Subcommand → tool → normalization map

| Subcommand | Backing tool | Native output | Normalized into (§4) |
|---|---|---|---|
| `static deps` | `madge` (JS/TS), else `tree-sitter`+`rg` (any lang) | JSON adjacency | `Graph` |
| `static complexity` | `lizard` | CSV/XML | `Symbol[]` + `Metric[]` |
| `static symbols` | `tree-sitter` (+ grammar) | AST nodes | `Symbol[]` |
| `static search` | `ripgrep --json` | JSONL | `Match[]` (`Loc` + text) |
| `dynamic` (Node) | **our CDP engine** | (already structured) | `Event[]` + `response` |
| `dynamic` (Chrome) | **our CDP engine** | (already structured) | `Event[]` + `console`/`network` |
| `exec` | `otel-cli exec` | OTLP spans | `Event[]` + span `Graph` |
| `spans query` | `otel-desktop-viewer` DuckDB | rows | `Event[]` |
| `web` | Playwright `--trace on` | `trace.zip`→`trace.json` | `Event[]` (actions/net/console) |
| `correlate` | `traceparent` + interception | joined spans | cross-tier `Graph` + `Event[]` |

---

## 3. Target module layout

```
src/
  cli.js                  # commander root; registers subcommands
  commands/
    dynamic.js            # wraps engine/trace.js → envelope (today's behavior, incl. auto-recorded Chrome replay)
    static.js             # deps | complexity | symbols | search dispatch
    exec.js               # otel-cli exec
    spans.js              # otel store query
    web.js                # playwright trace
    correlate.js          # cross-tier handshake
    doctor.js             # tool presence + version probe
  schema/
    trace.schema.json     # THE CONTRACT (JSON Schema draft 2020-12)
    envelope.js           # makeEnvelope(), shared shape builders (Loc/Symbol/Graph/Event/Metric), validate()
  adapters/               # (replaces empty src/backends/) one module per external tool
    ripgrep.js  lizard.js  treesitter.js  madge.js  otelcli.js  playwright.js
  engine/                 # today's CDP engine, MOVED here unchanged
    trace.js  cdp.js  sourcemaps.js  breakpoints.js  render.js  record.js
  index.js                # library exports: keep traceNode/traceChrome + add command fns
```

### Adapter contract (every external tool implements this)

```js
// src/adapters/<tool>.js
export default {
  name: "lizard",
  async detect() { /* which + --version */ return { present: true, version: "1.17.10" }; },
  async run(opts) { /* execa/child_process → native output (string|object) */ },
  normalize(native, ctx) { /* → shared shapes from §4 */ },
};
```

Adapters are the *only* place that knows a tool's native format. Commands compose adapters and wrap the
result in the envelope. This keeps each subcommand at the ~50–100 line target.

---

## 4. The contract: one JSON schema

Every subcommand emits the **same envelope**; only `data` varies, and `data` is built from a small set of
**shared shapes** so consumers learn one vocabulary.

### Envelope (all commands)

```jsonc
{
  "tool": "trace",
  "version": "0.3.0",
  "command": "static.complexity",        // dotted command id
  "ok": true,
  "meta": {
    "at": "2026-06-17T12:00:00Z",
    "args": { "...": "resolved options" },
    "durationMs": 123,
    "toolVersions": { "lizard": "1.17.10" }   // provenance of the backing OSS tool
  },
  "target": { "...": "what was analyzed/run (paths, port, url, cmd)" },
  "data": { "...": "command-specific, composed from shared shapes below" },
  "diagnostics": [ { "level": "warn", "code": "TOOL_MISSING", "message": "…" } ]
}
```

### Shared shapes (the vocabulary)

```jsonc
Loc    { file, line?, col?, endLine?, symbol?, lang? }
Symbol { id, name, kind, loc: Loc, signature?, metrics?: Metric[] }
Metric { name, value, unit? }
Graph  { nodes: [{ id, kind, label, loc?: Loc }],
         edges: [{ from, to, kind, weight? }] }
Event  { seq, t, kind, loc?: Loc, label,
         attrs?, traceId?, spanId?, parentSpanId? }   // the timeline primitive
```

`Event` is the key unifier: a CDP breakpoint hit, an OTel span, and a Playwright action all become `Event`s
on one timeline — which is exactly what makes cross-pillar correlation (`trace correlate`) expressible.

### How today's output maps onto the schema (concrete, no data loss)

Today a hit is `{ seq, kind, at, fn, cls?, tMs, stack[], locals{}, exprs{}? }`. It becomes:

```jsonc
Event {
  "seq": 1, "kind": "breakpoint", "t": 142,
  "loc": { "file": "src/dashboard/dashboard.service.ts", "line": 149 },   // parsed from `at`
  "label": "fetchDashboard",                                              // was `fn`
  "attrs": { "stack": [...], "locals": {...}, "exprs": {...}, "cls": "DashboardService" }
}
```

`breakpoints[]`, `response`, `console[]`, `network[]`, `finalUrl`, `screenshot` move under `data`/`target`
unchanged. **The engine keeps emitting its existing rich internal result**; a thin `normalize()` at the CLI
edge maps it to the envelope. `render.js` and `record.js` keep consuming the internal result, so the
recorder/human-render path carries zero migration risk.

---

## 5. Phased rollout (each phase ships independently, tests stay green)

| Phase | Deliverable | Risk |
|---|---|---|
| **0 — Contract** | `schema/trace.schema.json` + `envelope.js` + validator + golden fixtures. No behavior change. | low |
| **1 — `dynamic`** | Move engine → `engine/`; add `trace-cli dynamic` wrapping `traceNode`/`traceChrome`; hard-cut the flat `trace --port/--chrome` interface; update `index.js`, skill, plugin. | low |
| **2 — `doctor` + adapters scaffold** | `trace doctor`; `adapters/` with `detect()` for each tool; normalize stubs. | low |
| **3 — Static pillar** | `static search`(rg) → `static complexity`(lizard) → `static symbols`(tree-sitter) → `static deps`(madge/ts). Each small & independent. | low–med |
| **4 — Runtime spans** | `trace exec` via `otel-cli`; optional `spans query`. | med |
| **5 — Frontend web** | `trace web` via Playwright trace.zip parsing. | med (format) |
| **6 — Correlation** | `trace correlate` — the `traceparent` handshake. | **high** |
| **7 — Release** | version bump 0.3.0, README/skill/plugin/`docs/schema.md`. | low |

Phases 3–6 are independent; ship in any order or drop any pillar without blocking the others.

---

## 6. Honest callouts / risks (carried from the design notes + added)

- **No backward compatibility.** 0.3.0 hard-cut the flat `trace --port/--chrome` interface; the plugin + skill
  ship `trace-cli dynamic` only.
- **Language-agnostic deps:** `madge` is JS/TS only; `pydeps`/`go-callvis` are per-language. Recommend
  `tree-sitter` + `ripgrep` as the *universal* fallback and treat per-language dep tools as optional adapters.
- **Playwright `trace.json` is not a stable public API.** Pin the Playwright version, parse behind an adapter
  with a version guard + golden fixture; low-risk but must be isolated.
- **OTel correlation is real code, not config** — the `traceparent` inject + frontend/backend join. Highest
  risk; scheduled last and optional.
- **External tools stay optional.** Core install (`commander`, `source-map`) stays light. Backing tools are
  "bring your own binary," probed by `trace doctor`, and each subcommand degrades with a clear
  `TOOL_MISSING` diagnostic + exit `3` rather than crashing.
- **Schema validation adds a dep** (`ajv`) if we want runtime validation of our own output in tests.

---

## 7. Open decisions to confirm before Phase 1

1. **Back-compat strategy:** *(resolved)* hard-cut — the flat `trace --port/--chrome` interface was removed in
   0.3.0; `trace-cli dynamic …` is the only entry point.
2. **Backing-tool packaging:** bring-your-own-binary + `doctor` *(recommended, keeps install light &
   language-agnostic)*, vs. `optionalDependencies`, vs. hard `dependencies`?
3. **v1 pillar scope:** which pillars are in the first milestone? (e.g. Static + keep CDP now; OTel/Playwright/
   correlate later?)
4. **Schema validation:** ship a real JSON Schema + `ajv` runtime validation in tests *(recommended)*, or a
   documented shape only (no validator dep)?
5. **Naming:** `trace dynamic` for the CDP engine — or a different verb (`trace run` / `trace debug`)?

---

## 8. North star — execution as an event stream (the reframe)

The product is **not "a debugger." It is OpenTelemetry for software execution.** The debugger is one signal
source among many. Everything a program does — a breakpoint hit, a span, a shell command, a UI action —
normalizes to one `Event`, and `Event`s are the **asset** (videos are an *output*; events are the asset).

```
        ┌──────────────── Trace collection ────────────────┐
        ▼                  ▼                  ▼              ▼
   DAP collector      CDP collector     terminal collector  otel collector
   (debugpy, dlv-     (Node --inspect,  (shell, git)        (otel-cli)
    dap, lldb-dap,     Chrome)
    java-debug)
        └──────────────→  one Event schema  ←──────────────┘
                              │
              source + sessionId → cross-source correlation
                              │
                    Knowledge graph → LLM   (Debugger → Event Stream → Graph → LLM)
```

**Principle: borrow battle-tested components; spend engineering only on what's differentiating.**

| Don't build | Borrow | Do build (the differentiation) |
|---|---|---|
| a custom wire protocol | DAP via `@vscode/debugadapter-testsupport`, CDP via `chrome-remote-interface` | the **unified Event schema** |
| a storage engine | SQLite → ClickHouse (at scale) | **cross-language correlation** |
| a tracing format | OpenTelemetry (spans/attrs/exporters) | the **replay / agent-analysis** layer |

The line between **infrastructure to own** vs **infrastructure to borrow**: own `EventEnvelope` /
`TraceRecorder` / `SessionManager` / `ReplayEngine` and the *environment-specific* bits libraries can't
generalize (target discovery — `resolveWsUrl` — differs per Chrome/Node/Electron/k8s/CI); borrow CDP & DAP
transport, storage, and tracing. This is why **both** protocol drivers are now thin wrappers — the DAP
driver over Microsoft's `DebugClient`, the CDP driver over `chrome-remote-interface` — instead of
hand-rolling WebSocket framing, request ids, and event routing; why every `Event` carries `source`
(`cdp`/`dap`/`terminal`/`otel`) and a `sessionId`; and why the envelope maps cleanly onto OTel spans
(`traceId`/`spanId`/`parentSpanId` already reserved).

**Deferred to "platform" stage (captured here, intentionally NOT built yet):** ClickHouse/Redis storage,
OTel exporters, event-sourced (rr-style) replay, eBPF. Today's scope stays a Node CLI emitting the event
stream to stdout/`--json`; these slot in behind the same schema when scale demands.

---

## 9. Implementation status (v0.3.0)

**Built & verified end-to-end (this milestone — the language-agnostic backend pillar):**

- ✅ **Contract:** `src/schema/{envelope.js,trace.schema.json}` — envelope + shared shapes
  (`Loc`/`Symbol`/`Metric`/`Graph`/`Event`), `Event` now `source`- and `sessionId`-tagged. 8 contract tests.
- ✅ **Restructure:** engine moved to `src/engine/`; `src/commands/`, `src/adapters/`, `src/schema/` added.
- ✅ **Protocol-pluggable engine:** CDP driver (`cdp.js`, Node/Chrome) **over `chrome-remote-interface`** +
  DAP driver (`dap.js`) **over the official `DebugClient`** (Python/debugpy; any DAP adapter). We own
  discovery + RemoteObject/variable rendering; the libraries own the wire. One trigger+capture loop (`trace.js`).
- ✅ **CLI hard-cut:** `trace dynamic --node|--chrome|--python`, `trace doctor`, `trace schema`. Old flat
  `trace --port` interface removed (→ `trace dynamic --node`).
- ✅ **Test servers:** `test/servers/{node-api,python-api}` with identical business logic — the SAME trace
  (stack, locals, watched exprs) verified across Node (CDP) and Python (DAP), same envelope shape.
- ✅ All 15 tests green (`npm test`).

**Protocol notes learned (validated against the DAP spec + debugpy):**
- attach `arguments` must be **non-empty** (`{ justMyCode: false }`) — empty `{}` trips a debugpy bug.
- `configurationDone` is gated on `supportsConfigurationDoneRequest` for non-debugpy adapters.
- attached debuggee → `disconnect` (never `terminate`), so a server survives repeated traces.

**Remaining (the rest of "the full thing"):**
- ⏳ More DAP languages via the same driver: Go (`dlv dap`), Java (`java-debug`), C/C++/Rust (`lldb-dap`).
- ⏳ Static pillar: `trace static search|complexity|symbols|deps` (ripgrep present; lizard/tree-sitter/madge).
- ⏳ `trace exec` (otel-cli spans; needs Go), `trace web` (Playwright), `trace correlate` (cross-tier).
- ⏳ Release polish: README, skill, `.claude-plugin` manifests.
```
