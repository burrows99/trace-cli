import { CdpDriver, log } from "../transport/CdpDriver.js";
import { Cdp } from "../transport/cdp.js";
import { SourceMaps } from "./SourceMaps.js";
import { ScopeExtractor } from "./ScopeExtractor.js";
import { buildCondition } from "./Logpoint.js";
import { type ResolvedBp } from "./BreakpointResolver.js";
import { Breakpoint } from "../domain/Breakpoint.js";

/**
 * BpBinder — resolves source `file:line` breakpoints to CDP breakpoints, idempotently and incrementally, and
 * arms each one as a *non-pausing logpoint*: at bind time it reads the generated source, extracts the in-scope
 * variable names, and sets the breakpoint with a `condition` that captures those locals + the user's exprs and
 * ships them out without ever halting the VM (see {@link buildCondition}). `tryBind` may be called repeatedly
 * (once for Node, once per instrumentation pause for Chrome): each breakpoint is *attempted at most once* (so
 * we never register a duplicate), but one whose script has not parsed yet is left for a later attempt.
 * `allSettled` is true when every breakpoint has either bound or been attempted.
 */
export class BpBinder {
  readonly bpById = new Map<string, { file: string; line: number }>();
  #state: { bp: ResolvedBp; attempted: boolean; bound: boolean; mapped: boolean; note?: string }[];
  #exprs: string[];

  constructor(bps: ResolvedBp[], exprs: string[] = []) {
    this.#state = bps.map((bp) => ({ bp, attempted: false, bound: false, mapped: false }));
    this.#exprs = exprs;
  }

  allSettled(): boolean { return this.#state.every((s) => s.attempted); }

  async tryBind(driver: CdpDriver, sm: SourceMaps): Promise<void> {
    for (const s of this.#state) {
      if (s.attempted) continue;
      const g = await sm.findGenerated(s.bp.file, s.bp.line);
      if (!g) { s.note = "no loaded script/source matched (loaded yet? right file/route?)"; continue; }
      s.attempted = true;
      const locals = await this.#scopeNames(driver, g.scriptId, g.lineNumber, g.columnNumber);
      const condition = buildCondition(`${s.bp.file}:${s.bp.line}`, locals, this.#exprs);
      const r = await driver.send(Cdp.Debugger.setBreakpointByUrl, { urlRegex: g.urlRegex, lineNumber: g.lineNumber, columnNumber: g.columnNumber, condition });
      s.bound = !!(r.locations && r.locations.length);
      s.mapped = g.mapped;
      s.note = s.bound ? undefined : "breakpoint set but no location resolved yet";
      this.bpById.set(r.breakpointId, { file: s.bp.file, line: s.bp.line });
      log(`bp ${s.bp.file}:${s.bp.line} → ${s.bound ? "BOUND" : "pending"}${g.mapped ? " (mapped)" : ""} · ${locals.length} locals`);
    }
  }

  /** Read the generated source and statically list the variables in scope at the breakpoint. Best-effort. */
  async #scopeNames(driver: CdpDriver, scriptId: string, line0: number, col0: number): Promise<string[]> {
    try {
      const { scriptSource } = await driver.send(Cdp.Debugger.getScriptSource, { scriptId });
      return scriptSource ? ScopeExtractor.inScopeNames(scriptSource, line0 + 1, col0) : [];
    } catch { return []; }
  }

  report(): Breakpoint[] {
    return this.#state.map((s) => new Breakpoint({ file: s.bp.file, line: s.bp.line, bound: s.bound, mapped: s.mapped, ...(s.note ? { note: s.note } : {}) }));
  }

  unbound(): string[] { return this.#state.filter((s) => !s.bound).map((s) => `${s.bp.file}:${s.bp.line}`); }
}
