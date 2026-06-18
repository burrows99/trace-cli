import { Allow, IsArray, IsInt, IsOptional, IsString, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { Loc } from "./Loc.js";

export type LineageKind = "expr" | "local";

/** One observation of a tracked value at a hit. */
export class LineagePoint {
  @IsInt() seq: number;
  @IsOptional() t?: number | string;
  @IsOptional() @ValidateNested() @Type(() => Loc) loc?: Loc;
  @Allow() value: unknown;
  @IsOptional() changed?: boolean;

  constructor(init: Partial<LineagePoint> = {}) {
    this.seq = init.seq ?? 0;
    Object.assign(this, init);
  }
}

/** Lineage — how one watched value mutated across the event timeline (value-over-time). */
export class Lineage {
  @IsString() name: string;
  @IsString() kind: LineageKind;
  @IsInt() occurrences: number;
  @IsInt() changes: number;
  @IsArray() @ValidateNested({ each: true }) @Type(() => LineagePoint) series: LineagePoint[];

  constructor(init: Partial<Lineage> = {}) {
    this.name = init.name ?? "";
    this.kind = init.kind ?? "local";
    this.occurrences = init.occurrences ?? 0;
    this.changes = init.changes ?? 0;
    this.series = init.series ?? [];
  }
}
