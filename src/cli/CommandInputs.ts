/**
 * CommandInputs — validated DTOs for the trace-producing CLI commands. Commander coerces flag types and
 * enforces required options; these classes add the strict contract on top (enums, port/positive ranges,
 * array shapes) using the same class-validator regime as the domain envelope. The CLI builds one of these
 * from the parsed flags and rejects the invocation (exit 2) before any tracer/engine work begins.
 */
import { ArrayNotEmpty, IsArray, IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min, ValidateIf } from "class-validator";
import { TargetKind } from "../domain/Target.js";
import { validateStrict } from "../shared/validation.js";
import { STEP_ACTIONS, STEP_ACTIONS_NEEDING_ARG, parseStep } from "../engine/JourneyStep.js";

const MAX_PORT = 65535;

/**
 * Input contract for one chrome journey `--step`. Strict vocabulary: `action` must be a known verb (the agent's
 * full, closed set is {@link STEP_ACTIONS}), and an action that operates on a target (goto/click/type/waitfor/
 * eval) must carry a non-empty `arg`. This is the gate that turns a typo like `--step frobnicate:x` into a
 * clear exit-2 error instead of a silent no-op in the runner's switch.
 */
export class StepInput {
  @IsIn(STEP_ACTIONS as unknown as string[]) action!: string;
  @ValidateIf((o) => STEP_ACTIONS_NEEDING_ARG.has(o.action)) @IsNotEmpty() arg?: string;
  @IsOptional() @IsString() value?: string;

  constructor(init: Partial<StepInput> = {}) { Object.assign(this, init); }

  validate(): string[] { return validateStrict(this); }
}

/**
 * Validate every `--step` string against the vocabulary. Returns [] when all valid, else one line per problem
 * prefixed with the step's index + action — never the raw value, which may carry a typed credential.
 */
export function validateSteps(raw: string[]): string[] {
  const errs: string[] = [];
  raw.forEach((s, i) => {
    const step = parseStep(s);
    const at = `step #${i + 1} (${step.action || "?"})`;
    for (const m of new StepInput(step).validate()) errs.push(`${at}: ${m}`);
    if (step.action === "wait" && step.arg && !/^\d+$/.test(step.arg)) errs.push(`${at}: wait arg must be milliseconds (a positive integer)`);
  });
  return errs;
}

/** Input contract for `trace-cli dynamic`. */
export class DynamicInput {
  @IsIn(Object.values(TargetKind)) target: TargetKind;
  // In Chrome launch mode the port isn't known until the browser is spawned, so only range-check a real port.
  @ValidateIf((o) => !o.launch) @IsInt() @Min(1) @Max(MAX_PORT) port: number;
  @IsOptional() @IsBoolean() launch?: boolean;
  @IsArray() @ArrayNotEmpty() @IsString({ each: true }) breakpoints: string[];
  @IsArray() @IsString({ each: true }) exprs: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) steps?: string[]; // chrome: the ordered UI journey
  @IsOptional() @IsString() curl?: string;

  constructor(init: Partial<DynamicInput> = {}) {
    this.target = init.target ?? TargetKind.Node;
    this.port = init.port ?? 0;
    this.breakpoints = init.breakpoints ?? [];
    this.exprs = init.exprs ?? [];
    Object.assign(this, init);
  }

  validate(): string[] { return validateStrict(this); }
}

/** Input contract for `trace-cli graph`. Requires a file plus an anchor: a line (optional col) or a symbol. */
export class GraphInput {
  @IsString() file: string;
  @ValidateIf((o) => o.symbol === undefined) @IsInt() @Min(1) line?: number;
  @IsOptional() @IsInt() @Min(1) col?: number;
  @IsOptional() @IsString() symbol?: string;
  @IsOptional() @IsString() server?: string;
  @IsOptional() @IsInt() @Min(1) depth?: number;

  constructor(init: Partial<GraphInput> = {}) {
    this.file = init.file ?? "";
    Object.assign(this, init);
  }

  validate(): string[] { return validateStrict(this); }
}
