# trace-cli

A **general-purpose execution tracer over the [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) (CDP)**.
Point it at a running debug target, give it a list of **breakpoint locations** and a **trigger**, and it
prints a full **execution trace** — every breakpoint hit in order, with the call stack, local variables,
watched expressions, and timing. The agent (or you) reads the trace; nothing has to drive a debugger by hand.

Two targets, one engine:

- **Node** — attach to a Node `--inspect` port; the trigger is a **curl command** you provide.
- **Chrome** — attach to a Chrome `--remote-debugging-port`; the trigger is navigating/reloading a page URL.

It is **not coupled to any project**: target ports, the trigger, breakpoint files, and the source root all
come from flags. Source locations (`file:line`) are resolved through whatever source maps the target
reports — no build-layout assumptions. Runs on plain Node (built-in `WebSocket`/`fetch`, Node ≥ 18).

## Usage

```bash
# Node target: set breakpoints, fire a curl, trace the request
trace --port 9229 \
  --curl 'curl -s http://localhost:3002/v1/dashboard -H "Cookie: sid=…"' \
  --bp src/dashboard/dashboard.service.ts:149 \
  --bp src/semble/semble.service.ts:fetchResponsibleClinician   # line number OR a unique substring

# Chrome target: set breakpoints, navigate/reload a route, trace the render
trace --chrome 9222 --url http://localhost:3000/some/route \
  --bp src/pages/Thing.tsx:42
```

Shared flags: `--expr '<js>'` (repeatable; evaluated at every hit) · `--steps over,into,out` (step plan at
the first hit) · `--frames N` · `--max-hits N` · `--root <dir>` (resolve relative `--bp` files) ·
`--json <path>` (write the machine-readable trace) · `--timeout-ms N` · `--shot <png>` (Chrome screenshot) ·
`--check` (resolve + verify a breakpoint binds, then exit). `stdout` is the trace, `stderr` is `[trace]`
logs; exit `0` ok · `1` runtime error · `2` usage error.

## As a library

```js
import { traceNode, traceChrome } from "trace-cli";

const result = await traceNode({
  port: 9229,
  curl: 'curl -s http://localhost:3002/v1/dashboard',
  breakpoints: ["src/dashboard/dashboard.service.ts:149"],
  root: "/path/to/project",
});
// result.hits[], result.breakpoints[], result.response …
```

## As a Claude Code plugin

This repo is also a [Claude Code plugin](https://code.claude.com/docs/en/plugins): installing it puts
`trace` on the Bash tool's PATH and loads a usage skill.

```bash
claude plugin marketplace add /path/to/trace-cli
claude plugin install trace@trace-oss
```

## How it works

1. Connect to the target's CDP WebSocket (`/json/list` for Node, `/json` for Chrome).
2. Resolve each `file:line` to a generated location via the target's source maps (`scriptParsed.sourceMapURL`,
   handling `data:`/`file://`/http maps, or a `<script>.map` sibling); plain JS binds directly.
3. Set the breakpoints, fire the trigger (run the curl / navigate+reload), and capture every pause:
   call stack, merged local/block scopes, watched expressions, elapsed ms.
4. Resume through to completion and print the trace (`--json` also writes it).

## License

MIT — see [LICENSE](LICENSE).
