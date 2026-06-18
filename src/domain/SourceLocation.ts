import { IsInt, IsOptional, IsString, Min } from "class-validator";

/**
 * SourceLocation — a source location value object. The shared coordinate used everywhere a breakpoint, a stack frame,
 * or an event points into code. Immutable; constructed via `SourceLocation.parse("file:line")` or the constructor.
 */
export class SourceLocation {
  @IsString() file!: string;
  @IsOptional() @IsInt() @Min(1) line?: number;
  @IsOptional() @IsInt() @Min(0) column?: number;
  @IsOptional() @IsInt() @Min(1) endLine?: number;
  @IsOptional() @IsString() symbol?: string;
  @IsOptional() @IsString() language?: string;

  constructor(file?: string, line?: number, extra: Partial<SourceLocation> = {}) {
    if (file !== undefined) this.file = file;
    if (line !== undefined) this.line = line;
    Object.assign(this, extra);
  }

  /** parse("src/a.ts:42[:column]") → SourceLocation, or undefined for "<native>"/empty. */
  static parse(at: string | null | undefined): SourceLocation | undefined {
    if (!at || at === "<native>") return undefined;
    const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(at);
    if (!match) return new SourceLocation(at);
    return new SourceLocation(match[1], Number(match[2]), match[3] ? { column: Number(match[3]) } : {});
  }
}
