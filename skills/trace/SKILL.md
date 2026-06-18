---
name: trace
description: Get a full execution trace through a running app via the `trace` CLI — set breakpoints at file:line, fire a trigger (a curl command for a Node `--inspect` backend, or a page navigation for a Chrome `--remote-debugging-port` target), and read back every hit with its call stack, locals, watched expressions and timing as one JSON envelope. Node/Chrome over CDP. Also `trace serve` for a realtime web UI of all traces. Use for "trace this request/route", "what runs when I hit /endpoint", "step through this function", "why is this value X here", "set a breakpoint and show the trace". Vendor-neutral: pass the port, the trigger, and the breakpoints — nothing is hardcoded.
allowed-tools: Bash(node:*), Read
---

# trace — unified execution tracer for Node & Chrome

`trace` attaches to an already-running debug target, sets breakpoints, fires a trigger, and prints the
full execution trace in one shot. One engine, one protocol driver — **CDP** for Node and Chrome. You read
the trace; you never drive the debugger by hand.

## Invoking (do this first)
Run the bundled binary by its **explicit install path** — Claude substitutes `${CLAUDE_PLUGIN_ROOT}`. Do
**not** use the bare name `trace` (it collides with macOS's `/usr/bin/trace`). Set a shorthand once:
```bash
trace="node ${CLAUDE_PLUGIN_ROOT}/bin/trace"
```

## Let the CLI tell you how to run it — read it from the binary
This skill deliberately does **not** list commands, flags, arguments, or output fields: that knowledge is
generated from the CLI itself, so it can never drift from the installed version. Ask the binary for the
context you need — these self-describing commands are the source of truth:
```bash
$trace manifest          # structured JSON: every command, flag (defaults/choices/env vars) & argument — the input contract
$trace --help            # the list of subcommands
$trace <command> --help  # how to run one command, e.g. `$trace dynamic --help`
$trace schema            # the output JSON Schema every trace conforms to — the output contract
$trace doctor            # which backing tools are installed (node, chrome, ffmpeg, …)
```
Start with `$trace manifest` (to reason over the options programmatically) or `$trace <command> --help`
(for a quick look). Whatever you need to know about how to execute `trace`, get it from there — not from
this file.
