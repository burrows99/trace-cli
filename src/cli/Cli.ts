import { Command, CommanderError } from "commander";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { DynamicCommand, type DynamicTargetKind } from "./commands/DynamicCommand.js";
import { GraphCommand } from "./commands/GraphCommand.js";
import { DepsCommand } from "./commands/DepsCommand.js";
import { ComplexityCommand } from "./commands/ComplexityCommand.js";
import { SymbolsCommand } from "./commands/SymbolsCommand.js";
import { DoctorCommand } from "./commands/DoctorCommand.js";
import { ExportSkillCommand } from "./commands/ExportSkillCommand.js";
import { ManifestCommand } from "./commands/ManifestCommand.js";
import { SchemaCommand } from "./commands/SchemaCommand.js";
import { ServeCommand } from "./commands/ServeCommand.js";
import { Tracer } from "../engine/Tracer.js";
import { Collector, type EmitResult } from "../collector/Collector.js";
import { S3ArtifactStore } from "../storage/S3ArtifactStore.js";
import { VERSION } from "../shared/version.js";
import { TargetKind } from "../domain/Target.js";
import { Diagnostic } from "../domain/Diagnostic.js";
import { DEFAULT_NODE_PORT, DEFAULT_COLLECTOR_PORT } from "../shared/defaults.js";
import { DynamicInput, GraphInput, validateSteps } from "./CommandInputs.js";
import { EntryReference } from "../codegraph/CodeGraphProvider.js";
import { logger } from "../shared/logger.js";
import { Code } from "../shared/codes.js";
import type { Trace } from "../domain/Trace.js";

const log = logger.child({ component: "cli" });
const parseIntArg = (value: string) => parseInt(value, 10);
const collect = (value: string, accumulator: string[]) => { accumulator.push(value); return accumulator; };
const usage = (message: string): never => { process.stderr.write(`trace-cli: ${message}\n`); process.exit(2); };

interface PickedTarget { target: DynamicTargetKind; port: number; launch: boolean; profileDir?: string; headed?: boolean; }
function pickTarget(options: any): PickedTarget {
  // A named --chrome-profile selects Chrome and implies launching it (a profile can only be grafted onto a
  // browser we spawn), even without --chrome; bare --chrome (no port) launches a throwaway, a port attaches.
  if (options.chrome != null || options.chromeProfile) {
    const profileDir: string | undefined = options.chromeProfile || undefined;
    const launch = profileDir != null || options.chrome === true;
    const headed = options.headed === true || profileDir != null; // a logged-in profile is shown so you can watch/intervene
    return { target: TargetKind.Chrome, port: launch ? 0 : parseIntArg(options.chrome), launch, ...(profileDir ? { profileDir } : {}), headed };
  }
  return { target: TargetKind.Node, port: options.node === undefined || options.node === true ? DEFAULT_NODE_PORT : parseIntArg(options.node), launch: false };
}

/**
 * condense — trim the JSON envelope to high-signal fields for token-tight agent consumption (the `--concise`
 * flag). Per breakpoint hit, the locals object (the firehose) collapses to its key names and the call stack
 * caps at the top frames, each with a count so nothing looks complete-but-truncated; watched `--expression` values
 * and the location/label/timing are kept verbatim. Mutates only the plain `json` (not the rich Trace the human
 * renderer reads), and no-ops on envelopes without breakpoint events (the static analyses). Re-run `--detailed`
 * for everything. The trimmed envelope still satisfies the schema (`attributes` is an open object).
 */
const CONCISE_STACK_FRAMES = 2;
export function condense(json: Record<string, unknown>): Record<string, unknown> {
  const events = (json.data as any)?.events;
  if (!Array.isArray(events)) return json;
  for (const event of events) {
    const attributes = event?.attributes;
    if (!attributes || typeof attributes !== "object") continue;
    if (attributes.locals && typeof attributes.locals === "object") {
      attributes.localsKeys = Object.keys(attributes.locals);   // values dropped; names kept so the agent knows what to re-fetch
      delete attributes.locals;
    }
    if (Array.isArray(attributes.stack) && attributes.stack.length > CONCISE_STACK_FRAMES) {
      attributes.stackDepth = attributes.stack.length;
      attributes.stack = attributes.stack.slice(0, CONCISE_STACK_FRAMES);
    }
  }
  return json;
}

