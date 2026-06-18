/**
 * CommandInputs — validated DTOs for the trace-producing CLI commands. Commander coerces flag types and
 * enforces required options; these classes add the strict contract on top (enums, port/positive ranges,
 * array shapes) using the same class-validator regime as the domain envelope. The CLI builds one of these
 * from the parsed flags and rejects the invocation (exit 2) before any tracer/engine work begins.
 */
import { ArrayNotEmpty, IsArray, IsIn, IsInt, IsOptional, IsString, Max, Min, validateSync } from "class-validator";
import { TargetKind } from "../domain/Target.js";

const MAX_PORT = 65535;

/** Strict validation (whitelist + forbid-non-whitelisted); returns [] when valid, else "field: message" lines. */
function problems(obj: object): string[] {
  return validateSync(obj, { whitelist: true, forbidNonWhitelisted: true }).flatMap((e) =>
    Object.values(e.constraints ?? {}).map((m) => `${e.property}: ${m}`),
  );
}

/** Input contract for `trace-cli dynamic`. */
export class DynamicInput {
  @IsIn(Object.values(TargetKind)) target: TargetKind;
  @IsInt() @Min(1) @Max(MAX_PORT) port: number;
  @IsArray() @ArrayNotEmpty() @IsString({ each: true }) breakpoints: string[];
  @IsArray() @IsString({ each: true }) exprs: string[];
  @IsOptional() @IsString() curl?: string;
  @IsOptional() @IsString() url?: string;

  constructor(init: Partial<DynamicInput> = {}) {
    this.target = init.target ?? TargetKind.Node;
    this.port = init.port ?? 0;
    this.breakpoints = init.breakpoints ?? [];
    this.exprs = init.exprs ?? [];
    Object.assign(this, init);
  }

  validate(): string[] { return problems(this); }
}

/** Input contract for `trace-cli journey`. `steps` are already-parsed Step objects (non-empty). */
export class JourneyInput {
  @IsInt() @Min(1) @Max(MAX_PORT) port: number;
  @IsArray() @ArrayNotEmpty() steps: unknown[];
  @IsOptional() @IsString() out?: string;

  constructor(init: Partial<JourneyInput> = {}) {
    this.port = init.port ?? 0;
    this.steps = init.steps ?? [];
    Object.assign(this, init);
  }

  validate(): string[] { return problems(this); }
}
