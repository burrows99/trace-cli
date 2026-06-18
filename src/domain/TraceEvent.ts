import { IsInt, IsObject, IsOptional, IsString, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { Loc } from "./Loc.js";

export type EventSource = "cdp" | "terminal" | "otel";

/**
 * TraceEvent — the timeline primitive. A CDP breakpoint hit, an OTel span, and a UI action all become
 * TraceEvents on one timeline. `source` + `sessionId` make cross-source correlation expressible.
 */
export class TraceEvent {
  @IsInt() seq: number;
  @IsOptional() t?: number | string;
  @IsString() kind: string;
  @IsOptional() @IsString() label?: string;
  @IsOptional() @IsString() source?: EventSource;
  @IsOptional() @IsString() sessionId?: string;
  @IsOptional() @ValidateNested() @Type(() => Loc) loc?: Loc;
  @IsOptional() @IsObject() attrs?: Record<string, unknown>;
  @IsOptional() @IsString() traceId?: string;
  @IsOptional() @IsString() spanId?: string;
  @IsOptional() @IsString() parentSpanId?: string;

  constructor(init: Partial<TraceEvent> = {}) {
    this.seq = init.seq ?? 0;
    this.kind = init.kind ?? "event";
    Object.assign(this, init);
  }
}
