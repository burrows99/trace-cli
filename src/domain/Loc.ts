import { IsInt, IsOptional, IsString, Min } from "class-validator";

/**
 * Loc — a source location value object. The shared coordinate used everywhere a breakpoint, a stack frame,
 * or an event points into code. Immutable; constructed via `Loc.parse("file:line")` or the constructor.
 */
export class Loc {
  @IsString() file!: string;
  @IsOptional() @IsInt() @Min(1) line?: number;
  @IsOptional() @IsInt() @Min(0) col?: number;
  @IsOptional() @IsInt() @Min(1) endLine?: number;
  @IsOptional() @IsString() symbol?: string;
  @IsOptional() @IsString() lang?: string;

  constructor(file?: string, line?: number, extra: Partial<Loc> = {}) {
    if (file !== undefined) this.file = file;
    if (line !== undefined) this.line = line;
    Object.assign(this, extra);
  }

  /** parse("src/a.ts:42[:col]") → Loc, or undefined for "<native>"/empty. */
  static parse(at: string | null | undefined): Loc | undefined {
    if (!at || at === "<native>") return undefined;
    const m = /^(.*?):(\d+)(?::(\d+))?$/.exec(at);
    if (!m) return new Loc(at);
    return new Loc(m[1], Number(m[2]), m[3] ? { col: Number(m[3]) } : {});
  }
}
