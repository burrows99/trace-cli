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
import { renderTrace } from "./engine/render.js";
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

// emit(envelope, humanFn, o): --json writes the envelope to a file; --format json prints it to stdout,
// otherwise the human render. Keeps stdout machine- or human-readable, stderr for [trace] logs.
function emit(envelope, humanFn, o) {
  if (o.json) writeFileSync(o.json, JSON.stringify(envelope, null, 2));
  if (o.format === "json") process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
  else process.stdout.write(humanFn() + "\n");
  if (o.json) process.stderr.write(`[trace] envelope JSON → ${o.json}\n`);
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
    frames: o.frames, maxHits: o.maxHits, wsUrl: o.ws, urlMatch: o.urlMatch, titleMatch: o.titleMatch,
    record: !!o.record,
    ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
    ...(o.settleMs ? { settleMs: o.settleMs } : {}),
    args: { target, port, bp: o.bp, ...(o.curl ? { curl: o.curl } : {}), ...(o.url ? { url: o.url } : {}) },
  };

  let opts;
  if (isChrome) {
    if (!o.url) usage("chrome target needs --url");
    opts = { ...common, url: o.url, shot: o.shot };
  } else if (target === "python") {
    if (!o.curl) usage("python target needs --curl");
    opts = { ...common, curl: o.curl, reqTimeoutMs: o.reqTimeoutMs };
  } else {
    opts = { ...common, curl: o.curl, reqTimeoutMs: o.reqTimeoutMs };
  }

  const { result, envelope } = await runDynamic(opts);
  emit(envelope, () => renderTrace(result), o);

  const collector = o.emit || process.env.TRACE_COLLECTOR_URL;
  if (collector) await emitEnvelope(collector, envelope);

  if (o.record) {
    if (!isChrome) process.stderr.write("[trace] --record is Chrome-only (use --chrome --url); skipping\n");
    else try {
      const mp4 = await renderVideo(result, { out: o.record, stepSecs: o.stepSecs, title: o.title });
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
    .option("--node [port]", "Node --inspect target (default; port 9229)")
    .option("--chrome <port>", "Chrome --remote-debugging-port target", int)
    .option("--python [port]", "Python DAP/debugpy target (default port 5678)")
    .option("--host <h>", "DAP host for --python (default 127.0.0.1)")
    .option("--curl <cmd>", "trigger for node/python: a curl command run once breakpoints are set")
    .option("--url <url>", "trigger for chrome: page URL to navigate + reload")
    .option("--bp <file:line>", "breakpoint, repeatable: file:line or file@substring", collect, [])
    .option("--expr <js>", "expression evaluated at every hit, repeatable", collect, [])
    .option("--steps <list>", "step plan at the first hit (node/chrome): over,into,out")
    .option("--root <dir>", "root for resolving relative --bp files / substrings (default cwd)")
    .option("--frames <n>", "stack frames captured per hit", int, 6)
    .option("--max-hits <n>", "stop after N hits", int, 25)
    .option("--timeout-ms <n>", "per-pause wait timeout", int)
    .option("--req-timeout-ms <n>", "curl trigger timeout (node/python)", int, 60000)
    .option("--settle-ms <n>", "python: ms to wait after attach before firing (default 1200)", int)
    .option("--shot <png>", "chrome: write a screenshot to this path")
    .option("--record <mp4>", "chrome: record a side-by-side debug-replay video")
    .option("--step-secs <n>", "seconds to hold each hit in the recording", parseFloat, 3)
    .option("--title <text>", "intro/title caption for the recording")
    .option("--ws <url>", "explicit CDP WebSocket URL (node/chrome; skips discovery)")
    .option("--url-match <s>", "pick the target whose URL contains this substring")
    .option("--title-match <s>", "pick the target whose title contains this substring")
    .option("--format <fmt>", "output on stdout: human | json", "human")
    .option("--json <path>", "write the machine-readable envelope to this path")
    .option("--emit <url>", "POST the envelope to a collector (env TRACE_COLLECTOR_URL); see `trace serve`")
    .option("--check", "resolve + verify the first --bp binds, then exit (0 bound · 2 not)")
    .action(dynamicAction);

  program.command("doctor")
    .description("report which backing tools are installed (+ versions), grouped by pillar")
    .option("--format <fmt>", "output on stdout: human | json", "human")
    .option("--json <path>", "write the envelope to this path")
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