/**
 * emitFailureMessage — the end-of-run diagnostic for collector emit failures. An HTTP status means the collector
 * received the request and rejected it; no status means the POST never landed (connection refused/timeout/DNS),
 * so word each distinctly rather than calling both "rejected". `count` is the total failed emits this run; `last`
 * is the most recent failure (whose reason is shown). Extracted so the wording/count stay unit-testable.
 */
export function emitFailureMessage(collector: string, count: number, last: EmitResult): string {
  return last.status
    ? `collector ${collector} rejected ${count} emit(s): HTTP ${last.status}${last.body ? ` — ${last.body.slice(0, 200)}` : ""}`
    : `${count} emit(s) to collector ${collector} failed: ${last.error ?? "unknown error"}`;
}

/** emit policy: bare --json → JSON to stdout; --json <path> → file (stdout stays human); else human. */
function emit(trace: Trace, renderHuman: () => string, options: any): void {
  // Enforce the envelope contract before it leaves the process: structural violations become error
  // diagnostics (and flip `ok`/exit code) instead of shipping a silently-malformed Trace.
  for (const problem of trace.validate()) trace.diagnostics.push(Diagnostic.error(Code.SCHEMA, problem));
  trace.ok = !trace.hasErrors();
  const json = options.concise ? condense(trace.toJSON()) : trace.toJSON();
  const writeToFile = typeof options.json === "string";
  if (writeToFile) writeFileSync(options.json, JSON.stringify(json, null, 2));
  process.stdout.write((options.json === true ? JSON.stringify(json, null, 2) : renderHuman()) + "\n");
  if (writeToFile) log.info("envelope written", { path: options.json });
}

/**
 * Cli — the commander shell. Thin: it maps flags onto command objects (DynamicCommand/DoctorCommand/…),
 * which own the use-cases. Output (stdout/--json/--emit) and exit codes live here.
 */
export class Cli {
  #dynamic = new DynamicCommand(new Tracer(), new S3ArtifactStore());

  async #runDynamic(options: any): Promise<void> {
    if (options.chrome != null && options.node != null) usage("pick one target: --node or --chrome, not both");
    if (options.chromeProfile && options.node != null) usage("--chrome-profile is a chrome option — don't combine it with --node");
    // --chrome-profile launches a browser on that profile; an explicit --chrome <port> means attach to a running one.
    if (options.chromeProfile && typeof options.chrome === "string") usage("pick one: --chrome-profile launches a logged-in browser, or --chrome <port> attaches to a running one — not both");
    if (options.headed && !(options.chrome != null || options.chromeProfile)) usage("--headed only applies when launching Chrome (use with --chrome or --chrome-profile)");
    if (options.concise && options.detailed) usage("pick one envelope verbosity: --concise or --detailed, not both");
    const { target, port, launch, profileDir, headed } = pickTarget(options);
    const isChrome = target === TargetKind.Chrome;
    if (!options.breakpoint.length) usage("run needs at least one --breakpoint (file:line or file@substring)");
    // Chrome trigger = an ordered UI journey; --url is shorthand for a leading `goto:`. Node trigger = a curl.
    const steps: string[] = isChrome ? [...(options.url ? [`goto:${options.url}`] : []), ...options.step] : [];
    if (isChrome && !steps.length) usage("chrome target needs --url or at least one --step");
    if (isChrome && options.curl) usage("--curl is a node-only trigger (chrome uses --url/--step)");
    if (!isChrome && options.step.length) usage("--step is a chrome-only trigger (node uses --curl)");
    if (!isChrome && !options.curl) usage(`${target} target needs --curl`);

