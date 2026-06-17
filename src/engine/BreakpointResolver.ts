import { readFileSync, existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";

export interface BpSpec { file: string; lineSpec: string; }
export interface ResolvedBp extends BpSpec { line: number; raw: string; }

/**
 * BreakpointResolver — turns a `--bp` spec ("file:line" or "file@substring") into a concrete file:line by
 * reading the on-disk source. Pure, stateless (static methods); SRP: spec parsing + line resolution only.
 */
export class BreakpointResolver {
  static parseSpec(spec: string): BpSpec {
    const at = spec.indexOf("@");
    let file: string, lineSpec: string;
    if (at >= 0) { file = spec.slice(0, at); lineSpec = spec.slice(at + 1); }
    else {
      const c = spec.lastIndexOf(":");
      if (c < 0) throw new Error(`bad --bp ${JSON.stringify(spec)} — need file:line or file@substring`);
      file = spec.slice(0, c); lineSpec = spec.slice(c + 1);
    }
    file = file.trim(); lineSpec = lineSpec.trim();
    if (!file || !lineSpec) throw new Error(`bad --bp ${JSON.stringify(spec)} — need file:line or file@substring`);
    return { file, lineSpec };
  }

  static #findLineBySubstring(absFile: string, substr: string): number {
    const lines = readFileSync(absFile, "utf8").split("\n");
    const hits: number[] = [];
    for (let i = 0; i < lines.length; i++) if (lines[i].includes(substr)) hits.push(i + 1);
    if (!hits.length) throw new Error(`no line in ${absFile} contains ${JSON.stringify(substr)}`);
    if (hits.length > 1) throw new Error(`${JSON.stringify(substr)} matches ${hits.length} lines (${hits.join(", ")}) in ${absFile} — be more specific`);
    return hits[0];
  }

  static resolveLine(spec: BpSpec, root?: string): number {
    if (/^\d+$/.test(spec.lineSpec)) return Number(spec.lineSpec);
    const abs = isAbsolute(spec.file) ? spec.file : join(root || process.cwd(), spec.file);
    if (!existsSync(abs)) {
      throw new Error(`--bp "${spec.file}:${spec.lineSpec}" uses a substring but ${abs} is not readable — pass a line number or set --root`);
    }
    return BreakpointResolver.#findLineBySubstring(abs, spec.lineSpec);
  }

  static resolveAll(specs: string[], root?: string): ResolvedBp[] {
    return specs.map((s) => {
      const p = BreakpointResolver.parseSpec(s);
      return { ...p, line: BreakpointResolver.resolveLine(p, root), raw: s };
    });
  }
}
