import { isAbsolute, resolve } from "node:path";

import { TargetKind } from "../domain/Target.js";
import { EntryReference } from "../codegraph/CodeGraphProvider.js";
import { isDirectory } from "../codegraph/sourceFiles.js";
import { DEFAULT_NODE_PORT } from "../shared/defaults.js";
import { InputValidator } from "./InputValidator.js";
import type {
  RawRunInput, RawGraphInput, RawDepsInput, RawComplexityInput, RawSymbolsInput,
  NormalizedRun, GraphRequest, DepsRequest, ComplexityRequest, SymbolsRequest,
} from "./descriptors.js";

const parseIntArg = (value: string) => parseInt(value, 10);

interface PickedTarget { target: TargetKind; port: number; launch: boolean; profileDir?: string; headed?: boolean; }
function pickTarget(options: RawRunInput): PickedTarget {
  // A named --chrome-profile selects Chrome and implies launching it (a profile can only be grafted onto a
  // browser we spawn), even without --chrome; bare --chrome (no port) launches a throwaway, a port attaches.
  if (options.chrome != null || options.chromeProfile) {
    const profileDir: string | undefined = options.chromeProfile || undefined;
    const launch = profileDir != null || options.chrome === true;
    const headed = options.headed === true || profileDir != null; // a logged-in profile is shown so you can watch/intervene
    return { target: TargetKind.Chrome, port: launch ? 0 : parseIntArg(options.chrome as string), launch, ...(profileDir ? { profileDir } : {}), headed };
  }
  return { target: TargetKind.Node, port: options.node === undefined || options.node === true ? DEFAULT_NODE_PORT : parseIntArg(options.node as unknown as string), launch: false };
}

// Redact secrets before they reach the envelope's meta.args: a `type:` step carries typed text (passwords),
// an `eval:` step an arbitrary script body.
const redactStep = (step: string) => step.startsWith("type:") ? step.replace(/=.*/s, "=***") : step.startsWith("eval:") ? "eval:***" : step;

/**
 * InputManager — the input tier. Accepts a transport-neutral, already-parsed input object (NOT argv) and turns
 * it into a typed command request the ProcessingManager can run. It owns the NORMALIZATION — `pickTarget`, the
 * `--url`→`goto:` step assembly, the secret redaction of typed steps, and the `meta.args` shaping — and delegates
 * the VALIDATION (the guards, the strict DTO checks, the step vocabulary) to {@link InputValidator}, which throws
 * {@link InputError} so the CLI maps it to exit-2 `usage()` and MCP/HTTP map it to their own error shapes.
 */
export class InputManager {
  #validator = new InputValidator();

  /** Validate + normalize a `run` invocation into a run request + the collector (`--emit`) policy. */
  acceptRun(raw: RawRunInput): NormalizedRun {
    this.#validator.guardRunFlags(raw);
    const { target, port, launch, profileDir, headed } = pickTarget(raw);
    const isChrome = target === TargetKind.Chrome;
    // Chrome trigger = an ordered UI journey; --url is shorthand for a leading `goto:`. Node trigger = a curl.
    const steps: string[] = isChrome ? [...(raw.url ? [`goto:${raw.url}`] : []), ...raw.step] : [];
    this.#validator.guardRunTrigger(raw, { target, isChrome, steps });
    this.#validator.validateRun({ target, port, launch, profileDir, headed, breakpoints: raw.breakpoint, exprs: raw.expression, steps, curl: raw.curl });
    this.#validator.validateSteps(steps);

    const request: NormalizedRun["request"] = {
      target, port, launch, profileDir, headed,
      breakpoints: raw.breakpoint, exprs: raw.expression,
      steps, curl: raw.curl,
      root: raw.root, maxHits: raw.maxHits,
      recordOut: raw.output,
      args: { target, ...(launch ? { launch: true } : { port }), ...(profileDir ? { profile: profileDir } : {}), ...(headed && !profileDir ? { headed: true } : {}), breakpoints: raw.breakpoint, ...(raw.root ? { root: raw.root } : {}), ...(raw.maxHits ? { maxHits: raw.maxHits } : {}), ...(steps.length ? { steps: steps.map(redactStep) } : {}), ...(raw.curl ? { curl: raw.curl } : {}) },
    };
    return { request, emit: raw.emit };
  }

