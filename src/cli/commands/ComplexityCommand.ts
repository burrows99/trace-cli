import { Trace, TraceData } from "../../domain/Trace.js";
import { Diagnostic } from "../../domain/Diagnostic.js";
import { Code } from "../../shared/codes.js";
import type { ToolRun } from "../../shared/runTool.js";
import { ShellAnalysisCommand, type AnalysisOutcome, type ToolInvocation } from "./ShellAnalysisCommand.js";

const CCN_WARN = 15; // lizard's default cyclomatic-complexity threshold

export interface ComplexityRequest {
  path: string;           // file or directory to analyze (default ".")
  root?: string;
  args?: Record<string, unknown>;
}

interface Metric { name: string; value: number; unit?: string; }
interface FunctionSymbol { name: string; kind: string; location: { file: string; line?: number; endLine?: number }; metrics: Metric[]; }
export interface ComplexityReport { functions: FunctionSymbol[]; stats: { functions: number; maxCcn: number; avgCcn: number; overThreshold: number }; }

/**
 * ComplexityCommand — the `complexity` analysis: per-function cyclomatic complexity via `lizard --csv`.
 * A {@link ShellAnalysisCommand}: the base owns the run/envelope/failure skeleton; this class supplies the
 * lizard call and the CSV → Symbol normalization. Each function becomes a schema `Symbol` carrying `metrics`
 * (ccn/nloc/params/tokens) under `data.complexity`. lizard exits non-zero merely to flag threshold breaches, so
 * {@link nonZeroIsFailure} is false — we parse stdout regardless of exit code and only hard-fail when the
 * process never started (e.g. lizard not installed).
 */
export class ComplexityCommand extends ShellAnalysisCommand<ComplexityRequest> {
  protected readonly tool = "lizard";
  protected readonly command = "complexity.lizard";
  protected readonly errorCode = Code.COMPLEXITY_FAILED;
  protected readonly component = "complexity";
  protected override nonZeroIsFailure(): boolean { return false; }

  protected invocation(request: ComplexityRequest): ToolInvocation {
    return { argv: ["--csv", request.path], cwd: request.root ?? process.cwd() };
  }

  protected interpret(toolRun: ToolRun): AnalysisOutcome {
    const functions = ComplexityCommand.parseCsv(toolRun.stdout);
    if (!functions.length && !toolRun.ok) {
      // Non-zero exit with nothing parseable — a real error (bad path / unsupported language), not findings.
      return { diagnostics: [Diagnostic.error(this.errorCode, toolRun.error ?? `lizard exited ${toolRun.exitCode} with no parseable output`)] };
    }
    const report = ComplexityCommand.summarize(functions);
    const diagnostics = report.stats.overThreshold
      ? [Diagnostic.warn(Code.COMPLEXITY_HIGH, `${report.stats.overThreshold} function(s) over CCN ${CCN_WARN} (max ${report.stats.maxCcn})`)]
      : [];
    return { data: new TraceData({ complexity: report }), diagnostics };
  }

  /**
   * Parse lizard `--csv` rows into function Symbols. Expected columns: nloc, ccn, token, param, length,
   * location — where location is "name@startLine-endLine@file". Tolerant: skips a header row and any line
   * that doesn't start with a number.
   */
  static parseCsv(csv: string): FunctionSymbol[] {
    const functionSymbols: FunctionSymbol[] = [];
    for (const line of csv.split("\n")) {
      const columns = splitCsv(line);
      if (columns.length < 6) continue;
      const nloc = Number(columns[0]);
      const cyclomaticComplexity = Number(columns[1]);
      if (!Number.isFinite(nloc) || !Number.isFinite(cyclomaticComplexity)) continue; // header / blank / summary line
      const tokenCount = Number(columns[2]);
      const parameterCount = Number(columns[3]);
      const { name, file, line: startLine, endLine } = parseLocation(columns[5]);
      functionSymbols.push({
        name: name || "(anonymous)",
        kind: "function",
        location: { file, ...(startLine ? { line: startLine } : {}), ...(endLine ? { endLine } : {}) },
        metrics: [
          { name: "ccn", value: cyclomaticComplexity },
          { name: "nloc", value: nloc },
          ...(Number.isFinite(parameterCount) ? [{ name: "params", value: parameterCount }] : []),
          ...(Number.isFinite(tokenCount) ? [{ name: "tokens", value: tokenCount }] : []),
        ],
      });
    }
    return functionSymbols;
  }

