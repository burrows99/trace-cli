---
name: trace
description: Get a full execution trace through a running app via the `trace` CLI — set breakpoints at file:line, fire a trigger (a curl command for a Node `--inspect` target, or a page navigation for a Chrome `--remote-debugging-port` target), and read back every hit with its call stack, locals, watched expressions and timing. Use for "trace this request/route", "what runs when I hit /endpoint", "step through this function", "why is this value X here", "set a breakpoint and show the trace". Vendor-neutral: pass the port, the trigger, and the breakpoints — nothing is hardcoded.
allowed-tools: Bash(node:*), Read
---

# trace — execution tracer over the Chrome DevTools Protocol

`trace` attaches to an already-running debug target, sets breakpoints, fires a trigger, and prints the
full execution trace in one shot. You read the trace; you never drive the debugger by hand. It needs a
target already listening:
- **Node**: start the process with `--inspect` (e.g. `node --inspect=9229 …`), then use `--port 9229`.
- **Chrome**: start Chrome with `--remote-debugging-port=9222`, then use `--chrome 9222 --url <page>`.

## Invoking (do this first)
Run the bundled binary by its **explicit install path** — Claude substitutes `${CLAUDE_PLUGIN_ROOT}` to this
plugin's directory. Do **not** use the bare name `trace`: it collides with macOS's `/usr/bin/trace` (plugin
`bin/` is appended to PATH, so the system one wins). Set a shorthand once, then use `$trace` everywhere:
```bash
trace="node ${CLAUDE_PLUGIN_ROOT}/bin/trace"
```

## Usage
```bash
# Node target — trigger is a curl command run after the breakpoints bind
$trace --port 9229 \
  --curl 'curl -s http://localhost:3002/v1/dashboard -H "Cookie: sid=…"' \
  --bp src/dashboard/dashboard.service.ts:149 \
  --bp 'src/foo.ts@unique substring on the line'        # line number OR a unique substring

# Chrome target — trigger is navigating to the route + reloading
$trace --chrome 9222 --url http://localhost:3000/some/route \
  --bp src/pages/Thing.tsx:42 --shot /tmp/thing.png

# Record a side-by-side debug-replay video: [ app | trace panel ] + captions, one held frame per hit
$trace --chrome 9222 --url http://localhost:3000/some/route --bp src/pages/Thing.tsx:42 \
  --record /tmp/replay.mp4 --title "What renders Thing" --step-secs 3
```

**Breakpoints** (`--bp`, repeatable): `file:line` or `file@substring`. `file` is matched to the target's
loaded scripts/source-maps by path **suffix**, so a short relative path works; resolve relative files /
substrings with `--root <dir>` (defaults to cwd). Use `--check` to verify one binds without tracing.

**Shared flags**: `--expr '<js>'` (repeatable; evaluated at every hit) · `--steps over,into,out` (step plan
at the first hit) · `--frames N` · `--max-hits N` · `--root <dir>` · `--json <path>` · `--timeout-ms N` ·
`--shot <png>` (Chrome) · `--ws <url>` / `--url-match` / `--title-match` (pick a specific target) ·
**`--record <out.mp4>`** + `--step-secs <n>` + `--title <text>` (record a debug-replay video).

## Recording (`--record`)
Each breakpoint hit becomes one **side-by-side frame** — left: the app screenshot (Chrome) or the
request/response (Node); right: the trace panel (stack · locals · watched exprs); bottom: a caption — held
`--step-secs` seconds, then all frames are assembled into an mp4. Frames are rendered as HTML in a throwaway
headless Chrome (so it needs a **Chrome binary**, `$CHROME_BIN` to override) and stitched with **ffmpeg**.
Because a breakpoint **freezes the page**, a Chrome frame shows the app *paused at that line* (often
mid-render) — the value is the synchronized app+state pairing, not a smooth playthrough.

`stdout` is the trace, `stderr` is `[trace]` progress; exit `0` ok · `1` runtime error · `2` usage error
(`--check`: `0` bound · `2` not bound).

## How it resolves `file:line`
Breakpoints are mapped to generated code via whatever **source maps the target reports**
(`scriptParsed.sourceMapURL`: `data:` inline, `file://`, http, or a `<script>.map` sibling) — so compiled
TS and bundled front-ends work without any build-layout configuration. Plain JS binds directly. A
breakpoint only binds once its script is **loaded**: for Node that's immediate; for Chrome the page is
navigated first so its modules parse, then breakpoints are set, then it reloads to trigger.

## Reading the trace
Each hit shows `#seq +elapsedMs Class.fn at file:line`, the call `stack`, merged `local`/`block` scope
variables (`•`), and any `--expr` values (`⊢`). Chrome traces also include console errors/warnings,
uncaught exceptions, failed (≥400) responses, and the final URL. "no breakpoints hit" means the line
wasn't on the path taken (wrong target/route, branch not taken, or it didn't bind).
