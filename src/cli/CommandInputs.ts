/**
 * CommandInputs — validated DTOs for the trace-producing CLI commands. Commander coerces flag types and
 * enforces required options; these classes add the strict contract on top (enums, port/positive ranges,
 * array shapes) using the same class-validator regime as the domain envelope. The CLI builds one of these
 * from the parsed flags and rejects the invocation (exit 2) before any tracer/engine work begins.
 */
import { ArrayNotEmpty, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min, ValidateIf } from "class-validator";
import { TargetKind } from "../domain/Target.js";
import { validateStrict } from "../shared/validation.js";

const MAX_PORT = 65535;

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
