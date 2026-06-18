---
name: trace
description: Get a full execution trace through a running app via the `trace-cli` CLI — set breakpoints at file:line, fire a trigger (a curl for a Node `--inspect` backend, or a page navigation for a Chrome `--remote-debugging-port` target — attach to a running Chrome or let it auto-launch headless), and read back every hit with its call stack, locals, watched expressions and timing as one JSON envelope. Node/Chrome over CDP. Also `trace-cli graph` builds a static call graph / flow tree for a function or route via the Language Server Protocol (call hierarchy) — no running app needed, language-agnostic (TS/JS bundled, other languages via `--server`); and `trace-cli serve` for a realtime web UI of all traces. Use for "trace this request/route", "what runs when I hit /endpoint", "show the call graph / flow tree for this function", "what calls what / what does this call", "step through this function", "why is this value X here", "set a breakpoint and show the trace". Vendor-neutral: pass the port, the trigger, and the breakpoints — nothing is hardcoded.
allowed-tools: Bash(node:*), Bash(trace-cli:*), Read
---

# trace-cli — unified execution tracer for Node & Chrome

`trace-cli` attaches to an already-running debug target, sets breakpoints, fires a trigger, and prints the
full execution trace in one shot. One engine, one protocol driver — **CDP** for Node and Chrome. You read
the trace; you never drive the debugger by hand.

Two things beyond attaching:
- **Chrome can auto-launch.** `--chrome <port>` attaches to a browser you started (a real, logged-in session); `--chrome` with **no** port launches a throwaway headless Chrome, traces, records, and tears it down — so a frontend trace needs only the app running, not a hand-started browser.
- **`trace-cli graph` needs no running app.** It builds a static call graph — the flow tree for a function or route — by driving a language server over **LSP call hierarchy**. Use it to map what a route/function calls (and to find good breakpoint coordinates before a dynamic trace). TS/JS work out of the box; other languages via `--server <cmd>` (`gopls`, `pyright --stdio`, `rust-analyzer`, `clangd`) — the server must be installed and expose `callHierarchyProvider`.

## Invoking (do this first)
The CLI ships as a bundled binary — Claude substitutes `${CLAUDE_PLUGIN_ROOT}`. Define a shell **function**
once (works in bash **and** zsh — do **not** use a `trace=…` string variable: zsh won't word-split it, so
`$trace --help` fails with "command not found"):
```bash
trace-cli() { node "${CLAUDE_PLUGIN_ROOT}/bin/trace" "$@"; }
```
If the package is installed globally (`npm i -g trace-cli`), the bare `trace-cli` command works too — same
name either way. (It's `trace-cli`, not `trace`, to avoid colliding with macOS's `/usr/bin/trace`.)

## Let the CLI tell you how to run it — read it from the binary
This skill deliberately does **not** list commands, flags, arguments, or output fields: that knowledge is
generated from the CLI itself, so it can never drift from the installed version. Ask the binary for the
context you need — these self-describing commands are the source of truth:
```bash
trace-cli manifest          # structured JSON: every command, flag (defaults/choices/env vars) & argument — the input contract
trace-cli --help            # the list of subcommands
trace-cli <command> --help  # how to run one command, e.g. `trace-cli dynamic --help`
trace-cli schema            # the output JSON Schema every trace conforms to — the output contract
trace-cli doctor            # which backing tools are installed (node, chrome, ffmpeg, …)
```
Start with `trace-cli manifest` (to reason over the options programmatically) or `trace-cli <command> --help`
(for a quick look). Whatever you need to know about how to execute `trace-cli`, get it from there — not from
this file.
