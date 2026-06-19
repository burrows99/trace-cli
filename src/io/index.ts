/**
 * `trace-cli/io` — the middle tier the CLI, MCP, and HTTP frontends share. Each frontend is a thin adapter:
 * it maps its transport (argv / tool params / an HTTP body) onto these three managers and renders the result
 * its own way. The managers own input acceptance, run orchestration, and output shaping; they never touch a
 * transport, `process.stdout`, or `process.exit`.
 */
export { InputManager } from "./InputManager.js";
export { InputValidator } from "./InputValidator.js";
export { InputError } from "./InputError.js";
export { ProcessingManager, EngineAbortError, emitFailureMessage } from "./ProcessingManager.js";
export { OutputManager, condense } from "./OutputManager.js";
export { OutputValidator } from "./OutputValidator.js";
export type {
  RawRunInput, RawGraphInput, RawDepsInput, RawComplexityInput, RawSymbolsInput,
  NormalizedRun, RunRequest, ProcessingResult, OutputOptions, OutputResult, FileOutput, OutputLog,
} from "./descriptors.js";
