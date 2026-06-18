import { Trace, TraceData } from "../../domain/Trace.js";
import { Diagnostic } from "../../domain/Diagnostic.js";
import { logger } from "../../shared/logger.js";
import { runTool, type ToolRun } from "../../shared/runTool.js";
import { TraceCommand } from "./TraceCommand.js";

/** The tool call one analysis run makes: argv + working dir, plus any extra `meta.args` to record beyond req.args. */
export interface ToolInvocation {
  argv: string[];
  cwd: string;
  args?: Record<string, unknown>;
}

/** What `interpret` yields from a non-fatal run: a data payload and/or diagnostics (warnings or a soft failure). */
export interface AnalysisOutcome {
  data?: TraceData;
  diagnostics?: Diagnostic[];
}

/**
 * ShellAnalysisCommand — the Template-Method base shared by every "shell out to an analyzer, normalize its
 * stdout into a Trace" command (deps · complexity · symbols; the call graph has its own provider seam). The
 * base owns the run skeleton these three repeated verbatim — start stamp, spawn the tool, decide
 * fatal-vs-findings, turn any throw into a single error diagnostic, and stamp the envelope — so a subclass
 * declares its identity (tool/command/errorCode/component) and supplies only the two parts that differ:
 * the tool call ({@link invocation}) and how to read its output ({@link interpret}). A tool that is missing,
 * times out, or emits unparseable output becomes a `<errorCode>` error on a still-well-formed Trace, honouring
 * the same "an agent always gets a Trace" contract the dynamic/graph commands keep.
 */
export abstract class ShellAnalysisCommand<Req extends { args?: Record<string, unknown> }> extends TraceCommand<Req> {
  /** Binary to spawn, e.g. `"madge"`. */              protected abstract readonly tool: string;
  /** Envelope command id, e.g. `"deps.madge"`. */     protected abstract readonly command: string;
  /** Error-diagnostic code raised on failure. */      protected abstract readonly errorCode: string;
  /** Logger component label, e.g. `"deps"`. */        protected abstract readonly component: string;

  /** The tool call for this request: argv, cwd, and any meta.args to record. */
  protected abstract invocation(request: Req): ToolInvocation;

  /** Normalize a non-fatal run's output into a payload (+ optional diagnostics). Throw on unparseable output. */
  protected abstract interpret(toolRun: ToolRun, request: Req): AnalysisOutcome;

  /**
   * Whether a non-zero exit is a hard failure. Default `true` (madge succeeds with exit 0). Tools that exit
   * non-zero merely to signal findings — lizard (threshold breaches), tree-sitter (no grammar / parse errors)
   * — override to `false`, so only a process that never produced an exit code (`code === null`) is fatal and
   * everything else flows to {@link interpret}.
   */
  protected nonZeroIsFailure(): boolean {
    return true;
  }

  async run(request: Req): Promise<Trace> {
    const startedAtMs = this.started();
    const diagnostics: Diagnostic[] = [];
    let data = new TraceData({});
    let args = request.args ?? {};

    try {
      const toolInvocation = this.invocation(request);
      if (toolInvocation.args) args = toolInvocation.args;
      const toolRun = await runTool(this.tool, toolInvocation.argv, { cwd: toolInvocation.cwd });
      const fatal = this.nonZeroIsFailure() ? !toolRun.ok : toolRun.exitCode === null;
      if (fatal) {
        const message = toolRun.error ?? (this.nonZeroIsFailure() ? `${this.tool} exited ${toolRun.exitCode}` : `${this.tool} did not run`);
        diagnostics.push(Diagnostic.error(this.errorCode, message));
        // Same code on the log line as the envelope diagnostic, so the two channels join on `errorCode`.
        logger.child({ component: this.component }).error(`${this.tool} failed`, { code: this.errorCode, err: toolRun.error });
      } else {
        const outcome = this.interpret(toolRun, request);
        if (outcome.data) data = outcome.data;
        if (outcome.diagnostics?.length) diagnostics.push(...outcome.diagnostics);
      }
    } catch (error: any) {
      // A throw from invocation/interpret (e.g. unparseable output, unreadable file) → one error diagnostic.
      diagnostics.push(Diagnostic.error(this.errorCode, String(error?.message ?? error).split("\n")[0]));
    }

    return this.envelope({ command: this.command, data, diagnostics, args, startedAtMs });
  }
}
