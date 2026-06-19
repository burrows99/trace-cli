# Where trace-cli misleads the agent — DX gaps from a real debugging session

Minted from a full session transcript (a Claude Code run using `trace-cli` to debug an
aix-chat lazy-load bug). The trace itself worked perfectly the first time and proved the
server-side fetch correct. Everything *after* that — re-running the trace, streaming to the
dashboard — sent the model into a 7-minute loop of wrong theories. None of those wrong
theories were the model "being dumb": at each step the CLI handed it ambiguous or misleading
signal, and the model reasoned locally-correctly from bad input. This doc catalogs each gap,
the exact code that produces it, and a fix.

Severity ordering is by how badly it derailed the session.

---

## ✅ Resolution status (2026-06-19)

All six gaps were addressed across PR #5 (emit failures self-explanatory in the envelope), PR #6
(bounded emit-failure memory + accurate "rejected" vs "failed" wording + capped rejection body), and
PR #7 (empty/aborted runs fail loudly). The analysis below is kept verbatim as the rationale; the code
snippets in each section are the **pre-fix** state. Per-gap status:

| # | Gap | Status | Where it was closed |
|---|-----|--------|---------------------|
| 1 | One 400 for five failures (incl. infra) | ✅ resolved | `ui/app/v1/traces/route.ts` — split into `413` (too large), `400 INGEST_INVALID`, `400 INGEST_NO_SESSION`, and `503 STORE` ("trace store unavailable", raw DB error no longer leaked) |
| 2 | Emit failures swallowed, logged at `info` | ✅ resolved | `Collector.emit` now `log.error`s `!ok` and returns a rich `EmitResult`; `Cli.ts` folds failures into `Diagnostic.warn(Code.EMIT, …)` (PR #5/#6) |
| 3 | `--concise` looks like it shapes the wire | ✅ resolved | `Cli.ts` `--concise` help: "Does NOT affect --emit — the collector always receives the full envelope" |
| 4 | "0 hits" has no JSON why | ✅ resolved | `DynamicCommand.ts:142` emits `Code.BP_BOUND_UNHIT` when bound-but-unhit |
| 5 | Collector port story inconsistent | ◐ partial | `ServeCommand.ts:38` prints the exact `--emit` URL; defaults consolidated in `shared/defaults.ts`. **Open:** auto-discovery still probes only `14747`/`4000` (no lockfile/dotfile of the actually-bound port) |
| 6 | Empty/stuck-"running" reported as success | ◐ mostly | PR #7: `#abortedTrace` emits a terminal envelope (no `running`) on throw; `RECORD_EMPTY`/`UPLOAD`/`RECORD` promoted to envelope diagnostics; "no video" written into `data.recording`. **Open:** dashboard doesn't age out a stale "running" (#6b), and the "done" envelope is still gated on the S3 upload rather than decoupled (#6c) |

---

## 1. One status code (400) for five unrelated failures — including infra failures

**This is the gap that broke the session.** The real `--emit` failed with:

```
{ "error": "password authentication failed for user \"trace\"" }   // HTTP 400
```

That is a **Postgres auth failure** (wrong `DATABASE_URL` password) — a *server-side infra*
problem. But the collector reports it with the **same 400** it uses for a malformed client
envelope. The route's catch-all:

```ts
// ui/app/v1/traces/route.ts
const envelope = Trace.fromPlain(JSON.parse(body));
const problems = envelope.validate();
if (problems.length) return NextResponse.json({ error: "invalid envelope", problems }, { status: 400 });
const summary = await getStore().ingest(envelope.toJSON());   // <-- throws on DB auth failure
if (!summary) return NextResponse.json({ error: "envelope has no meta.sessionId" }, { status: 400 });
...
} catch (error) {
  return NextResponse.json({ error: (error as Error).message }, { status: 400 });  // <-- DB error lands here as 400
}
```

HTTP 400 now means *all* of: malformed JSON, schema-invalid envelope, missing `sessionId`,
**and any thrown server error including a dead/misconfigured database**. The raw Postgres
error string is also leaked to the client.

**How it misled the model:** it saw "400" on the real emit, probed the collector with a
hand-made payload, got a *different* 400 ("invalid envelope — property ping should not
exist"), and fused the two into one false story: "the collector strictly validates → my
emit is schema-invalid → probably `--concise` is trimming required fields." The actual cause
(DB auth) was invisible because it wore the same status code as a schema error.

**Fix:**
- Infra/unexpected throws → **500/503**, not 400. Reserve 400 for "your envelope is wrong."
- Tag responses with a machine code (`error.code: "INVALID_ENVELOPE" | "NO_SESSION_ID" |
  "STORE_UNAVAILABLE"`) so a caller can branch without string-matching.
- Don't leak raw `error.message` (DB creds/topology) to the client; log it server-side, return
  a generic "store unavailable."

> **✅ Resolved.** `ui/app/v1/traces/route.ts` now branches: `413` (envelope too large, `Code.INGEST`),
> `400` (`INGEST_INVALID` for schema problems, `INGEST_NO_SESSION` for a missing `meta.sessionId`), and
> `503` (`Code.STORE`, message "trace store unavailable") for an unreachable/misconfigured store — the raw
> Postgres error is logged server-side, not returned. Every response carries a machine `code`.

---

## 2. Emit failures are swallowed and logged at `info` — the run looks successful

The live `--emit` path drops every failure on the floor:

```ts
// src/cli/Cli.ts:123
const emitToCollector = collector
  ? (envelope) => { emitChain = emitChain.then(() => Collector.emit(collector, envelope).catch(() => false)); }
  : undefined;
```

```ts
// src/collector/Collector.ts:22
const response = await fetch(endpoint, { method: "POST", ... });
log.info("emitted envelope", { endpoint, status: response.status });  // <-- logs a 400 at INFO
return response.ok;                                                    // <-- false, but caller ignores it
```

So a run where **every** emit 400'd still: prints a valid human/JSON trace, exits 0, and
emits one `info` line per POST that happens to carry `status: 400`. The returned `false` is
swallowed by `.catch(() => false)` and never reaches the final envelope's `diagnostics`.

**How it misled the model:** the failed emit produced no error, no diagnostic, no non-zero
exit. The model only discovered the 400 by manually re-probing the endpoint — and then probed
it *wrong* (see #1). The dashboard silently showed nothing while the CLI reported success.

**Fix:**
- `log.warn`/`log.error` when `!response.ok`, including the response body.
- Accumulate emit failures into the final envelope as `Diagnostic.warn(Code.EMIT, ...)` so the
  agent reading `--json` sees "streamed to collector: 3/4 failed (400)".
- Consider a one-line stderr summary at the end: `emit: 0/4 accepted by http://…:4848`.

> **✅ Resolved (PR #5/#6).** `Collector.emit` returns a rich `EmitResult` (`{ ok, status?, body?, error? }`),
> `log.error`s on `!response.ok` with the response body, and caps the retained body at 10k (read off the
> stream and cancelled, so an oversized error page can't spike memory). `Cli.ts` accumulates failures into a
> count + last-failure and folds them into a `Diagnostic.warn(Code.EMIT, …)` on the final envelope — an HTTP
> status reads as "rejected", a status-less network failure as "failed" (`emitFailureMessage`).

---

## 3. `--concise` looks like it shapes the wire envelope; it doesn't

The model's central wrong fix was "drop `--concise` so the emit is accepted." But `--concise`
**never touches what is emitted.** Condensing is applied only to the stdout/file copy:

```ts
// src/cli/Cli.ts:76
const json = options.concise ? condense(trace.toJSON()) : trace.toJSON();   // stdout/file only
```

Every collector emit — live and final — sends the full `trace.toJSON()`, unconditionally:

```ts
// src/cli/Cli.ts:132  (live)
onProgress: (t) => emitToCollector(t.toJSON())
// src/cli/Cli.ts:136  (final)
if (emitToCollector) { emitToCollector(trace.toJSON()); await emitChain; }
```

And even if it *did* apply, `condense` only collapses `data.events[].attributes.locals` →
`localsKeys` and truncates the stack — it never drops a top-level required field, and its own
docstring promises "the trimmed envelope still satisfies the schema" (`Cli.ts:49`).

**How it misled the model:** the flag's name and "trim the envelope" framing strongly imply it
changes the payload on the wire. Nothing in the help text says "stdout only." So the model
spent two capture cycles toggling a flag that is causally inert w.r.t. the collector.

**Fix:**
- Reword the help/option scope: "trim the **printed** `--json` envelope (stdout/file). Does not
  affect `--emit`."
- If a concise wire format is ever wanted, make it explicit and separate; don't let one verb
  ("condense the envelope") ambiguously cover two channels.

> **✅ Resolved.** The `--concise` help text now scopes itself explicitly: "trim the **PRINTED** `--json`
> envelope (stdout/file) … Does NOT affect `--emit` — the collector always receives the full envelope."

---

## 4. "0 breakpoint hits" gives the JSON consumer no why — only the human renderer does

When a run binds the breakpoint but never hits it, the **human** renderer prints a genuinely
helpful line:

```ts
// src/engine/Renderer.ts:22
if (!(data.events?.length))
  lines.push(`\n⚠ no breakpoints hit — line(s) not on this path (right target/route? branch not taken? not bound?).`);
```

But the agent runs `--json`, and the JSON envelope has **no equivalent diagnostic for
"bound but unhit."** Unbound breakpoints *do* get a diagnostic:

```ts
// src/cli/commands/DynamicCommand.ts:110
for (const breakpoint of capture.breakpoints.filter((b) => !b.bound))
  diagnostics.push(Diagnostic.warn(Code.BP_UNBOUND, `${b.file}:${b.line} did not bind ...`));
```

…so the agent can tell `bound:false`. But the much more common "bound, 0 events" case produces
`breakpoints:[{bound:true}], events:[], diagnostics:[]` — structurally silent. The model has to
*infer* the difference, and in the session it instead invented an unverifiable theory
("breakpoint stopped binding on already-parsed modules") and went to grep the dev-server log to
confirm the trigger fired.

**How it misled the model:** the best diagnostic guidance in the codebase lives in the channel
the agent doesn't read. The JSON channel under-reports, so the model substituted speculation.

**Fix:**
- Emit a `Diagnostic.info`/`warn` on the 0-event case into the envelope (mirror the human line):
  `BP_BOUND_UNHIT: "<file>:<line> bound but never hit — trigger may not have run this path."`
- Surface a tiny run summary in `data` the agent can branch on: `{ boundCount, hitCount,
  triggerFired }`. Right now `triggerFired` (did the curl/journey actually execute?) is not a
  first-class field, so "no trigger" vs "trigger ran but missed the line" is unanswerable from
  the envelope alone — which is exactly the fork the model got stuck on.

> **✅ Resolved.** `DynamicCommand.ts:142` now emits `Diagnostic.warn(Code.BP_BOUND_UNHIT, …)` on the
> bound-but-0-events case, mirroring the human renderer's line into the JSON channel. (A consolidated
> `data.summary { boundCount, hitCount, triggerFired }` object was **not** added — the diagnostic carries
> the "why" the agent was missing, which was the derailing gap.)

---

## 5. Collector port story is inconsistent across the repo

Four different ports appear for "the dashboard":

| Source | Port |
|---|---|
| `Collector.resolve` auto-discovery (`src/collector/Collector.ts:9`) | `14747`, `4000` |
| `docker-compose.yml` host mapping | `14747` → container `4747` |
| `docker-compose.yml` comment (line 15) | `:4747` |
| The actual dashboard in this session | `:4848` |

Auto-discovery probes `14747`/`4000` and would **never** find a dashboard on `4848`. The model
only reached it because it passed `--emit http://localhost:4848` explicitly. A user relying on
zero-config auto-discovery (the advertised feature) would silently emit to nothing.

**How it misled the model:** not directly, but it's latent: the "auto-discovery catches every
trace with zero config" promise (`Collector.ts:18,47`) is false for the port the project's own
dashboard actually ran on. Combined with #2 (silent emit failure), a misconfigured port is
undetectable.

**Fix:** single source of truth for the port; have `trace serve` print the exact `--emit` URL
to copy; make auto-discovery probe the port `trace serve` actually bound (or write it to a
well-known dotfile/lockfile the CLI reads).

> **◐ Partially resolved.** `ServeCommand.ts:38` prints the exact `--emit` URL to copy, and the ports are
> consolidated in `shared/defaults.ts` (`DEFAULT_COLLECTOR_PORT = 4000`) with auto-discovery probing
> `14747`/`4000`. **Still open:** auto-discovery can't find a `serve` bound to a non-default port — there's
> no lockfile/dotfile of the actually-bound port for the CLI to read.

---

## 6. A trace that captured and recorded *nothing* is reported as success — and a half-finished run is stuck "running" forever

**Symptom (from the dashboard screenshot):** a `run.chrome` session pinned at the **RUNNING**
badge with **0 events**, **no video**, **no lineage** — sitting above older completed runs — and
the agent never flagged it. It had moved on as if the trace succeeded.

This is the most dangerous gap because it's *silent*: every signal that would say "this trace
is broken or incomplete" is a non-blocking warning, a stderr log, a dashboard-only projection,
or simply absent. Six mechanisms compound:

**a) `running` is a write-once-until-replaced flag with no liveness guarantee.** It's set `true`
on the initial partial *before* any work, and only cleared when the *final* envelope ingests:

```ts
// src/cli/commands/DynamicCommand.ts:64  — emitted the instant the run begins, 0 events
request.onProgress?.(this.#runningTrace([], context));   // #runningTrace sets running:true (L95)
...
const capture = await this.tracer.traceChrome(options);  // L78
const trace = this.#toTrace(capture, ...);               // L79  — the final, running ABSENT
if (isChrome) await this.#record(capture, trace, ...);   // L80  — must finish before final emit
```

Any path that ends the process between those two points — a `traceChrome` throw (e.g. attach
fails because Chrome wasn't relaunched on `--remote-debugging-port`), a hung/slow recording or
S3 upload, the harness killing the long run (`timeout 1m 50s` in the transcript), a Ctrl-C, or a
*rejected final emit* (see #1/#2) — orphans the session as "running" permanently. There is **no
terminal "aborted/failed" envelope and no heartbeat**; nothing ever flips it back.

**b) The dashboard never ages out a stale "running."** The badge is purely the flag; elapsed
time is cosmetic:

```tsx
// ui/app/page.tsx:362,364
<span className={`status ${s.running ? "run" : s.ok === false ? "err" : "ok"}`} />
{s.running && <span className="runlbl">running</span>}
```

A session "running" whose `at` is 10 minutes old still reads "running…". There is no
"running + no update for N seconds ⇒ stalled" rule.

**c) An empty, video-less trace is `ok:true`.** Only `ENGINE_FATAL` / `STEP_FAILED` flip `ok`
(`DynamicCommand.ts:131`). `BP_UNBOUND`, the new `BP_BOUND_UNHIT`, and `RECORD_EMPTY` are all
warnings or stderr-only. So the CLI's success contract — `ok:true`, exit 0 — is satisfied by a
trace that captured nothing and recorded nothing. **This is precisely why the agent doesn't
think it's a problem: the tool told it the run succeeded.**

**d) "No video" is invisible in the envelope.** `#record` never writes the outcome into the JSON:

```ts
// src/cli/commands/DynamicCommand.ts:148-160
const videoPath = await Recorder.renderJourney(...);
if (!videoPath) { log.warn("no frames captured — nothing to record", { code: Code.RECORD_EMPTY }); return; } // stderr only
...
} catch (error) { log.error("recording failed", { code: Code.RECORD, ... }); }  // swallowed; no diagnostic
```

Whether a chrome run *should* have produced a video and didn't is expressed only as the *absence*
of a `data.recording` field — which the agent has no contract to expect — plus a stderr line it
never reads.

**e) The final ("done") signal is coupled to the S3 upload.** `run()` awaits `#record` → which
awaits `Recorder.renderJourney` (ffmpeg) **and** `artifacts.upload` to S3 (`DynamicCommand.ts:80,152,154`)
*before* returning, and only then does Cli emit the final envelope that clears "running" and
carries the link. A slow/misconfigured S3 endpoint (exactly the `S3_ENDPOINT`/mock-aws juggling
in the transcript) delays or prevents the running→done transition. The liveness signal is held
hostage by an artifact upload.

**f) The agent observes its own stdout envelope, never the dashboard.** "Stuck running" is a
server-side projection with no counterpart in the agent's channel. And when the harness kills
the long chrome run, the agent gets a *killed bash command*, not a structured "run aborted before
the final envelope" — so it cannot distinguish "finished empty" from "killed mid-flight," and
(per the transcript) assumes the benign case and moves on.

