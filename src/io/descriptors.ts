import type { Trace } from "../domain/Trace.js";
import type { RunRequest } from "../cli/commands/RunCommand.js";
import type { GraphRequest } from "../cli/commands/GraphCommand.js";
import type { DepsRequest } from "../cli/commands/DepsCommand.js";
import type { ComplexityRequest } from "../cli/commands/ComplexityCommand.js";
import type { SymbolsRequest } from "../cli/commands/SymbolsCommand.js";

/**
 * descriptors — the transport-neutral data shapes the three IO managers pass between each other and hand to the
 * frontend adapters. Raw* types mirror the already-parsed flag/param objects (NOT argv); the managers never see
 * a transport. ProcessingResult / OutputResult are descriptors — they carry WHAT to do (text to print, files to
 * write, the exit code) but perform no I/O, so the same result drives stdout+exit on the CLI, a JSON body on
 * HTTP, or tool content on MCP.
 */

// ── raw input (mirrors the parsed flags; field names match the commander option camelCase) ────────────────

export interface RawRunInput {
  node?: number | boolean;
  chrome?: number | boolean | string;
  chromeProfile?: string;
  headed?: boolean;
  breakpoint: string[];
  expression: string[];
  root?: string;
  maxHits?: number;
  curl?: string;
  url?: string;
  step: string[];
  output?: string;
  emit?: string | null;
  json?: string | boolean;
  concise?: boolean;
  detailed?: boolean;
}

export interface RawGraphInput {
  entry?: string;            // file:line / file@symbol → rooted call walk; a dir or omitted → repo map
  root?: string;
  server?: string;
  depth: number;
  maxFiles?: number;         // repo map: cap on files scanned
  includeExternal?: boolean; // repo map: keep edges to node_modules / outside-root symbols
  inheritance?: boolean;     // repo map: commander --no-inheritance sets this false (skip type hierarchy)
  html?: string | boolean;
  json?: string | boolean;
  concise?: boolean;
}

export interface RawDepsInput {
  entry: string;
  root?: string;
  extensions?: string;
  tsconfig?: string;
  exclude?: string;
  html?: string | boolean;
  json?: string | boolean;
  concise?: boolean;
}

export interface RawComplexityInput {
  path?: string;
  root?: string;
  json?: string | boolean;
  concise?: boolean;
}

export interface RawSymbolsInput {
  file: string;
  root?: string;
  json?: string | boolean;
  concise?: boolean;
}

// ── normalized input (InputManager → ProcessingManager) ────────────────────────────────────────────────────

/** The run request minus the live streaming sink — ProcessingManager owns and injects `onProgress`. */
export type NormalizedRunRequest = Omit<RunRequest, "onProgress">;

/** The run command's normalized form: the validated request plus the resolved collector policy (the raw
 *  `--emit` value; `Collector.resolve` turns it into an explicit target or auto-discovers a local dashboard). */
export interface NormalizedRun {
  request: NormalizedRunRequest;
  emit?: string | null;
}

// ── processing result (ProcessingManager → OutputManager / adapter) ─────────────────────────────────────────

/** The outcome of one use-case run: the finished envelope plus the command's bound render thunks. The thunks
 *  defer rendering so OutputManager only pays for the representation a given frontend actually emits. */
export interface ProcessingResult {
  trace: Trace;
  render: () => string;
  renderHtml?: () => string;
}

// ── output (OutputManager → adapter) ────────────────────────────────────────────────────────────────────────

/** The format/destination knobs an adapter forwards from its raw input (the verbosity + sink flags). */
export interface OutputOptions {
  json?: string | boolean;   // bare true → JSON to stdout; a string → JSON to that file (stdout stays human)
  concise?: boolean;         // trim the PRINTED envelope (locals → key names, stack → top frames)
  html?: string | boolean;   // graph/deps only: also emit the interactive diagram (true → temp file, string → path)
}

/** A file the adapter should write. OutputManager computes the path + contents; it never touches the disk. */
export interface FileOutput { path: string; contents: string; }

/** A side-channel log line the adapter should emit (stderr) after writing — e.g. "envelope written". */
export interface OutputLog { message: string; data: Record<string, unknown>; }

/** Everything the adapter needs to render one result: the primary text, any files, the side logs, the exit code
 *  (derived from the envelope's error state AFTER the schema gate). The adapter decides how to deliver each. */
export interface OutputResult {
  stdout: string;
  files: FileOutput[];
  logs: OutputLog[];
  exitCode: number;
}

export type { GraphRequest, DepsRequest, ComplexityRequest, SymbolsRequest };
