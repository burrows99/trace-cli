import { Command, CommanderError } from "commander";
import { writeFileSync } from "node:fs";

import { ManifestCommand } from "./commands/ManifestCommand.js";
import { SchemaCommand } from "./commands/SchemaCommand.js";
import { ServeCommand } from "./commands/ServeCommand.js";
import { ExportSkillCommand } from "./commands/ExportSkillCommand.js";
import { InputManager } from "../io/InputManager.js";
import { InputError } from "../io/InputError.js";
import { ProcessingManager, EngineAbortError } from "../io/ProcessingManager.js";
import { OutputManager } from "../io/OutputManager.js";
import type { ProcessingResult, OutputResult } from "../io/descriptors.js";
import { VERSION } from "../shared/version.js";
import { DEFAULT_NODE_PORT, DEFAULT_COLLECTOR_PORT } from "../shared/defaults.js";
import { logger } from "../shared/logger.js";

// The output-policy helpers live in the IO tier now; re-export them from here so the long-standing import point
// (`trace-cli/dist/cli/Cli.js`, used by the output tests) keeps resolving.
export { condense } from "../io/OutputManager.js";
export { emitFailureMessage } from "../io/ProcessingManager.js";

const log = logger.child({ component: "cli" });
const parseIntArg = (value: string) => parseInt(value, 10);
const collect = (value: string, accumulator: string[]) => { accumulator.push(value); return accumulator; };
const usage = (message: string): never => { process.stderr.write(`trace-cli: ${message}\n`); process.exit(2); };

/**
 * Cli — the commander shell. Thin: it maps flags onto the IO tier (InputManager → ProcessingManager →
 * OutputManager) and owns only the things a terminal frontend owns — stderr/exit-2 on bad input (`usage`),
 * writing stdout / `--json` / `--html` files, and the process exit code. The tier is shared verbatim with the
 * MCP and HTTP frontends; the use-cases themselves live in the command objects.
 */
export class Cli {
  #input = new InputManager();
  #processing = new ProcessingManager();
  #output = new OutputManager();

