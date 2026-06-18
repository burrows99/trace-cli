import { Trace, TraceData } from "../../domain/Trace.js";
import { Diagnostic } from "../../domain/Diagnostic.js";
import type { ToolRun } from "../../shared/runTool.js";
import { ShellAnalysisCommand, type AnalysisOutcome, type ToolInvocation } from "./ShellAnalysisCommand.js";

const CCN_WARN = 15; // lizard's default cyclomatic-complexity threshold

export interface ComplexityRequest {
  path: string;           // file or directory to analyze (default ".")
  root?: string;
  args?: Record<string, unknown>;
}

interface Metric { name: string; value: number; unit?: string; }
interface FnSymbol { name: string; kind: string; loc: { file: string; line?: number; endLine?: number }; metrics: Metric[]; }
export interface ComplexityReport { functions: FnSymbol[]; stats: { functions: number; maxCcn: number; avgCcn: number; overThreshold: number }; }

/**
 * ComplexityCommand — the `static complexity` analysis: per-function cyclomatic complexity via `lizard --csv`.
 * A {@link ShellAnalysisCommand}: the base owns the run/envelope/failure skeleton; this class supplies the
 * lizard call and the CSV → Symbol normalization. Each function becomes a schema `Symbol` carrying `metrics`
 * (ccn/nloc/params/tokens) under `data.complexity`. lizard exits non-zero merely to flag threshold breaches, so
 * {@link nonZeroIsFailure} is false — we parse stdout regardless of exit code and only hard-fail when the
 * process never started (e.g. lizard not installed).
 */
export class ComplexityCommand extends ShellAnalysisCommand<ComplexityRequest> {
  protected readonly tool = "lizard";
  protected readonly command = "complexity.lizard";
  protected readonly errorCode = "COMPLEXITY_FAILED";
  protected readonly component = "complexity";
  protected override nonZeroIsFailure(): boolean { return false; }

  protected invocation(req: ComplexityRequest): ToolInvocation {
    return { argv: ["--csv", req.path], cwd: req.root ?? process.cwd() };
  }

  protected interpret(res: ToolRun): AnalysisOutcome {
    const functions = ComplexityCommand.parseCsv(res.stdout);
    if (!functions.length && !res.ok) {
      // Non-zero exit with nothing parseable — a real error (bad path / unsupported language), not findings.
      return { diagnostics: [Diagnostic.error(this.errorCode, res.error ?? `lizard exited ${res.code} with no parseable output`)] };
    }
    const report = ComplexityCommand.summarize(functions);
    const diagnostics = report.stats.overThreshold
      ? [Diagnostic.warn("COMPLEXITY_HIGH", `${report.stats.overThreshold} function(s) over CCN ${CCN_WARN} (max ${report.stats.maxCcn})`)]
      : [];
    return { data: new TraceData({ complexity: report }), diagnostics };
  }

  /**
   * Parse lizard `--csv` rows into function Symbols. Expected columns: nloc, ccn, token, param, length,
   * location — where location is "name@startLine-endLine@file". Tolerant: skips a header row and any line
   * that doesn't start with a number.
   */
  static parseCsv(csv: string): FnSymbol[] {
    const out: FnSymbol[] = [];
    for (const line of csv.split("\n")) {
      const cols = splitCsv(line);
      if (cols.length < 6) continue;
      const nloc = Number(cols[0]);
      const ccn = Number(cols[1]);
      if (!Number.isFinite(nloc) || !Number.isFinite(ccn)) continue; // header / blank / summary line
      const token = Number(cols[2]);
      const param = Number(cols[3]);
      const { name, file, line: startLine, endLine } = parseLocation(cols[5]);
      out.push({
        name: name || "(anonymous)",
        kind: "function",
        loc: { file, ...(startLine ? { line: startLine } : {}), ...(endLine ? { endLine } : {}) },
        metrics: [
          { name: "ccn", value: ccn },
          { name: "nloc", value: nloc },
          ...(Number.isFinite(param) ? [{ name: "params", value: param }] : []),
          ...(Number.isFinite(token) ? [{ name: "tokens", value: token }] : []),
        ],
      });
    }
    return out;
  }

  static summarize(functions: FnSymbol[]): ComplexityReport {
    const ccns = functions.map((f) => f.metrics.find((m) => m.name === "ccn")?.value ?? 0);
    const maxCcn = ccns.reduce((a, b) => Math.max(a, b), 0);
    const avgCcn = ccns.length ? Math.round((ccns.reduce((a, b) => a + b, 0) / ccns.length) * 10) / 10 : 0;
    const overThreshold = ccns.filter((c) => c > CCN_WARN).length;
    return { functions, stats: { functions: functions.length, maxCcn, avgCcn, overThreshold } };
  }

  /** Human view: functions sorted by CCN (worst first), threshold breaches flagged. */
  render(trace: Trace): string {
    const maybe = trace.data.complexity as ComplexityReport | undefined;
    const guard = this.emptyRender(trace, !!maybe?.functions?.length, "complexity", "no functions found");
    if (guard !== undefined) return guard;
    const r = maybe!;
    const ccn = (f: FnSymbol) => f.metrics.find((m) => m.name === "ccn")?.value ?? 0;
    const sorted = [...r.functions].sort((a, b) => ccn(b) - ccn(a));
    const lines = [`complexity — ${r.stats.functions} functions · max CCN ${r.stats.maxCcn} · avg ${r.stats.avgCcn}` + (r.stats.overThreshold ? ` · ${r.stats.overThreshold} over ${CCN_WARN}` : ""), ""];
    for (const f of sorted.slice(0, 40)) {
      const mark = ccn(f) > CCN_WARN ? "⚠️ " : "   ";
      lines.push(`${mark} CCN ${String(ccn(f)).padStart(3)}  ${f.name}  ${f.loc.file}${f.loc.line ? ":" + f.loc.line : ""}`);
    }
    if (sorted.length > 40) lines.push(`  … ${sorted.length - 40} more`);
    return lines.join("\n");
  }
}

/** Split one CSV line, honoring double-quoted fields (which may contain commas). */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; } // escaped ""
      else inQuotes = !inQuotes;
    } else if (c === "," && !inQuotes) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Parse lizard's location field "name@startLine-endLine@file" → its parts (defensive about missing pieces). */
function parseLocation(loc: string): { name: string; file: string; line?: number; endLine?: number } {
  const parts = (loc ?? "").split("@");
  const name = parts[0] ?? "";
  const range = parts[1] ?? "";
  const file = parts.slice(2).join("@") || (parts.length < 3 ? parts[1] ?? "" : "");
  const [s, e] = range.split("-");
  const line = Number(s);
  const endLine = Number(e);
  return { name, file, ...(Number.isFinite(line) ? { line } : {}), ...(Number.isFinite(endLine) ? { endLine } : {}) };
}
