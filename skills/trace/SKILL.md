---
name: trace
description: Get a full execution trace through a running app via the `trace` CLI — set breakpoints at file:line, fire a trigger (a curl command for a Node `--inspect` or Python `debugpy` backend, or a page navigation for a Chrome `--remote-debugging-port` target), and read back every hit with its call stack, locals, watched expressions and timing as one JSON envelope. Language-agnostic: Node/Chrome over CDP, Python over DAP. Also `trace serve` for a realtime web UI of all traces. Use for "trace this request/route", "what runs when I hit /endpoint", "step through this function", "why is this value X here", "set a breakpoint and show the trace". Vendor-neutral: pass the port, the trigger, and the breakpoints — nothing is hardcoded.
allowed-tools: Bash(node:*), Read
---

# trace — unified, language-agnostic execution tracer

`trace dynamic` attaches to an already-running debug target, sets breakpoints, fires a trigger, and prints
the full execution trace in one shot. You read the trace; you never drive the debugger by hand. One engine,
two protocol drivers — **CDP** for Node/Chrome, **DAP** for Python (and other DAP adapters). It needs a
target already listening:
- **Node** (CDP): start with `--inspect` (`node --inspect=9229 …`), then `dynamic --node 9229`.
- **Python** (DAP): the server calls `debugpy.listen(("127.0.0.1", 5678))`, then `dynamic --python 5678`.
- **Chrome** (CDP): start with `--remote-debugging-port=9222`, then `dynamic --chrome 9222 --url <page>`.

## Invoking (do this first)
Run the bundled binary by its **explicit install path** — Claude substitutes `${CLAUDE_PLUGIN_ROOT}`. Do
**not** use the bare name `trace` (it collides with macOS's `/usr/bin/trace`). Set a shorthand once:
```bash
trace="node ${CLAUDE_PLUGIN_ROOT}/bin/trace"
```

## The flags & subcommands describe themselves — read them from the binary
The complete, **always-current** set of commands, flags and arguments is generated from the CLI itself, so it
can't drift from the installed version. Don't rely on this doc for the exact flag list — ask the binary:
```bash
$trace manifest            # structured JSON: every command, flag (with defaults/choices/env vars) & argument
$trace <command> --help    # human help for one command, e.g. `$trace dynamic --help`
```
Use `manifest` when you want to reason over the options programmatically, `--help` for a quick look.
**Everything below is an illustrative mental model; `$trace manifest` is the source of truth for exact flags.**

## Usage
```bash
# Node (CDP) — trigger is a curl run after the breakpoints bind
$trace dynamic --node 9229 \
  --curl 'curl -s http://localhost:3002/v1/dashboard -H "Cookie: sid=…"' \
  --bp src/dashboard/dashboard.service.ts:149 \
  --bp 'src/foo.ts@unique substring on the line'        # line number OR a unique substring

# Python (DAP/debugpy) — trigger is a curl
$trace dynamic --python 5678 \
  --curl 'curl -s http://127.0.0.1:3001/price?qty=3' \
  --bp app/service.py:42 --expr qty

# Chrome (CDP) — trigger is navigating to the route + reloading
$trace dynamic --chrome 9222 --url http://localhost:3000/some/route \
  --bp src/pages/Thing.tsx:42 --shot /tmp/thing.png

# Record a side-by-side debug-replay video (Chrome only): [ app | trace panel ] + captions
$trace dynamic --chrome 9222 --url http://localhost:3000/some/route --bp src/pages/Thing.tsx:42 \
  --record /tmp/replay.mp4
```

**Breakpoints** (`--bp`, repeatable): `file:line` or `file@substring`. `file` is matched by path **suffix**
(Node/Chrome via source maps; Python directly against the `.py`), so a short relative path works; resolve
relative files with `--root <dir>` (defaults to cwd). Use `--check` to verify one binds without tracing.

**Common flags** (run `$trace manifest` for the full, current set): `--expr '<js/py>'` (repeatable; evaluated
at every hit) · `--frames N` · `--max-hits N` · `--root <dir>` · `--json [path]` (envelope to a file, or bare
`--json` for JSON on stdout) · `--emit <url>` (POST the envelope to a `trace serve` collector; or set
`TRACE_COLLECTOR_URL`) · Chrome: `--shot <png>`, **`--record <out.mp4>`**.

## Other subcommands
`$trace manifest` lists them all with their current flags; the ones you'll reach for:
- `$trace doctor` — which backing tools are installed (node, python3, debugpy, chrome, ffmpeg, …).
- `$trace schema` — the output JSON Schema (the **output** contract); `$trace manifest` is the **input** contract.
- `$trace serve --port 4747` — a collector + **realtime web UI** of all traces (Langfuse-style). Run it,
  then add `--emit http://localhost:4747` to any trace. Also runnable as a Docker service (`docker compose up`).

`stdout` is the trace, `stderr` is `[trace]` progress; exit `0` ok · `1` runtime · `2` usage
(`--check`: `0` bound · `2` not bound).

## Reading the trace
Each hit shows `#seq +elapsedMs fn at file:line`, the call `stack`, local/block scope variables (`•`), and
any `--expr` values (`⊢`). Chrome traces also include console errors/warnings, uncaught exceptions, failed
(≥400) responses, and the final URL. With bare `--json`, stdout is the unified envelope: events carry
`source` (`cdp`/`dap`) and a `sessionId`. "no breakpoints hit" means the line wasn't on the path taken
(wrong target/route, branch not taken, or it didn't bind — check with `--check`).

## How it resolves `file:line`
Node/Chrome map breakpoints to generated code via whatever **source maps the target reports** (so compiled
TS and bundled front-ends work with no build config); plain JS binds directly. Python is interpreted, so
`file:line` binds directly against the `.py` source. A breakpoint only binds once its script is **loaded**:
Node/Python are immediate; for Chrome the page is navigated first so modules parse, then it reloads to trigger.