  static summarize(functions: FunctionSymbol[]): ComplexityReport {
    const complexityValues = functions.map((functionSymbol) => functionSymbol.metrics.find((metric) => metric.name === "ccn")?.value ?? 0);
    const maxCcn = complexityValues.reduce((max, value) => Math.max(max, value), 0);
    const avgCcn = complexityValues.length ? Math.round((complexityValues.reduce((sum, value) => sum + value, 0) / complexityValues.length) * 10) / 10 : 0;
    const overThreshold = complexityValues.filter((complexityValue) => complexityValue > CCN_WARN).length;
    return { functions, stats: { functions: functions.length, maxCcn, avgCcn, overThreshold } };
  }

  /** Human view: functions sorted by CCN (worst first), threshold breaches flagged. */
  render(trace: Trace): string {
    const maybeReport = trace.data.complexity as ComplexityReport | undefined;
    const guard = this.emptyRender(trace, !!maybeReport?.functions?.length, "complexity", "no functions found");
    if (guard !== undefined) return guard;
    const report = maybeReport!;
    const cyclomaticComplexityOf = (functionSymbol: FunctionSymbol) => functionSymbol.metrics.find((metric) => metric.name === "ccn")?.value ?? 0;
    const sorted = [...report.functions].sort((first, second) => cyclomaticComplexityOf(second) - cyclomaticComplexityOf(first));
    const lines = [`complexity — ${report.stats.functions} functions · max CCN ${report.stats.maxCcn} · avg ${report.stats.avgCcn}` + (report.stats.overThreshold ? ` · ${report.stats.overThreshold} over ${CCN_WARN}` : ""), ""];
    for (const functionSymbol of sorted.slice(0, 40)) {
      const mark = cyclomaticComplexityOf(functionSymbol) > CCN_WARN ? "⚠️ " : "   ";
      lines.push(`${mark} CCN ${String(cyclomaticComplexityOf(functionSymbol)).padStart(3)}  ${functionSymbol.name}  ${functionSymbol.location.file}${functionSymbol.location.line ? ":" + functionSymbol.location.line : ""}`);
    }
    if (sorted.length > 40) lines.push(`  … ${sorted.length - 40} more`);
    return lines.join("\n");
  }
}

/** Split one CSV line, honoring double-quoted fields (which may contain commas). */
function splitCsv(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === '"') {
      if (inQuotes && line[index + 1] === '"') { field += '"'; index++; } // escaped ""
      else inQuotes = !inQuotes;
    } else if (character === "," && !inQuotes) { fields.push(field); field = ""; }
    else field += character;
  }
  fields.push(field);
  return fields.map((rawField) => rawField.trim());
}

/** Parse lizard's location field "name@startLine-endLine@file" → its parts (defensive about missing pieces). */
function parseLocation(location: string): { name: string; file: string; line?: number; endLine?: number } {
  const parts = (location ?? "").split("@");
  const name = parts[0] ?? "";
  const range = parts[1] ?? "";
  const file = parts.slice(2).join("@") || (parts.length < 3 ? parts[1] ?? "" : "");
  const [startText, endText] = range.split("-");
  const line = Number(startText);
  const endLine = Number(endText);
  return { name, file, ...(Number.isFinite(line) ? { line } : {}), ...(Number.isFinite(endLine) ? { endLine } : {}) };
}
