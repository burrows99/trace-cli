// CLI root (commander). A unified `trace` orchestration shell: each subcommand invokes the right backing
// engine/tool and emits ONE JSON envelope (src/schema). Subcommands:
//   dynamic  — breakpoints + a trigger → a full execution trace (Node CDP · Chrome CDP · Python DAP)
//   doctor   — report which backing tools are installed
//   schema   — print the output JSON Schema (the contract)
// Hard-cut from the old flat `trace --port …` interface; that is now `trace dynamic --node …`.
// Exit: 0 ok · 1 runtime · 2 usage · 3 backing tool missing.

import { Command, CommanderError } from "commander";
import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { runDynamic } from "./commands/dynamic.js";
import { runDoctor, renderDoctor } from "./commands/doctor.js";
import { runServe, emitEnvelope } from "./commands/serve.js";
import { checkBreakpoint, checkPython } from "./engine/trace.js";
import { parseBpSpec } from "./engine/breakpoints.js";
import { renderTrace, renderLineage } from "./engine/render.js";
import { renderVideo } from "./engine/record.js";
import { VERSION } from "./schema/envelope.js";

const here = dirname(fileURLToPath(import.meta.url));
const int = (v) => parseInt(v, 10);
const collect = (v, acc) => { acc.push(v); return acc; };
const usage = (msg) => { process.stderr.write(`trace: ${msg}\n`); process.exit(2); };

// pickTarget(o) → { target, port }. --chrome and --python are explicit; default is node @9229.
function pickTarget(o) {
  if (o.chrome != null) return { target: "chrome", port: o.chrome };
  if (o.python !== undefined) return { target: "python", port: o.python === true ? 5678 : int(o.python) };
  return { target: "node", port: o.node === undefined || o.node === true ? 9229 : int(o.node) };
}

// emit(envelope, humanFn, o): output policy via one flag. `--json <path>` writes the envelope to a file
// (stdout stays human); bare `--json` prints the envelope to stdout instead of the human render; no flag =
// human. stderr carries [trace] logs.
function emit(envelope, humanFn, o) {
  const toFile = typeof o.json === "string";
  if (toFile) writeFileSync(o.json, JSON.stringify(envelope, null, 2));
  process.stdout.write((o.json === true ? JSON.stringify(envelope, null, 2) : humanFn()) + "\n");
  if (toFile) process.stderr.write(`[trace] envelope JSON → ${o.json}\n`);
}

async function dynamicAction(o) {
  const { target, port } = pickTarget(o);
  const isChrome = target === "chrome";

  if (o.check) {
    if (!o.bp.length) usage("--check needs a --bp");
    const { file, lineSpec } = parseBpSpec(o.bp[0]);
    const r = target === "python"
      ? await checkPython({ host: o.host, port, file, lineSpec, root: o.root })
      : await checkBreakpoint({ kind: target, port, wsUrl: o.ws, url: o.url, file, lineSpec, root: o.root });
    process.stdout.write(`${r.file}:${r.line} → ${r.bound ? "BOUND ✅" : "not bound ⚠"}${r.mapped ? " (mapped)" : ""}${r.scriptUrl ? "  " + r.scriptUrl : ""}\n`);
    process.exit(r.bound ? 0 : 2);
  }

  if (!o.bp.length) usage("dynamic needs at least one --bp (file:line or file@substring)");

  const common = {
    target, port, host: o.host,
    breakpoints: o.bp, root: o.root, exprs: o.expr,
    steps: (o.steps || "").split(",").map((s) => s.trim()).filter(Boolean),
    frames: o.frames, maxHits: o.maxHits, wsUrl: o.ws, record: !!o.record,
    ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
    args: { target, port, bp: o.bp, ...(o.curl ? { curl: o.curl } : {}), ...(o.url ? { url: o.url } : {}) },
  };

  let opts;
  if (isChrome) {
    if (!o.url) usage("chrome target needs --url");
    opts = { ...common, url: o.url, shot: o.shot };
  } else {
    if (!o.curl) usage(`${target} target needs --curl`);
    opts = { ...common, curl: o.curl };
  }

  const { result, envelope } = await runDynamic(opts);
  emit(envelope, () => renderTrace(result) + renderLineage(envelope.data.lineage), o);

  const collector = o.emit || process.env.TRACE_COLLECTOR_URL;
  if (collector) await emitEnvelope(collector, envelope);

  if (o.record) {
    if (!isChrome) process.stderr.write("[trace] --record is Chrome-only (use --chrome --url); skipping\n");
    else try {
      const mp4 = await renderVideo(result, { out: o.record });
      process.stderr.write(mp4 ? `[trace] recording → ${mp4}\n` : `[trace] no hits — nothing to record\n`);
    } catch (e) { process.stderr.write(`[trace] recording failed: ${e.message}\n`); }
  }
  process.exit(result.fatal ? 1 : 0);
}

