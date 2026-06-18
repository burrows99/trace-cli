import { Command, CommanderError } from "commander";
import { writeFileSync } from "node:fs";

import { DynamicCommand, type DynamicTargetKind } from "./commands/DynamicCommand.js";
import { JourneyCommand } from "./commands/JourneyCommand.js";
import { DoctorCommand } from "./commands/DoctorCommand.js";
import { ExportSkillCommand } from "./commands/ExportSkillCommand.js";
import { ManifestCommand } from "./commands/ManifestCommand.js";
import { SchemaCommand } from "./commands/SchemaCommand.js";
import { ServeCommand } from "./commands/ServeCommand.js";
import { Renderer } from "../engine/Renderer.js";
import { Tracer } from "../engine/Tracer.js";
import { Collector } from "../collector/Collector.js";
import { S3ArtifactStore } from "../storage/S3ArtifactStore.js";
import { VERSION } from "../shared/version.js";
import { TargetKind } from "../domain/Target.js";
import { Diagnostic } from "../domain/Diagnostic.js";
import { DEFAULT_NODE_PORT, DEFAULT_COLLECTOR_PORT } from "../shared/defaults.js";
import { DynamicInput, JourneyInput } from "./CommandInputs.js";
import { logger } from "../shared/logger.js";
import type { Trace } from "../domain/Trace.js";

const log = logger.child({ component: "cli" });
const int = (v: string) => parseInt(v, 10);
const collect = (v: string, acc: string[]) => { acc.push(v); return acc; };
const usage = (msg: string): never => { process.stderr.write(`trace: ${msg}\n`); process.exit(2); };

function pickTarget(o: any): { target: DynamicTargetKind; port: number } {
  if (o.chrome != null) return { target: TargetKind.Chrome, port: o.chrome };
  return { target: TargetKind.Node, port: o.node === undefined || o.node === true ? DEFAULT_NODE_PORT : int(o.node) };
}

/** emit policy: bare --json → JSON to stdout; --json <path> → file (stdout stays human); else human. */
function emit(trace: Trace, humanFn: () => string, o: any): void {
  // Enforce the envelope contract before it leaves the process: structural violations become error
  // diagnostics (and flip `ok`/exit code) instead of shipping a silently-malformed Trace.
  for (const problem of trace.validate()) trace.diagnostics.push(Diagnostic.error("E_SCHEMA", problem));
  trace.ok = !trace.hasErrors();
  const json = trace.toJSON();
  const toFile = typeof o.json === "string";
  if (toFile) writeFileSync(o.json, JSON.stringify(json, null, 2));
  process.stdout.write((o.json === true ? JSON.stringify(json, null, 2) : humanFn()) + "\n");
  if (toFile) log.info("envelope written", { path: o.json });
}

/**
 * Cli — the commander shell. Thin: it maps flags onto command objects (DynamicCommand/DoctorCommand/…),
 * which own the use-cases. Output (stdout/--json/--emit) and exit codes live here.
 */
export class Cli {
  #dynamic = new DynamicCommand(new Tracer(), new S3ArtifactStore());

  async #runDynamic(o: any): Promise<void> {
    const { target, port } = pickTarget(o);
    const isChrome = target === TargetKind.Chrome;
    if (!o.bp.length) usage("dynamic needs at least one --bp (file:line or file@substring)");
    if (isChrome && !o.url) usage("chrome target needs --url");
    if (!isChrome && !o.curl) usage(`${target} target needs --curl`);

    const input = new DynamicInput({ target, port, breakpoints: o.bp, exprs: o.expr, curl: o.curl, url: o.url });
    const badInput = input.validate();
    if (badInput.length) usage(`invalid input — ${badInput.join("; ")}`);

    const { trace } = await this.#dynamic.run({
      target, port,
      breakpoints: o.bp, exprs: o.expr,
      curl: o.curl, url: o.url,
      record: isChrome, // Chrome always records the debug-replay video (uploads to S3 if S3_ENDPOINT is set)
      args: { target, port, bp: o.bp, ...(o.curl ? { curl: o.curl } : {}), ...(o.url ? { url: o.url } : {}) },
    });

    emit(trace, () => Renderer.render(trace) + Renderer.renderLineage(trace.data.lineage), o);
    const collector = process.env.TRACE_COLLECTOR_URL;
    if (collector) await Collector.emit(collector, trace.toJSON());
    process.exit(trace.hasErrors() ? 1 : 0);
  }

  async #runJourney(o: any): Promise<void> {
    if (!o.step.length) usage("journey needs at least one --step (e.g. --step goto:http://… --step click:text=Impersonate)");
    const steps = (o.step as string[]).map((s) => JourneyCommand.parseStep(s));

    const input = new JourneyInput({ port: o.chrome, steps, out: o.out });
    const badInput = input.validate();
    if (badInput.length) usage(`invalid input — ${badInput.join("; ")}`);

    const cmd = new JourneyCommand();
    const result = await cmd.run({ port: o.chrome, steps, out: o.out });
    const problems = result.validate();
    if (problems.length) log.error("journey produced an invalid result", { problems });
    if (o.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    else process.stdout.write(cmd.render(result) + "\n");
    process.exit(result.ok && problems.length === 0 ? 0 : 1);
  }

  build(): Command {
    const program = new Command()
      .name("trace-cli")
      .description("Unified, class-first execution tracer & analyzer — one Trace envelope across breakpoints + analysis.")
      .version(VERSION)
      .showHelpAfterError("(add --help for usage)");

    program.command("dynamic")
      .description("breakpoints + a trigger → a full execution trace (Node CDP · Chrome CDP)")
      .option("--node [port]", `Node --inspect target (default; port ${DEFAULT_NODE_PORT})`)
      .option("--chrome <port>", "Chrome --remote-debugging-port target", int)
      .option("--bp <file:line>", "breakpoint, repeatable: file:line or file@substring", collect, [])
      .option("--expr <js>", "expression evaluated at every hit, repeatable", collect, [])
      .option("--curl <cmd>", "trigger for node: a command run once breakpoints are set")
      .option("--url <url>", "trigger for chrome: page URL to navigate (breakpoints bind before the first run)")
      .option("--json [path]", "envelope as JSON: to a file if a path is given, else to stdout")
      .action((o) => this.#runDynamic(o));

    program.command("journey")
      .description("drive a scripted UI journey across tabs and record it as one motion screencast (Chrome via CDP)")
      .requiredOption("--chrome <port>", "Chrome --remote-debugging-port target", int)
      .option("--step <s>", "journey step, repeatable & ordered: goto:<url> · click:<sel> · type:<sel>=<text> · waitfor:<sel> · wait:<ms> · newtab · eval:<js>  (sel: CSS or text=…)", collect, [])
      .option("--out <mp4>", "output video path (default: a temp file)")
      .option("--json", "print the journey result as JSON instead of a human summary")
      .action((o) => this.#runJourney(o));

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
      .option("--port <n>", "port to listen on", int, DEFAULT_COLLECTOR_PORT)
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

    program.command("export-skill")
      .description("copy the bundled `trace` skill into a project's .claude/skills/ so Claude Code picks it up")
      .argument("[dir]", "target project root (default: current directory)")
      .option("--force", "overwrite an existing .claude/skills/trace")
      .action((dir, o) => {
        try {
          const { src, dest } = new ExportSkillCommand().run({ dir, force: o.force });
          process.stdout.write(`[trace] skill exported → ${dest}\n`);
          log.info("skill exported", { src, dest });
          process.exit(0);
        } catch (e: any) {
          process.stderr.write(`trace: ${e.message}\n`);
          process.exit(1);
        }
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
