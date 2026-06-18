---
name: trace
description: Gets a full execution trace through a running app via the `trace-cli` CLI — sets breakpoints at file:line, fires a trigger (a curl for a Node `--inspect` backend, or a scripted UI journey of ordered steps for a Chrome `--remote-debugging-port` target, attached or auto-launched headless), and reads back every hit with its call stack, locals, watched expressions and timing as one JSON envelope; a Chrome run also records a screen + trace-panel video. Node/Chrome over CDP. Also `trace-cli graph`/`deps`/`complexity`/`symbols` run static analysis with no running app — call graph (LSP call hierarchy), module deps, complexity, symbols. Use for: trace this request/route, what runs when I hit /endpoint, record this UI flow, show the call graph / what calls what, module or circular dependencies, cyclomatic complexity, symbol outline of a file, step through a function, why is this value X here, set a breakpoint and show the trace. Vendor-neutral: pass the port, trigger and breakpoints — nothing is hardcoded.
allowed-tools: Bash(node:*), Bash(trace-cli:*), Read
---

# trace-cli — unified execution tracer for Node & Chrome

- Attaches to a running debug target, sets breakpoints, fires a trigger, prints the full execution trace in one shot. One engine, one protocol driver — **CDP** for Node and Chrome. You read the trace; you never drive the debugger by hand.
- **Chrome can auto-launch:** `--chrome <port>` attaches to a browser you started (a real, logged-in session); bare `--chrome` (no port) launches a throwaway headless Chrome, traces, records, and tears it down — a frontend trace needs only the app running.
- **Static analysis needs no running app:** `trace-cli graph` is a call graph (flow tree) via **LSP call hierarchy** — map what a route/function calls, and find breakpoint coordinates before a runtime trace. TS/JS bundled; other languages via `--server` (`gopls` · `pyright --stdio` · `rust-analyzer` · `clangd`, must expose `callHierarchyProvider`). The other analyses are `deps`/`complexity`/`symbols` — run `trace-cli --help`.

## Invoking (do this first)

- The CLI ships as a bundled binary; Claude substitutes `${CLAUDE_PLUGIN_ROOT}`. Define a shell **function** once (works in bash **and** zsh):

```bash
trace-cli() { node "${CLAUDE_PLUGIN_ROOT}/bin/trace" "$@"; }
```

- Do **not** use a `trace=…` string variable — zsh won't word-split it, so `$trace --help` fails with "command not found".
- Installed globally (`npm i -g trace-cli`)? The bare `trace-cli` works too. (It's `trace-cli`, not `trace`, to avoid colliding with macOS's `/usr/bin/trace`.)

## Let the CLI tell you how to run it — read it from the binary

- This skill deliberately does **not** list commands, flags, arguments, or output fields — that knowledge is generated from the CLI itself, so it can never drift from the installed version. These self-describing commands are the source of truth:

```bash
trace-cli manifest          # structured JSON: every command, flag (defaults/choices/env vars) & argument — the input contract
trace-cli --help            # the list of subcommands
trace-cli <command> --help  # how to run one command, e.g. `trace-cli run --help`
trace-cli schema            # the output JSON Schema every trace conforms to — the output contract
trace-cli doctor            # which backing tools are installed (node, chrome, ffmpeg, …)
```

- Start with `trace-cli manifest` (to reason over the options programmatically) or `trace-cli <command> --help` (for a quick look). Whatever you need to know about executing `trace-cli`, get it from there — not from this file.
