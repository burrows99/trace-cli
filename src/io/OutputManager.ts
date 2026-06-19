import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { OutputValidator } from "./OutputValidator.js";
import type { ProcessingResult, OutputOptions, OutputResult, FileOutput, OutputLog } from "./descriptors.js";

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
 * OutputManager — the output tier. Turns a finished {@link ProcessingResult} into an {@link OutputResult}
 * descriptor: it runs the envelope-contract gate (delegated to {@link OutputValidator}), applies the `--concise`
 * transform, chooses the human-vs-JSON representation, and computes the contents of any `--json <path>` /
 * `--html [path]` files — but writes NOTHING and never calls `process.exit`. The thin frontend adapter performs
 * the actual I/O, so the same logic serves stdout+exit on the CLI, a JSON body on HTTP, and tool content on MCP.
 */
export class OutputManager {
  #validator = new OutputValidator();

  /** Gate, render, and package one trace-producing result. Mutates `result.trace` (the schema gate pushes
   *  diagnostics + recomputes `ok`) so a subsequent collector forward sees the same gated envelope. */
  emit(result: ProcessingResult, options: OutputOptions = {}): OutputResult {
    const { trace } = result;
    this.#validator.gate(trace);   // enforce the envelope contract before it leaves the process

    const envelope = options.concise ? condense(trace.toJSON()) : trace.toJSON();
    const files: FileOutput[] = [];
    const logs: OutputLog[] = [];

    // emit policy: bare --json → JSON to stdout; --json <path> → file (stdout stays human); else human.
    if (typeof options.json === "string") {
      files.push({ path: options.json, contents: JSON.stringify(envelope, null, 2) });
      logs.push({ message: "envelope written", data: { path: options.json } });
    }
    const stdout = options.json === true ? JSON.stringify(envelope, null, 2) : result.render();

    // --html [path] → also write the interactive diagram (graph/deps, which supply renderHtml). Bare flag → a
    // temp file; the kind ("graph"/"deps", from `command`) names the temp prefix + the side-log, as before.
    if (options.html != null && result.renderHtml) {
      const kind = (trace.command.split(".")[0] || "graph");
      const htmlPath = typeof options.html === "string" ? options.html : join(tmpdir(), `trace-${kind}-${randomUUID()}.html`);
      files.push({ path: htmlPath, contents: result.renderHtml() });
      logs.push({ message: `${kind} HTML written`, data: { path: htmlPath } });
    }

    return { stdout, files, logs, exitCode: trace.hasErrors() ? 1 : 0 };
  }

  /** A descriptor for the non-Trace commands (schema/manifest): a literal string + exit code, no files/gate. */
  text(stdout: string, exitCode = 0): OutputResult {
    return { stdout, files: [], logs: [], exitCode };
  }
}
