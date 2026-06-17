import { IsIn, IsString } from "class-validator";

export type DiagnosticLevel = "info" | "warn" | "error";

/** Diagnostic — a structured note attached to a Trace (a warning, an error). */
export class Diagnostic {
  @IsIn(["info", "warn", "error"]) level: DiagnosticLevel;
  @IsString() code: string;
  @IsString() message: string;

  constructor(level: DiagnosticLevel = "info", code = "", message = "") {
    this.level = level;
    this.code = code;
    this.message = message;
  }

  static error(code: string, message: string): Diagnostic { return new Diagnostic("error", code, message); }
  static warn(code: string, message: string): Diagnostic { return new Diagnostic("warn", code, message); }
  static info(code: string, message: string): Diagnostic { return new Diagnostic("info", code, message); }
}
