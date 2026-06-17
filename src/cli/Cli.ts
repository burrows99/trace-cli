import { Command, CommanderError } from "commander";
import { writeFileSync } from "node:fs";

import { DynamicCommand, type DynamicTargetKind } from "./commands/DynamicCommand.js";
import { DoctorCommand } from "./commands/DoctorCommand.js";
import { ManifestCommand } from "./commands/ManifestCommand.js";
import { SchemaCommand } from "./commands/SchemaCommand.js";
import { ServeCommand } from "./commands/ServeCommand.js";
import { Renderer } from "../engine/Renderer.js";
import { Tracer } from "../engine/Tracer.js";
import { Collector } from "../collector/Collector.js";
import { S3ArtifactStore } from "../storage/S3ArtifactStore.js";
import { VERSION } from "../shared/version.js";
import type { Trace } from "../domain/Trace.js";

const int = (v: string) => parseInt(v, 10);
const collect = (v: string, acc: string[]) => { acc.push(v); return acc; };
const usage = (msg: string): never => { process.stderr.write(`trace: ${msg}\n`); process.exit(2); };

function pickTarget(o: any): { target: DynamicTargetKind; port: number } {
  if (o.chrome != null) return { target: "chrome", port: o.chrome };
  if (o.python !== undefined) return { target: "python", port: o.python === true ? 5678 : int(o.python) };
  return { target: "node", port: o.node === undefined || o.node === true ? 9229 : int(o.node) };
}

/** emit policy: bare --json → JSON to stdout; --json <path> → file (stdout stays human); else human. */
function emit(trace: Trace, humanFn: () => string, o: any): void {
  const json = trace.toJSON();
  const toFile = typeof o.json === "string";
  if (toFile) writeFileSync(o.json, JSON.stringify(json, null, 2));
  process.stdout.write((o.json === true ? JSON.stringify(json, null, 2) : humanFn()) + "\n");
  if (toFile) process.stderr.write(`[trace] envelope JSON → ${o.json}\n`);
}

/**
 * Cli — the commander shell. Thin: it maps flags onto command objects (DynamicCommand/DoctorCommand/…),
 * which own the use-cases. Output (stdout/--json/--emit) and exit codes live here.
 */
export class Cli {
  #dynamic = new DynamicCommand(new Tracer(), new S3ArtifactStore());

  async #runDynamic(o: any): Promise<void> {
    const { target, port } = pickTarget(o);
    const isChrome = target === "chrome";
    if (!o.bp.length) usage("dynamic needs at least one --bp (file:line or file@substring)");
    if (isChrome && !o.url) usage("chrome target needs --url");
    if (!isChrome && !o.curl) usage(`${target} target needs --curl`);

    const { trace } = await this.#dynamic.run({
      target, port, host: o.host,
      breakpoints: o.bp, root: o.root, exprs: o.expr,
      steps: (o.steps || "").split(",").map((s: string) => s.trim()).filter(Boolean),
      frames: o.frames, maxHits: o.maxHits, wsUrl: o.ws,
      ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
      curl: o.curl, url: o.url, shot: o.shot,
      record: isChrome && o.record !== false,
      recordOut: typeof o.record === "string" ? o.record : undefined,
      args: { target, port, bp: o.bp, ...(o.curl ? { curl: o.curl } : {}), ...(o.url ? { url: o.url } : {}) },
    });

    emit(trace, () => Renderer.render(trace) + Renderer.renderLineage(trace.data.lineage), o);
    const collector = o.emit || process.env.TRACE_COLLECTOR_URL;
    if (collector) await Collector.emit(collector, trace.toJSON());
    process.exit(trace.hasErrors() ? 1 : 0);
  }

  build(): Command {
    const program = new Command()
      .name("trace")
      .description("Unified, class-first execution tracer & analyzer — one Trace envelope across breakpoints + analysis.")
      .version(VERSION)
      .showHelpAfterError("(add --help for usage)");

    program.command("dynamic")
      .description("breakpoints + a trigger → a full execution trace (Node CDP · Chrome CDP · Python DAP)")
      .option("--node [port]", "Node --inspect target (default; port 9229)")
      .option("--chrome <port>", "Chrome --remote-debugging-port target", int)
      .option("--python [port]", "Python DAP/debugpy target (default port 5678)")
      .option("--host <h>", "DAP host for --python (default 127.0.0.1)")
      .option("--bp <file:line>", "breakpoint, repeatable: file:line or file@substring", collect, [])
      .option("--expr <js>", "expression evaluated at every hit, repeatable", collect, [])
      .option("--curl <cmd>", "trigger for node/python: a command run once breakpoints are set")
      .option("--url <url>", "trigger for chrome: page URL to navigate + reload")
      .option("--root <dir>", "root for resolving relative --bp files (default cwd)")
      .option("--max-hits <n>", "stop after N hits", int, 25)
      .option("--frames <n>", "stack frames captured per hit", int, 6)
      .option("--steps <list>", "step plan at the first hit (node/chrome): over,into,out")
      .option("--timeout-ms <n>", "per-pause wait timeout", int)
      .option("--json [path]", "envelope as JSON: to a file if a path is given, else to stdout")
      .option("--emit <url>", "POST the envelope to a collector (env TRACE_COLLECTOR_URL); see `trace serve`")
      .option("--shot <png>", "chrome: write a screenshot to this path")
      .option("--record [path]", "chrome: record a debug-replay video (ON by default; uploads to S3 if S3_ENDPOINT set)")
      .option("--no-record", "chrome: skip the default video recording")
      .option("--ws <url>", "explicit CDP WebSocket URL (node/chrome; skips target discovery)")
      .action((o) => this.#runDynamic(o));

    program.command("doctor")
      .description("report which backing tools are installed (+ versions), grouped by pillar")
      .option("--json [path]", "envelope as JSON: to a file if a path is given, else to stdout")
      .action(async (o) => {
        const cmd = new DoctorCommand();
        const trace = await cmd.run();
        emit(trace, () => cmd.render(trace), o);
        process.exit(0);
      });

    program.command("serve")
      .description("collector + realtime UI: ingest envelopes (POST /v1/traces) and show all traces live")
      .option("--port <n>", "port to listen on", int, 4000)
      .option("--host <h>", "host to bind (default 0.0.0.0)")
      .option("--db <url>", "Postgres connection string to persist sessions (env DATABASE_URL/POSTGRES_URL)")
      .action((o) => new ServeCommand().run({ port: o.port, host: o.host, databaseUrl: o.db }));

    program.command("schema")
      .description("print the output JSON Schema (the contract every Trace conforms to)")
      .action(() => { process.stdout.write(new SchemaCommand().run()); process.exit(0); });

    program.command("manifest")
      .description("print a self-describing JSON of every command, flag & argument, generated from the parser (the input contract; `schema` is the output contract)")
      .action(() => {
        process.stdout.write(JSON.stringify(new ManifestCommand().run(program), null, 2) + "\n");
        process.exit(0);
      });

    return program;
  }

  async run(argv: string[] = process.argv): Promise<void> {
    const program = this.build().exitOverride();
    try {
      await program.parseAsync(argv);
    } catch (err: any) {
      if (err instanceof CommanderError) {
        if (["commander.help", "commander.helpDisplayed", "commander.version"].includes(err.code)) process.exit(0);
        process.exit(2);
      }
      process.stderr.write(`trace: ${err?.message || err}\n`);
      process.exit(1);
    }
  }
}