  /** Write a finished output descriptor to the terminal: any files, then stdout, then the side logs. */
  #writeTrace(out: OutputResult): void {
    for (const file of out.files) writeFileSync(file.path, file.contents);
    process.stdout.write(out.stdout + "\n");
    for (const line of out.logs) log.info(line.message, line.data);
  }

  /** Shared tail for the static analyses: render the envelope, forward it to a collector, exit on its error state. */
  async #finishStatic(result: ProcessingResult, options: any): Promise<never> {
    const out = this.#output.emit(result, options);
    this.#writeTrace(out);
    await this.#processing.forwardStatic(result.trace);   // post-gate, explicit-only (TRACE_COLLECTOR_URL)
    process.exit(out.exitCode);
  }

  async #runDynamic(options: any): Promise<void> {
    let normalized;
    try { normalized = this.#input.acceptRun(options); }
    catch (error) { if (error instanceof InputError) usage(error.message); throw error; }

    let result: ProcessingResult;
    try { result = await this.#processing.runDynamic(normalized); }
    catch (error) {
      // The run threw; ProcessingManager already flushed the terminal envelope to the collector and logged the
      // ENGINE_FATAL cause. Surface the failure as a non-zero exit, matching the old inline behavior.
      if (error instanceof EngineAbortError) process.exit(1);
      throw error;
    }
    const out = this.#output.emit(result, options);
    this.#writeTrace(out);
    process.exit(out.exitCode);
  }

  async #runGraph(options: any): Promise<void> {
    let request;
    try { request = this.#input.acceptGraph(options); }
    catch (error) { if (error instanceof InputError) usage(error.message); throw error; }
    await this.#finishStatic(await this.#processing.runGraph(request), options);
  }

  async #runDeps(options: any): Promise<void> {
    let request;
    try { request = this.#input.acceptDeps(options); }
    catch (error) { if (error instanceof InputError) usage(error.message); throw error; }
    await this.#finishStatic(await this.#processing.runDeps(request), options);
  }

  async #runComplexity(path: string, options: any): Promise<void> {
    const request = this.#input.acceptComplexity({ ...options, path });
    await this.#finishStatic(await this.#processing.runComplexity(request), options);
  }

  async #runSymbols(file: string, options: any): Promise<void> {
    let request;
    try { request = this.#input.acceptSymbols({ ...options, file }); }
    catch (error) { if (error instanceof InputError) usage(error.message); throw error; }
    await this.#finishStatic(await this.#processing.runSymbols(request), options);
  }

  build(): Command {
    const program = new Command()
      .name("trace-cli")
      .description("Unified, class-first execution tracer & analyzer — one Trace envelope across breakpoints + analysis.")
      .version(VERSION)
      .showHelpAfterError("(add --help for usage)");

    program.command("run")
      .description("breakpoints + a trigger → a full execution trace. Breakpoints are non-pausing logpoints: each hit ships its stack + in-scope locals + exprs without halting the VM, so the app runs at full speed. Node (CDP): a --curl trigger. Chrome (CDP): a scripted UI journey (--url/--step) recorded as a screen + trace-panel replay — debug and video together.")
      .option("--node [port]", `Node --inspect target (default; port ${DEFAULT_NODE_PORT})`)
      .option("--chrome [port]", "Chrome target: a running browser's --remote-debugging-port, or omit the port to launch a throwaway headless Chrome")
      .option("--chrome-profile <dir>", "Chrome: launch a (headed) browser on this persistent --user-data-dir so saved logins/cookies carry over — trace a real, authenticated session. Use a COPY of your profile (Chrome 136+ blocks remote-debugging on the default dir; one process per dir). Implies launching, so don't combine with --chrome <port>.")
      .option("--headed", "Chrome: launch the browser visibly instead of headless (applies to --chrome / --chrome-profile launch modes; implied by --chrome-profile)")
      .option("--breakpoint <file:line>", "breakpoint, repeatable: file:line or file@substring (non-pausing; in-scope locals are captured automatically)", collect, [])
      .option("--expression <js>", "extra expression captured at every hit, repeatable — for computed/derived values beyond the auto-captured locals (e.g. user.id, cart.length)", collect, [])
      .option("--root <dir>", "project root for resolving --breakpoint file paths and source maps (default: cwd) — needed when a file@substring breakpoint or a built app's sources live outside cwd")
      .option("--max-hits <n>", "stop after this many breakpoint hits (default: 100; non-pausing logpoints, so a hot path is cheap to raise)", parseIntArg)
      .option("--curl <cmd>", "trigger for node: a command run once breakpoints are set")
      .option("--url <url>", "chrome trigger shorthand: a page URL to navigate (equivalent to --step goto:<url>)")
      .option("--step <s>", "chrome journey step, repeatable & ordered: goto:<url> · click:<sel> · type:<sel>=<text> · waitfor:<sel> · wait:<ms> · newtab · eval:<js>  (sel: CSS or text=…)", collect, [])
      .option("--output <mp4>", "chrome: output path for the screen + trace-panel recording (default: a temp file)")
      .option("--emit <url>", "stream the trace to a collector (POST /v1/traces) — the session appears live as it runs (default: env TRACE_COLLECTOR_URL, else a locally-running collector is auto-detected)")
      .option("--json [path]", "envelope as JSON: to a file if a path is given, else to stdout")
      .option("--concise", "trim the PRINTED --json envelope (stdout/file) for token-tight agent reads: per hit, locals collapse to key names and the call stack keeps its top 2 frames (watched --expression values, location & timing kept). Does NOT affect --emit — the collector always receives the full envelope. Re-run --detailed for everything.")
      .option("--detailed", "full --json envelope: every local's value and the complete call stack at each hit (the default)")
      .action((options) => this.#runDynamic(options));

    // static analysis — code structure without running the app. Each command shells out to one analyzer and
    // emits the same Trace envelope as the runtime `run` command (call graph · deps · complexity · symbols).
    program.command("graph")
      .description("call graph rooted at an entry → the flow tree for a function/route, via LSP call hierarchy")
      .requiredOption("--entry <ref>", "where to start: file:line, file:line:column, or file@symbol (e.g. src/auth.service.ts:42:9 or src/auth.service.ts@exchangeToken)")
      .option("--root <dir>", "project root / LSP workspace (default: auto — nearest tsconfig/package.json/.git above the entry)")
      .option("--server <cmd>", "override the LSP server (default: auto by file extension; bundled typescript-language-server for TS/JS, e.g. \"gopls\", \"pyright --stdio\")")
      .option("--depth <n>", "max call depth expanded from the entry", parseIntArg, 6)
      .option("--html [path]", "also write an interactive call-graph diagram — nodes & edges, force-directed (to a file if a path is given, else a temp file)")
      .option("--json [path]", "envelope as JSON: to a file if a path is given, else to stdout")
      .action((options) => this.#runGraph(options));

    program.command("deps")
      .description("module-import graph (+ circular-dependency groups) via madge")
      .requiredOption("--entry <path>", "file or directory whose import graph to build")
      .option("--root <dir>", "working directory for madge (default: cwd)")
      .option("--extensions <list>", "comma-separated file extensions to scan (default: ts,tsx,js,jsx,mjs,cjs)")
      .option("--tsconfig <path>", "tsconfig for path-alias resolution (default: auto-detected near root/entry)")
      .option("--exclude <regexp>", "drop module paths matching this regexp (madge --exclude), e.g. \"(^|/)dist/\" to skip build output")
      .option("--html [path]", "also write the whole module graph as an interactive node-and-edge diagram (to a file if a path is given, else a temp file)")
      .option("--json [path]", "envelope as JSON: to a file if a path is given, else to stdout")
      .action((options) => this.#runDeps(options));

    program.command("complexity")
      .description("per-function cyclomatic complexity via lizard")
      .argument("[path]", "file or directory to analyze (default: current directory)", ".")
      .option("--root <dir>", "working directory for lizard (default: cwd)")
      .option("--json [path]", "envelope as JSON: to a file if a path is given, else to stdout")
      .action((path, options) => this.#runComplexity(path, options));

    program.command("symbols")
      .description("top-level definitions (functions/classes/types) in a file via tree-sitter")
      .argument("<file>", "source file to outline")
      .option("--root <dir>", "working directory / project root (default: cwd)")
      .option("--json [path]", "envelope as JSON: to a file if a path is given, else to stdout")
      .action((file, options) => this.#runSymbols(file, options));

    program.command("doctor")
      .description("report which backing tools are installed (+ versions), grouped by pillar")
      .option("--json [path]", "envelope as JSON: to a file if a path is given, else to stdout")
      .action(async (options) => {
        const result = await this.#processing.runDoctor();
        this.#writeTrace(this.#output.emit(result, options));
        process.exit(0);   // missing tools are warnings — doctor itself always succeeds
      });

    program.command("serve")
      .description("hosted dashboard: the standalone Next.js UI + same-origin API (ingest POST /v1/traces, list, live SSE), persisted to Postgres")
      .option("--port <n>", "port to listen on", parseIntArg, DEFAULT_COLLECTOR_PORT)
      .option("--host <h>", "host to bind (default 0.0.0.0)")
      .option("--database-url <url>", "Postgres connection string to persist sessions (env DATABASE_URL/POSTGRES_URL)")
      .action((options) => new ServeCommand().run({ port: options.port, host: options.host, databaseUrl: options.databaseUrl }));

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
      .action((dir, options) => {
        try {
          const { src: source, dest: destination } = new ExportSkillCommand().run({ dir, force: options.force });
          process.stdout.write(`[trace-cli] skill exported → ${destination}\n`);
          log.info("skill exported", { src: source, dest: destination });
          process.exit(0);
        } catch (error: any) {
          process.stderr.write(`trace-cli: ${error.message}\n`);
          process.exit(1);
        }
      });

    // Verbosity is a property of every command, so add the pair to each rather than to the root (where it would
    // only be honored before the subcommand). The preAction hook maps the flag onto the same TRACE_LOG_LEVEL the
    // logger already reads — so `-v`, `-q` and an explicit env var are one mechanism, not three.
    for (const command of program.commands) {
      command.option("-v, --verbose", "verbose stderr logging: every phase marker + CDP transport (= TRACE_LOG_LEVEL=debug)");
      command.option("-q, --quiet", "quiet stderr logging: errors only, no progress (= TRACE_LOG_LEVEL=error)");
    }
    program.hook("preAction", (_thisCommand, actionCommand) => {
      const options = actionCommand.opts();
      if (options.verbose) process.env.TRACE_LOG_LEVEL = "debug";
      else if (options.quiet) process.env.TRACE_LOG_LEVEL = "error";
    });

    return program;
  }

  async run(argv: string[] = process.argv): Promise<void> {
    const program = this.build().exitOverride();
    try {
      await program.parseAsync(argv);
    } catch (error: any) {
      if (error instanceof CommanderError) {
        if (["commander.help", "commander.helpDisplayed", "commander.version"].includes(error.code)) process.exit(0);
        process.exit(2);
      }
      process.stderr.write(`trace-cli: ${error?.message || error}\n`);
      process.exit(1);
    }
  }
}
