import "reflect-metadata";
import { instanceToPlain, plainToInstance, Type } from "class-transformer";
import { IsArray, IsBoolean, IsObject, IsOptional, IsString, ValidateNested, validateSync } from "class-validator";

import { Breakpoint } from "./Breakpoint.js";
import { TraceEvent } from "./TraceEvent.js";
import { Lineage } from "./Lineage.js";
import { Recording } from "./Recording.js";
import { Diagnostic } from "./Diagnostic.js";
import type { TargetRef } from "./Target.js";

export class TraceMeta {
  @IsString() at: string;
  @IsOptional() @IsString() sessionId?: string;
  @IsObject() args: Record<string, unknown>;
  @IsOptional() durationMs?: number;
  @IsObject() toolVersions: Record<string, string>;

  constructor(init: Partial<TraceMeta> = {}) {
    this.at = init.at ?? new Date().toISOString();
    this.args = init.args ?? {};
    this.toolVersions = init.toolVersions ?? {};
    Object.assign(this, init);
  }
}

export class CurlResponse {
  @IsOptional() exitCode?: number;
  @IsOptional() @IsString() body?: string;
  @IsOptional() @IsString() stderr?: string;
  @IsOptional() @IsString() error?: string;
  constructor(init: Partial<CurlResponse> = {}) { Object.assign(this, init); }
}

export interface ConsoleLine { type: string; text: string; }
export interface NetworkLine { status: number; url: string; }

/** TraceData — the command-specific payload, composed from domain entities. */
export class TraceData {
  @IsOptional() @IsArray() @Type(() => Breakpoint) breakpoints?: Breakpoint[];
  @IsOptional() @IsArray() @Type(() => TraceEvent) events?: TraceEvent[];
  @IsOptional() @IsArray() @Type(() => Lineage) lineage?: Lineage[];
  @IsOptional() @Type(() => Recording) recording?: Recording;
  @IsOptional() @Type(() => CurlResponse) response?: CurlResponse;
  @IsOptional() console?: ConsoleLine[];
  @IsOptional() network?: NetworkLine[];
  @IsOptional() @IsString() finalUrl?: string;
  @IsOptional() @IsString() screenshot?: string;
  @IsOptional() tools?: unknown[];

  constructor(init: Partial<TraceData> = {}) { Object.assign(this, init); }
}

/**
 * Trace — the aggregate root and the single serialization contract (the "envelope"). Every command produces
 * exactly one Trace; `toJSON()` is the only place that turns the object graph into wire JSON, and
 * `fromPlain()` hydrates it back (used by the collector). SRP: this class owns identity, validity, and
 * serialization of a run — nothing else.
 */
export class Trace {
  readonly tool = "trace" as const;
  @IsString() version: string;
  @IsString() command: string;
  @IsBoolean() ok: boolean;
  @ValidateNested() @Type(() => TraceMeta) meta: TraceMeta;
  @IsOptional() @IsObject() target: TargetRef | null;
  @ValidateNested() @Type(() => TraceData) data: TraceData;
  @IsArray() @ValidateNested({ each: true }) @Type(() => Diagnostic) diagnostics: Diagnostic[];

  // Parameterless-safe: class-transformer's plainToInstance calls `new Trace()` then assigns fields, so no
  // constructor argument may be required. Required-ness is enforced by validate(), not the constructor.
  constructor(init: Partial<Trace> = {}) {
    this.version = init.version ?? "";
    this.command = init.command ?? "";
    this.meta = init.meta ?? new TraceMeta();
    this.target = init.target ?? null;
    this.data = init.data ?? new TraceData();
    this.diagnostics = init.diagnostics ?? [];
    this.ok = init.ok ?? !this.hasErrors();
  }

  hasErrors(): boolean { return this.diagnostics.some((d) => d.level === "error"); }

  /** The single serialization point: object graph → wire JSON envelope. */
  toJSON(): Record<string, unknown> {
    return instanceToPlain(this, { exposeUnsetFields: false });
  }

  /** Structural validation via class-validator. Returns [] when valid. */
  validate(): string[] {
    return validateSync(this).flatMap((e) =>
      Object.values(e.constraints ?? {}).map((m) => `${e.property}: ${m}`),
    );
  }

  /** Hydrate a stored/received plain envelope back into a rich Trace (used by the collector). */
  static fromPlain(plain: Record<string, unknown>): Trace {
    return plainToInstance(Trace, plain);
  }
}
