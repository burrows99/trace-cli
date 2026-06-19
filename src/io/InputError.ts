import { Code } from "../shared/codes.js";

/**
 * InputError — what {@link InputManager} throws when transport-neutral input fails validation, BEFORE any
 * tracer/engine/analysis work begins. It replaces the CLI's old `usage()` (which wrote to stderr and
 * `process.exit(2)`) with a structured throw, so every frontend maps the same failure to its own shape:
 *   • CLI  → `usage(message)` → stderr + exit 2 (byte-identical to before),
 *   • MCP  → a tool result with `isError: true`,
 *   • HTTP → `400 { error, code, problems }`.
 *
 * `message` is the single human line (the exact string the CLI prints). `problems` carries the individual
 * validation lines when the error aggregates several (a failed `RunInput.validate()` / `validateSteps()`);
 * these are already redaction-safe (step problems are labelled by index + action, never the raw typed value).
 */
export class InputError extends Error {
  readonly code = Code.INPUT;
  readonly problems: string[];

  constructor(message: string, problems: string[] = []) {
    super(message);
    this.name = "InputError";
    this.problems = problems;
  }
}