  /**
   * Validate + normalize a `graph` invocation. Two modes: a rooted call walk when `--entry` carries an anchor
   * (file:line[:column] or file@symbol), or a whole-directory **repo map** when `--entry` is omitted or names a
   * directory. The rooted path keeps the strict entry-anchor validation; the repo path needs no anchor.
   */
  acceptGraph(raw: RawGraphInput): GraphRequest {
    const entryString = raw.entry?.trim();
    const entry = entryString ? EntryReference.parse(entryString) : undefined;
    const baseDirectory = resolve(raw.root ?? process.cwd());
    const absoluteEntry = entry ? (isAbsolute(entry.file) ? entry.file : resolve(baseDirectory, entry.file)) : undefined;
    // Repo map: no --entry, or a --entry that is a directory (no line/symbol anchor and it resolves to a dir).
    const repo = !entry || (entry.line == null && entry.symbol == null && isDirectory(absoluteEntry!));

    if (repo) {
      return {
        repo: true,
        root: entry ? absoluteEntry : raw.root, // a directory --entry IS the root to map; else --root/cwd (GraphCommand detects)
        maxDepth: raw.depth,
        maxFiles: raw.maxFiles,
        includeExternal: raw.includeExternal,
        inheritance: raw.inheritance,
        server: raw.server,
        // meta.args is the only portable record of the invocation — keep every flag that changes the map.
        args: {
          ...(entryString ? { entry: entryString } : {}), ...(raw.root ? { root: raw.root } : {}), ...(raw.server ? { server: raw.server } : {}),
          ...(raw.maxFiles ? { maxFiles: raw.maxFiles } : {}), ...(raw.includeExternal ? { includeExternal: true } : {}),
          ...(raw.inheritance === false ? { inheritance: false } : {}),
        },
      };
    }

    this.#validator.validateGraph({ file: entry!.file, line: entry!.line, column: entry!.column, symbol: entry!.symbol, depth: raw.depth });
    return {
      entry,
      root: raw.root, // optional — GraphCommand auto-detects the project root from the entry when absent
      maxDepth: raw.depth,
      includeExternal: raw.includeExternal,
      server: raw.server,
      args: {
        entry: entryString, ...(raw.root ? { root: raw.root } : {}), ...(raw.server ? { server: raw.server } : {}), depth: raw.depth,
        ...(raw.includeExternal ? { includeExternal: true } : {}),
      },
    };
  }

  /** Normalize a `deps` invocation (a file or directory to walk). */
  acceptDeps(raw: RawDepsInput): DepsRequest {
    this.#validator.requireDepsEntry(raw.entry);
    return {
      entry: raw.entry,
      root: raw.root,
      extensions: raw.extensions,
      tsConfig: raw.tsconfig,
      exclude: raw.exclude,
      args: { entry: raw.entry, ...(raw.root ? { root: raw.root } : {}) },
    };
  }

  /** Normalize a `complexity` invocation (default path: the current directory). No validation gate. */
  acceptComplexity(raw: RawComplexityInput): ComplexityRequest {
    const path = raw.path || ".";
    return { path, root: raw.root, args: { path, ...(raw.root ? { root: raw.root } : {}) } };
  }

  /** Normalize a `symbols` invocation (a single source file to outline). */
  acceptSymbols(raw: RawSymbolsInput): SymbolsRequest {
    this.#validator.requireSymbolsFile(raw.file);
    return { file: raw.file, root: raw.root, args: { file: raw.file, ...(raw.root ? { root: raw.root } : {}) } };
  }
}
