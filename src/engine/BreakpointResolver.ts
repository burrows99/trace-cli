import { readFileSync, existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";

export interface BreakpointSpec { file: string; lineSpec: string; }
export interface ResolvedBreakpoint extends BreakpointSpec { line: number; raw: string; }

/**
 * BreakpointResolver — turns a `--breakpoint` spec ("file:line" or "file@substring") into a concrete file:line by
 * reading the on-disk source. Pure, stateless (static methods); SRP: spec parsing + line resolution only.
 */
export class BreakpointResolver {
  static parseSpec(spec: string): BreakpointSpec {
    const atIndex = spec.indexOf("@");
    let file: string, lineSpec: string;
    if (atIndex >= 0) { file = spec.slice(0, atIndex); lineSpec = spec.slice(atIndex + 1); }
    else {
      const colonIndex = spec.lastIndexOf(":");
      if (colonIndex < 0) throw new Error(`bad --breakpoint ${JSON.stringify(spec)} — need file:line or file@substring`);
      file = spec.slice(0, colonIndex); lineSpec = spec.slice(colonIndex + 1);
    }
    file = file.trim(); lineSpec = lineSpec.trim();
    if (!file || !lineSpec) throw new Error(`bad --breakpoint ${JSON.stringify(spec)} — need file:line or file@substring`);
    return { file, lineSpec };
  }

  static #findLineBySubstring(absoluteFile: string, substring: string): number {
    const lines = readFileSync(absoluteFile, "utf8").split("\n");
    const matchingLineNumbers: number[] = [];
    for (let index = 0; index < lines.length; index++) if (lines[index].includes(substring)) matchingLineNumbers.push(index + 1);
    if (!matchingLineNumbers.length) throw new Error(`no line in ${absoluteFile} contains ${JSON.stringify(substring)}`);
    if (matchingLineNumbers.length > 1) throw new Error(`${JSON.stringify(substring)} matches ${matchingLineNumbers.length} lines (${matchingLineNumbers.join(", ")}) in ${absoluteFile} — be more specific`);
    return matchingLineNumbers[0];
  }

  static resolveLine(spec: BreakpointSpec, root?: string): number {
    if (/^\d+$/.test(spec.lineSpec)) return Number(spec.lineSpec);
    const absolutePath = isAbsolute(spec.file) ? spec.file : join(root || process.cwd(), spec.file);
    if (!existsSync(absolutePath)) {
      throw new Error(`--breakpoint "${spec.file}:${spec.lineSpec}" uses a substring but ${absolutePath} is not readable — pass a line number or set --root`);
    }
    return BreakpointResolver.#findLineBySubstring(absolutePath, spec.lineSpec);
  }

  static resolveAll(specs: string[], root?: string): ResolvedBreakpoint[] {
    return specs.map((rawSpec) => {
      const parsedSpec = BreakpointResolver.parseSpec(rawSpec);
      return { ...parsedSpec, line: BreakpointResolver.resolveLine(parsedSpec, root), raw: rawSpec };
    });
  }
}