**Fixes (each closes one mechanism):**
- **Emit a terminal envelope on abort.** Wrap the run so a throw/SIGTERM still emits a final
  envelope with `running:false` + an error diagnostic (`ENGINE_FATAL` "run aborted before
  completion"). The dashboard clears "running"; the agent sees a failure. (SIGKILL can't, but
  attach-throw / upload-failure / rejected-emit all can.)
- **Make an empty chrome trace legible to the agent.** Promote `RECORD_EMPTY` and recording
  failures to envelope **diagnostics**, and add a `data.summary { events, recording: bool,
  durationMs }` an agent can branch on. Consider: for a chrome run, `0 events && no recording`
  is suspicious enough to warrant a distinct, prominent code even if `ok` stays true.
- **Decouple "done" from upload.** Emit the events-complete final envelope first (clearing
  "running"), then patch in the `recording` link once the upload finishes — so a slow S3 never
  masquerades as a stuck run.
- **Age out stale "running" in the dashboard.** `running && now - at > ~120s` ⇒ render
  "stalled," not "running…".

> **◐ Mostly resolved (PR #7).** `DynamicCommand.#abortedTrace` wraps the run so a throw (attach failed,
> engine crashed, recording threw) still emits a terminal envelope with `running` absent + an
> `ENGINE_FATAL` error diagnostic — the dashboard flips to failed and the agent sees a failure (6a, for the
> non-SIGKILL cases). `RECORD_EMPTY`, `UPLOAD`, and `RECORD` are now envelope **diagnostics**, not stderr-only,
> and `data.recording` is written even for a local-only video, so "no video" is legible in `--json` (6d).
> **Still open:** the dashboard doesn't age out a stale "running" badge (6b), and the "done" envelope is still
> awaited behind `#record` → S3 upload rather than emitted first and patched with the link (6c).

---

## Cross-cutting theme

Every gap above is the same shape: **the CLI knows the answer but doesn't put it where the
agent looks.** The agent consumes `--json` + exit codes; the CLI puts its best signal in human
render lines (#4), `info`/`error` logs (#2, #6d), dashboard-only state (#6a/b/f), or collapses
distinct failures into one undifferentiated 400 (#1). The model wasn't being un-intuitive — it
was reasoning correctly from a feedback channel that was lossy by construction. The sharpest
form of this is #6: the agent calls an empty, perpetually-"running" trace a success because
`ok:true` is the *only* contract it has, and nothing contradicts it.

**The single highest-leverage fix:** make the JSON envelope self-explanatory about
**completeness and failure**, not just schema-validity. Distinct error codes (#1), emit-failure
diagnostics (#2), a 0-hit/trigger summary (#4), a terminal abort envelope + an empty-trace
diagnostic + a run summary (#6) — together these turn "ok:true, but actually broken" into a
signal the agent can't miss.
