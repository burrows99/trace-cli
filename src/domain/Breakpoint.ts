import { IsBoolean, IsInt, IsOptional, IsString } from "class-validator";

/** Breakpoint — a requested location (`file` + resolved `line`) and whether it bound at the target. */
export class Breakpoint {
  @IsString() file: string;
  @IsOptional() @IsInt() line?: number;
  @IsOptional() @IsBoolean() bound?: boolean;
  @IsOptional() @IsBoolean() mapped?: boolean;
  @IsOptional() @IsString() note?: string;

  constructor(init: Partial<Breakpoint> = {}) {
    this.file = init.file ?? "";
    Object.assign(this, init);
  }
}