function buildProgram() {
  const program = new Command()
    .name("trace")
    .description("Unified execution tracer & analyzer — one JSON envelope across breakpoints, spans, and static analysis.")
    .version(VERSION)
    .showHelpAfterError("(add --help for usage)");

  program.command("dynamic")
    .description("breakpoints + a trigger → a full execution trace (Node CDP · Chrome CDP · Python DAP)")
    // target (one of)
    .option("--node [port]", "Node --inspect target (default; port 9229)")
    .option("--chrome <port>", "Chrome --remote-debugging-port target", int)
    .option("--python [port]", "Python DAP/debugpy target (default port 5678)")
    .option("--host <h>", "DAP host for --python (default 127.0.0.1)")
    // what + when
    .option("--bp <file:line>", "breakpoint, repeatable: file:line or file@substring", collect, [])
    .option("--expr <js>", "expression evaluated at every hit, repeatable", collect, [])
    .option("--curl <cmd>", "trigger for node/python: a command run once breakpoints are set")
    .option("--url <url>", "trigger for chrome: page URL to navigate + reload")
    .option("--root <dir>", "root for resolving relative --bp files (default cwd)")
    // capture tuning (sane defaults — set only when needed)
    .option("--max-hits <n>", "stop after N hits", int, 25)
    .option("--frames <n>", "stack frames captured per hit", int, 6)
    .option("--steps <list>", "step plan at the first hit (node/chrome): over,into,out")
    .option("--timeout-ms <n>", "per-pause wait timeout", int)
    // output
    .option("--json [path]", "envelope as JSON: to a file if a path is given, else to stdout")
    .option("--emit <url>", "POST the envelope to a collector (env TRACE_COLLECTOR_URL); see `trace serve`")
    // chrome extras + escape hatches
    .option("--shot <png>", "chrome: write a screenshot to this path")
    .option("--record <mp4>", "chrome: record a side-by-side debug-replay video")
    .option("--ws <url>", "explicit CDP WebSocket URL (node/chrome; skips target discovery)")
    .option("--check", "resolve + verify the first --bp binds, then exit (0 bound · 2 not)")
    .action(dynamicAction);

  program.command("doctor")
    .description("report which backing tools are installed (+ versions), grouped by pillar")
    .option("--json [path]", "envelope as JSON: to a file if a path is given, else to stdout")
    .action(async (o) => {
      const envelope = await runDoctor({});
      emit(envelope, () => renderDoctor(envelope), o);
      process.exit(envelope.ok ? 0 : 0);   // doctor is informational; missing tools are warnings, not failures
    });

  program.command("serve")
    .description("collector + realtime UI: ingest envelopes (POST /v1/traces) and show all traces live")
    .option("--port <n>", "port to listen on", int, 4000)
    .option("--host <h>", "host to bind (default 0.0.0.0)")
    .option("--data <dir>", "directory to persist sessions (env TRACE_DATA, default .trace-data)")
    .action((o) => {
      runServe({ port: o.port, ...(o.host ? { host: o.host } : {}), ...(o.data ? { dataDir: o.data } : {}) });
      // the listening server keeps the process alive — no process.exit here.
    });

  program.command("schema")
    .description("print the output JSON Schema (the contract every subcommand conforms to)")
    .action(() => {
      process.stdout.write(readFileSync(join(here, "schema/trace.schema.json"), "utf8"));
      process.exit(0);
    });

  return program;
}

export async function run(argv = process.argv) {
  const program = buildProgram().exitOverride();
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      if (["commander.help", "commander.helpDisplayed", "commander.version"].includes(err.code)) process.exit(0);
      process.exit(2);
    }
    process.stderr.write(`trace: ${err?.message || err}\n`);
    process.exit(1);
  }
}