    const input = new DynamicInput({ target, port, launch, profileDir, headed, breakpoints: options.breakpoint, exprs: options.expression, steps, curl: options.curl });
    const badInput = input.validate();
    if (badInput.length) usage(`invalid input — ${badInput.join("; ")}`);

    // Strict step vocabulary: reject an unknown action (`--step frobnicate:x`) or a missing required arg before
    // any browser work, so the failure names the allowed verbs instead of silently no-op'ing in the runner.
    const badSteps = validateSteps(steps);
    if (badSteps.length) usage(`invalid step — ${badSteps.join("; ")}`);

    // Redact secrets before they reach the envelope's meta.args: a `type:` step carries typed text (passwords),
    // an `eval:` step an arbitrary script body.
    const redactStep = (step: string) => step.startsWith("type:") ? step.replace(/=.*/s, "=***") : step.startsWith("eval:") ? "eval:***" : step;

    // Stream to the collector. An explicit --emit / TRACE_COLLECTOR_URL wins; otherwise we auto-discover a
    // collector listening locally, so a running `trace serve` dashboard catches the run with zero config.
    // Emits are serialized through one promise chain so a slow POST can't land a stale (smaller) envelope after
    // a newer one; each ingest upserts the session row (keyed on sessionId) and re-broadcasts over SSE, so the
    // dashboard updates live as it runs.
    const collector = await Collector.resolve(options.emit);
    let emitChain: Promise<unknown> = Promise.resolve();
    // Only the count and the most recent failure are surfaced, so keep just those — not every failed result.
    // onProgress can emit on a hot path, and retaining each failure would grow memory without bound.
    let emitFailureCount = 0;
    let lastEmitFailure: EmitResult | undefined;
    const emitToCollector = collector
      ? (envelope: unknown) => { emitChain = emitChain.then(async () => { const result = await Collector.emit(collector, envelope); if (!result.ok) { emitFailureCount++; lastEmitFailure = result; } }); }
      : undefined;

