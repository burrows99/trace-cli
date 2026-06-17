import { IsInt, IsOptional, IsString } from "class-validator";

/** Recording — a trace artifact (the Chrome debug-replay video): a `url` if uploaded, else a local `path`. */
export class Recording {
  @IsOptional() @IsString() url?: string;
  @IsOptional() @IsString() path?: string;
  @IsOptional() @IsInt() bytes?: number;

  constructor(init: Partial<Recording> = {}) {
    Object.assign(this, init);
  }
}
