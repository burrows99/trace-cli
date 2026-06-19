import { Diagnostic } from "../domain/Diagnostic.js";
import { Code } from "../shared/codes.js";
import type { Trace } from "../domain/Trace.js";

/**
 * OutputValidator — the validation half of the output tier, split out of {@link OutputManager}. It owns the
 * envelope-contract GATE: run the Trace's own structural validation and turn each violation into an E_SCHEMA
 * error diagnostic, then recompute `ok` — so a structurally-malformed envelope flips to ok:false (and a non-zero
 * exit) instead of shipping silently. Mutates the trace in place (the same instance a later collector forward
 * serializes), and returns nothing. Stateless.
 */
export class OutputValidator {
  gate(trace: Trace): void {
    // Enforce the envelope contract before it leaves the process: structural violations become error
    // diagnostics (and flip `ok`/exit code) instead of shipping a silently-malformed Trace.
    for (const problem of trace.validate()) trace.diagnostics.push(Diagnostic.error(Code.SCHEMA, problem));
    trace.ok = !trace.hasErrors();
  }
}
