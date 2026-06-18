import { Command, CommanderError } from "commander";
import { writeFileSync } from "node:fs";

import { DynamicCommand, type DynamicTargetKind } from "./commands/DynamicCommand.js";
import { GraphCommand } from "./commands/GraphCommand.js";
import { DoctorCommand } from "./commands/DoctorCommand.js";
import { ExportSkillCommand } from "./commands/ExportSkillCommand.js";
import { ManifestCommand } from "./commands/ManifestCommand.js";
import { SchemaCommand } from "./commands/SchemaCommand.js";
import { ServeCommand } from "./commands/ServeCommand.js";
import { Tracer } from "../engine/Tracer.js";
import { Collector } from "../collector/Collector.js";
import { S3ArtifactStore } from "../storage/S3ArtifactStore.js";
import { VERSION } from "../shared/version.js";
import { TargetKind } from "../domain/Target.js";
import { Diagnostic } from "../domain/Diagnostic.js";
import { DEFAULT_NODE_PORT, DEFAULT_COLLECTOR_PORT } from "../shared/defaults.js";
import { DynamicInput, GraphInput } from "./CommandInputs.js";
import { EntryRef } from "../codegraph/CodeGraphProvider.js";
import { logger } from "../shared/logger.js";
import type { Trace } from "../domain/Trace.js";

const log = logger.child({ component: "cli" });
const int = (v: string) => parseInt(v, 10);
const collect = (v: string, acc: string[]) => { acc.push(v); return acc; };
const usage = (msg: string): never => { process.stderr.write(`trace: ${msg}\n`); process.exit(2); };

function pickTarget(o: any): { target: DynamicTargetKind; port: number; launch: boolean } {
  if (o.chrome != null) {
    const launch = o.chrome === true; // bare `--chrome` (no port) → launch a throwaway headless Chrome
    return { target: TargetKind.Chrome, port: launch ? 0 : int(o.chrome), launch };
  }
  return { target: TargetKind.Node, port: o.node === undefined || o.node === true ? DEFAULT_NODE_PORT : int(o.node), launch: false };
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
    const { target, port, launch } = pickTarget(o);
    const isChrome = target === TargetKind.Chrome;
    if (!o.bp.length) usage("dynamic needs at least one --bp (file:line or file@substring)");
    // Chrome trigger = an ordered UI journey; --url is shorthand for a leading `goto:`. Node trigger = a curl.
    const steps: string[] = isChrome ? [...(o.url ? [`goto:${o.url}`] : []), ...o.step] : [];
    if (isChrome && !steps.length) usage("chrome target needs --url or at least one --step");
    if (!isChrome && o.step.length) usage("--step is a chrome-only trigger (node uses --curl)");
    if (!isChrome && !o.curl) usage(`${target} target needs --curl`);

    const input = new DynamicInput({ target, port, launch, breakpoints: o.bp, exprs: o.expr, steps, curl: o.curl });
    const badInput = input.validate();
    if (badInput.length) usage(`invalid input — ${badInput.join("; ")}`);

    // Redact secrets before they reach the envelope's meta.args: a `type:` step carries typed text (passwords),
    // an `eval:` step an arbitrary script body.
    const safeStep = (s: string) => s.startsWith("type:") ? s.replace(/=.*/s, "=***") : s.startsWith("eval:") ? "eval:***" : s;

    const { trace } = await this.#dynamic.run({
      target, port, launch,
      breakpoints: o.bp, exprs: o.expr,
      steps, curl: o.curl,
      recordOut: o.out,
      args: { target, ...(launch ? { launch: true } : { port }), bp: o.bp, ...(steps.length ? { steps: steps.map(safeStep) } : {}), ...(o.curl ? { curl: o.curl } : {}) },
    });

    emit(trace, () => this.#dynamic.render(trace), o);
    const collector = process.env.TRACE_COLLECTOR_URL;
    if (collector) await Collector.emit(collector, trace.toJSON());
    process.exit(trace.hasErrors() ? 1 : 0);
  }

  async #runGraph(o: any): Promise<void> {
    const entry = EntryRef.parse(o.entry);
    const input = new GraphInput({ file: entry.file, line: entry.line, col: entry.col, symbol: entry.symbol, depth: o.depth });
    const badInput = input.validate();
    if (badInput.length) usage(`invalid input — ${badInput.join("; ")}`);

    const cmd = new GraphCommand();
    const trace = await cmd.run({
      entry,
      root: o.root, // optional — GraphCommand auto-detects the project root from the entry when absent
      maxDepth: o.depth,
      server: o.server,
      args: { entry: o.entry, ...(o.root ? { root: o.root } : {}), ...(o.server ? { server: o.server } : {}), depth: o.depth },
    });

    emit(trace, () => cmd.render(trace), o);
    const collector = process.env.TRACE_COLLECTOR_URL;
    if (collector) await Collector.emit(collector, trace.toJSON());
    process.exit(trace.hasErrors() ? 1 : 0);
  }

  build(): Command {
    const program = new Command()
      .name("trace-cli")
      .description("Unified, class-first execution tracer & analyzer — one Trace envelope across breakpoints + analysis.")
      .version(VERSION)
      .showHelpAfterError("(add --help for usage)");

    program.command("dynamic")
      .description("breakpoints + a trigger → a full execution trace. Node (CDP): a --curl trigger. Chrome (CDP): a scripted UI journey (--url/--step) recorded as a screen + trace-panel replay — debug and video together.")
      .option("--node [port]", `Node --inspect target (default; port ${DEFAULT_NODE_PORT})`)
      .option("--chrome [port]", "Chrome target: a running browser's --remote-debugging-port, or omit the port to launch a throwaway headless Chrome")
      .option("--bp <file:line>", "breakpoint, repeatable: file:line or file@substring", collect, [])
      .option("--expr <js>", "expression evaluated at every hit, repeatable", collect, [])
      .option("--curl <cmd>", "trigger for node: a command run once breakpoints are set")
      .option("--url <url>", "chrome trigger shorthand: a page URL to navigate (equivalent to --step goto:<url>)")
      .option("--step <s>", "chrome journey step, repeatable & ordered: goto:<url> · click:<sel> · type:<sel>=<text> · waitfor:<sel> · wait:<ms> · newtab · eval:<js>  (sel: CSS or text=…)", collect, [])
      .option("--out <mp4>", "chrome: output path for the screen + trace-panel recording (default: a temp file)")
      .option("--json [path]", "envelope as JSON: to a file if a path is given, else to stdout")
      .action((o) => this.#runDynamic(o));

    program.command("graph")
      .description("call graph rooted at an entry → the flow tree for a function/route, via LSP call hierarchy")
      .requiredOption("--entry <ref>", "where to start: file:line, file:line:col, or file@symbol (e.g. src/auth.service.ts:42:9 or src/auth.service.ts@exchangeToken)")
      .option("--root <dir>", "project root / LSP workspace (default: auto — nearest tsconfig/package.json/.git above the entry)")
      .option("--server <cmd>", "override the LSP server (default: auto by file extension; bundled typescript-language-server for TS/JS, e.g. \"gopls\", \"pyright --stdio\")")
      .option("--depth <n>", "max call depth expanded from the entry", int, 6)
      .option("--json [path]", "envelope as JSON: to a file if a path is given, else to stdout")
      .action((o) => this.#runGraph(o));

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
