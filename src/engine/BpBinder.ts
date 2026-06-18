import { CdpDriver, log } from "../transport/CdpDriver.js";
import { Cdp } from "../transport/cdp.js";
import { SourceMaps } from "./SourceMaps.js";
import { type ResolvedBp } from "./BreakpointResolver.js";
import { Breakpoint } from "../domain/Breakpoint.js";

/**
 * BpBinder — resolves source `file:line` breakpoints to CDP breakpoints, idempotently and incrementally.
 * `tryBind` may be called repeatedly (once for Node, once per instrumentation pause for Chrome): each
 * breakpoint is *attempted at most once* (so we never register a duplicate), but a breakpoint whose script
 * has not parsed yet is left for a later attempt. `allSettled` is true when every breakpoint has either
 * bound or been attempted — i.e. there is nothing more to gain by pausing on further scripts.
 */
export class BpBinder {
  readonly bpById = new Map<string, { file: string; line: number }>();
  #state: { bp: ResolvedBp; attempted: boolean; bound: boolean; mapped: boolean; note?: string }[];

  constructor(bps: ResolvedBp[]) { this.#state = bps.map((bp) => ({ bp, attempted: false, bound: false, mapped: false })); }

  allSettled(): boolean { return this.#state.every((s) => s.attempted); }

  async tryBind(driver: CdpDriver, sm: SourceMaps): Promise<void> {
    for (const s of this.#state) {
      if (s.attempted) continue;
      const g = await sm.findGenerated(s.bp.file, s.bp.line);
      if (!g) { s.note = "no loaded script/source matched (loaded yet? right file/route?)"; continue; }
      s.attempted = true;
      const r = await driver.send(Cdp.Debugger.setBreakpointByUrl, { urlRegex: g.urlRegex, lineNumber: g.lineNumber, columnNumber: g.columnNumber });
      s.bound = !!(r.locations && r.locations.length);
      s.mapped = g.mapped;
      s.note = s.bound ? undefined : "breakpoint set but no location resolved yet";
      this.bpById.set(r.breakpointId, { file: s.bp.file, line: s.bp.line });
      log(`bp ${s.bp.file}:${s.bp.line} → ${s.bound ? "BOUND" : "pending"}${g.mapped ? " (mapped)" : ""}`);
    }
  }

  report(): Breakpoint[] {
    return this.#state.map((s) => new Breakpoint({ file: s.bp.file, line: s.bp.line, bound: s.bound, mapped: s.mapped, ...(s.note ? { note: s.note } : {}) }));
  }

  unbound(): string[] { return this.#state.filter((s) => !s.bound).map((s) => `${s.bp.file}:${s.bp.line}`); }
}