    let trace: Trace;
    try {
      ({ trace } = await this.#dynamic.run({
        target, port, launch, profileDir, headed,
        breakpoints: options.breakpoint, exprs: options.expression,
        steps, curl: options.curl,
        root: options.root, maxHits: options.maxHits,
        recordOut: options.output,
        args: { target, ...(launch ? { launch: true } : { port }), ...(profileDir ? { profile: profileDir } : {}), ...(headed && !profileDir ? { headed: true } : {}), breakpoints: options.breakpoint, ...(options.root ? { root: options.root } : {}), ...(options.maxHits ? { maxHits: options.maxHits } : {}), ...(steps.length ? { steps: steps.map(redactStep) } : {}), ...(options.curl ? { curl: options.curl } : {}) },
        ...(emitToCollector ? { onProgress: (intermediateTrace: Trace) => emitToCollector(intermediateTrace.toJSON()) } : {}),
      }));
    } catch (error) {
      // The run threw (attach failed, engine crashed, recording threw). It already emitted a TERMINAL envelope
      // via onProgress that clears the dashboard's "running" session — flush the chain so that POST actually
      // lands before we exit, then surface the failure (non-zero exit + the same ENGINE_FATAL code in the log).
      if (emitToCollector) await emitChain;
      log.error("dynamic trace aborted before completion", { code: Code.ENGINE_FATAL, err: error });
      process.exit(1);
    }

    // Flush the final (complete) envelope and all pending emits BEFORE rendering, so a rejected emit
    // (a 400 schema error, a 503 dead store) becomes a visible diagnostic in the printed/--json envelope
    // instead of vanishing into an info log — the gap that sent a debugging loop chasing the wrong cause.
    if (emitToCollector) {
      emitToCollector(trace.toJSON());
      await emitChain;
      if (lastEmitFailure && collector) {
        trace.diagnostics.push(Diagnostic.warn(Code.EMIT, emitFailureMessage(collector, emitFailureCount, lastEmitFailure)));
      }
    }
    emit(trace, () => this.#dynamic.render(trace), options);
    process.exit(trace.hasErrors() ? 1 : 0);
  }

  async #runGraph(options: any): Promise<void> {
    const entry = EntryReference.parse(options.entry);
    const input = new GraphInput({ file: entry.file, line: entry.line, column: entry.column, symbol: entry.symbol, depth: options.depth });
    const badInput = input.validate();
    if (badInput.length) usage(`invalid input — ${badInput.join("; ")}`);

    const command = new GraphCommand();
    const trace = await command.run({
      entry,
      root: options.root, // optional — GraphCommand auto-detects the project root from the entry when absent
      maxDepth: options.depth,
      server: options.server,
      args: { entry: options.entry, ...(options.root ? { root: options.root } : {}), ...(options.server ? { server: options.server } : {}), depth: options.depth },
    });

    emit(trace, () => command.render(trace), options);
    // --html [path] → also write the interactive call-graph diagram (force-directed nodes + edges). Bare flag →
    // a temp file; the path is logged to stderr (like --json <path>) so stdout stays the pure envelope/human channel.
    if (options.html != null) {
      const htmlPath = typeof options.html === "string" ? options.html : join(tmpdir(), `trace-graph-${randomUUID()}.html`);
      writeFileSync(htmlPath, command.renderHtml(trace));
      log.info("graph HTML written", { path: htmlPath });
    }
    // Static analyses carry no sessionId, so the session dashboard can't ingest them — emit only when a
    // collector is explicitly configured (no auto-discovery here, unlike a dynamic trace run).
    const collector = process.env.TRACE_COLLECTOR_URL;
    if (collector) await Collector.emit(collector, trace.toJSON());
    process.exit(trace.hasErrors() ? 1 : 0);
  }

  /** Shared tail for the static analyses: emit the envelope, forward to a collector, exit on the error state. */
  async #finish(trace: Trace, render: () => string, options: any): Promise<never> {
    emit(trace, render, options);
    const collector = process.env.TRACE_COLLECTOR_URL;   // static: explicit-only (no sessionId → dashboard can't ingest)
    if (collector) await Collector.emit(collector, trace.toJSON());
    process.exit(trace.hasErrors() ? 1 : 0);
  }

  async #runDeps(options: any): Promise<void> {
    if (!options.entry) usage("deps needs --entry <file|dir>");
    const command = new DepsCommand();
    const trace = await command.run({
      entry: options.entry,
      root: options.root,
      extensions: options.extensions,
      tsConfig: options.tsconfig,
      exclude: options.exclude,
      args: { entry: options.entry, ...(options.root ? { root: options.root } : {}) },
    });
    emit(trace, () => command.render(trace), options);
    // --html [path] → also write the whole module graph as the interactive diagram (same renderer as `graph`).
    if (options.html != null) {
      const htmlPath = typeof options.html === "string" ? options.html : join(tmpdir(), `trace-deps-${randomUUID()}.html`);
      writeFileSync(htmlPath, command.renderHtml(trace));
      log.info("deps HTML written", { path: htmlPath });
    }
    const collector = process.env.TRACE_COLLECTOR_URL;   // static: explicit-only (no sessionId → dashboard can't ingest)
    if (collector) await Collector.emit(collector, trace.toJSON());
    process.exit(trace.hasErrors() ? 1 : 0);
  }

  async #runComplexity(path: string, options: any): Promise<void> {
    const resolvedPath = path || ".";
    const command = new ComplexityCommand();
    const trace = await command.run({ path: resolvedPath, root: options.root, args: { path: resolvedPath, ...(options.root ? { root: options.root } : {}) } });
    await this.#finish(trace, () => command.render(trace), options);
  }

  async #runSymbols(file: string, options: any): Promise<void> {
    if (!file) usage("symbols needs a <file>");
    const command = new SymbolsCommand();
    const trace = await command.run({ file, root: options.root, args: { file, ...(options.root ? { root: options.root } : {}) } });
    await this.#finish(trace, () => command.render(trace), options);
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
        const command = new DoctorCommand();
        const trace = await command.run();
        emit(trace, () => command.render(trace), options);
        process.exit(0);
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
