import { CdpDriver, log } from "../transport/CdpDriver.js";
import { Cdp } from "../transport/cdp.js";
import { SourceMaps } from "./SourceMaps.js";
import { ScopeExtractor } from "./ScopeExtractor.js";
import { buildCondition } from "./Logpoint.js";
import { type ResolvedBreakpoint } from "./BreakpointResolver.js";
import { Breakpoint } from "../domain/Breakpoint.js";

/**
 * BreakpointBinder — resolves source `file:line` breakpoints to CDP breakpoints, idempotently and incrementally, and
 * arms each one as a *non-pausing logpoint*: at bind time it reads the generated source, extracts the in-scope
 * variable names, and sets the breakpoint with a `condition` that captures those locals + the user's exprs and
 * ships them out without ever halting the VM (see {@link buildCondition}). `tryBind` may be called repeatedly
 * (once for Node, once per instrumentation pause for Chrome): each breakpoint is *attempted at most once* (so
 * we never register a duplicate), but one whose script has not parsed yet is left for a later attempt.
 * `allSettled` is true when every breakpoint has either bound or been attempted.
 */
export class BreakpointBinder {
  readonly bpById = new Map<string, { file: string; line: number }>();
  #state: { bp: ResolvedBreakpoint; attempted: boolean; bound: boolean; mapped: boolean; note?: string }[];
  #exprs: string[];

  constructor(breakpoints: ResolvedBreakpoint[], exprs: string[] = []) {
    this.#state = breakpoints.map((breakpoint) => ({ bp: breakpoint, attempted: false, bound: false, mapped: false }));
    this.#exprs = exprs;
  }

  allSettled(): boolean { return this.#state.every((state) => state.attempted); }

  async tryBind(driver: CdpDriver, sm: SourceMaps): Promise<void> {
    for (const state of this.#state) {
      if (state.attempted) continue;
      const generated = await sm.findGenerated(state.bp.file, state.bp.line);
      if (!generated) { state.note = "no loaded script/source matched (loaded yet? right file/route?)"; continue; }
      state.attempted = true;
      const locals = await this.#scopeNames(driver, generated.scriptId, generated.lineNumber, generated.columnNumber);
      const condition = buildCondition(`${state.bp.file}:${state.bp.line}`, locals, this.#exprs);
      const result = await driver.send(Cdp.Debugger.setBreakpointByUrl, { urlRegex: generated.urlRegex, lineNumber: generated.lineNumber, columnNumber: generated.columnNumber, condition });
      state.bound = !!(result.locations && result.locations.length);
      state.mapped = generated.mapped;
      state.note = state.bound ? undefined : "breakpoint set but no location resolved yet";
      this.bpById.set(result.breakpointId, { file: state.bp.file, line: state.bp.line });
      log(`bp ${state.bp.file}:${state.bp.line} → ${state.bound ? "BOUND" : "pending"}${generated.mapped ? " (mapped)" : ""} · ${locals.length} locals`);
    }
  }

  /** Read the generated source and statically list the variables in scope at the breakpoint. Best-effort. */
  async #scopeNames(driver: CdpDriver, scriptId: string, lineIndex: number, columnIndex: number): Promise<string[]> {
    try {
      const { scriptSource } = await driver.send(Cdp.Debugger.getScriptSource, { scriptId });
      return scriptSource ? ScopeExtractor.inScopeNames(scriptSource, lineIndex + 1, columnIndex) : [];
    } catch { return []; }
  }

  report(): Breakpoint[] {
    return this.#state.map((state) => new Breakpoint({ file: state.bp.file, line: state.bp.line, bound: state.bound, mapped: state.mapped, ...(state.note ? { note: state.note } : {}) }));
  }

  unbound(): string[] { return this.#state.filter((state) => !state.bound).map((state) => `${state.bp.file}:${state.bp.line}`); }
}
