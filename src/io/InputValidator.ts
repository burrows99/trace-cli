import { TargetKind } from "../domain/Target.js";
import { RunInput, GraphInput, validateSteps } from "../cli/CommandInputs.js";
import { InputError } from "./InputError.js";
import type { RawRunInput } from "./descriptors.js";

/** The normalized run fields the strict DTO validation needs (target + trigger, post-`pickTarget`). */
export interface RunFields {
  target: TargetKind; port: number; launch?: boolean; profileDir?: string; headed?: boolean;
  breakpoints: string[]; exprs: string[]; steps: string[]; curl?: string;
}
/** A graph entry anchor: a file plus a 1-based line (optional column) or a symbol. */
export interface GraphFields { file: string; line?: number; column?: number; symbol?: string; depth?: number; }

/**
 * InputValidator — the validation half of the input tier, split out of {@link InputManager} so the RULES (what
 * makes an invocation legal) live apart from the NORMALIZATION (turning flags into a request). Every method
 * throws {@link InputError} on the first violation it finds — with the exact human wording each frontend
 * surfaces (the CLI as exit-2, MCP/HTTP as their own error shapes) — and returns void when the input is clean.
 * Stateless; the rules are the only thing here.
 */
export class InputValidator {
  /** `run` flag-combination guards that depend only on the raw flags (target + verbosity mutual exclusion). */
  guardRunFlags(raw: RawRunInput): void {
    if (raw.chrome != null && raw.node != null) throw new InputError("pick one target: --node or --chrome, not both");
    if (raw.chromeProfile && raw.node != null) throw new InputError("--chrome-profile is a chrome option — don't combine it with --node");
    // --chrome-profile launches a browser on that profile; an explicit --chrome <port> means attach to a running one.
    if (raw.chromeProfile && typeof raw.chrome === "string") throw new InputError("pick one: --chrome-profile launches a logged-in browser, or --chrome <port> attaches to a running one — not both");
    if (raw.headed && !(raw.chrome != null || raw.chromeProfile)) throw new InputError("--headed only applies when launching Chrome (use with --chrome or --chrome-profile)");
    if (raw.concise && raw.detailed) throw new InputError("pick one envelope verbosity: --concise or --detailed, not both");
  }

  /** `run` trigger guards that depend on the resolved target + the assembled journey steps. */
  guardRunTrigger(raw: RawRunInput, resolved: { target: TargetKind; isChrome: boolean; steps: string[] }): void {
    const { target, isChrome, steps } = resolved;
    if (!raw.breakpoint.length) throw new InputError("run needs at least one --breakpoint (file:line or file@substring)");
    if (isChrome && !steps.length) throw new InputError("chrome target needs --url or at least one --step");
    if (isChrome && raw.curl) throw new InputError("--curl is a node-only trigger (chrome uses --url/--step)");
    if (!isChrome && raw.step.length) throw new InputError("--step is a chrome-only trigger (node uses --curl)");
    if (!isChrome && !raw.curl) throw new InputError(`${target} target needs --curl`);
  }

  /** Strict DTO validation of the normalized run input (the class-validator regime). */
  validateRun(fields: RunFields): void {
    const problems = new RunInput(fields).validate();
    if (problems.length) throw new InputError(`invalid input — ${problems.join("; ")}`, problems);
  }

  /**
   * Strict step-vocabulary validation: reject an unknown action (`--step frobnicate:x`) or a missing required
   * arg before any browser work, so the failure names the allowed verbs instead of silently no-op'ing.
   */
  validateSteps(steps: string[]): void {
    const problems = validateSteps(steps);
    if (problems.length) throw new InputError(`invalid step — ${problems.join("; ")}`, problems);
  }

  /** Strict validation of a graph entry anchor (a file plus a line or a symbol). */
  validateGraph(fields: GraphFields): void {
    const problems = new GraphInput(fields).validate();
    if (problems.length) throw new InputError(`invalid input — ${problems.join("; ")}`, problems);
  }

  /** Presence guards for the commands whose only input gate is "the required argument is there". */
  requireDepsEntry(entry?: string): void {
    if (!entry) throw new InputError("deps needs --entry <file|dir>");
  }
  requireSymbolsFile(file?: string): void {
    if (!file) throw new InputError("symbols needs a <file>");
  }
}
