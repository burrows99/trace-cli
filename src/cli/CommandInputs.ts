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
  @IsArray() @IsString({ each: true }) steps: string[];
  @IsOptional() @IsString() curl?: string;
  @IsOptional() @IsString() url?: string;
  @IsOptional() @IsString() root?: string;
  @IsInt() @Min(1) maxHits: number;
  @IsInt() @Min(0) frames: number;
  @IsOptional() @IsInt() @Min(0) timeoutMs?: number;
  @IsOptional() @IsInt() @Min(0) attachTimeoutMs?: number;
  @IsOptional() @IsString() wsUrl?: string;

  constructor(init: Partial<DynamicInput> = {}) {
    this.target = init.target ?? TargetKind.Node;
    this.port = init.port ?? 0;
    this.breakpoints = init.breakpoints ?? [];
    this.exprs = init.exprs ?? [];
    this.steps = init.steps ?? [];
    this.maxHits = init.maxHits ?? 0;
    this.frames = init.frames ?? 0;
    Object.assign(this, init);
  }

  validate(): string[] { return problems(this); }
}

/** Input contract for `trace-cli journey`. `steps` are already-parsed Step objects (non-empty, validated shape). */
export class JourneyInput {
  @IsInt() @Min(1) @Max(MAX_PORT) port: number;
  @IsArray() @ArrayNotEmpty() steps: unknown[];
  @IsArray() @IsString({ each: true }) breakpoints: string[];
  @IsArray() @IsString({ each: true }) exprs: string[];
  @IsOptional() @IsString() out?: string;
  @IsOptional() @IsString() match?: string;
  @IsOptional() @IsString() root?: string;
  @IsOptional() @IsInt() @Min(1) width?: number;
  @IsOptional() @IsInt() @Min(1) height?: number;
  @IsInt() @Min(0) frames: number;

  constructor(init: Partial<JourneyInput> = {}) {
    this.port = init.port ?? 0;
    this.steps = init.steps ?? [];
    this.breakpoints = init.breakpoints ?? [];
    this.exprs = init.exprs ?? [];
    this.frames = init.frames ?? 6;
    Object.assign(this, init);
  }

  validate(): string[] { return problems(this); }
}
