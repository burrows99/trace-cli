import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { Trace, TraceData } from "../../domain/Trace.js";
import { Diagnostic } from "../../domain/Diagnostic.js";
import { Code } from "../../shared/codes.js";
import type { ToolRun } from "../../shared/runTool.js";
import { ShellAnalysisCommand, type AnalysisOutcome, type ToolInvocation } from "./ShellAnalysisCommand.js";

export interface SymbolsRequest {
  file: string;           // a single source file
  root?: string;
  args?: Record<string, unknown>;
}

interface SymbolEntry { name: string; kind: string; location: { file: string; line: number; column?: number }; }
export interface SymbolReport { file: string; symbols: SymbolEntry[]; }

// tree-sitter node types that name a definition → the kind we report. Covers common JS/TS/Python/Rust/Go/C grammars.
const DEF_KINDS: Record<string, string> = {
  function_declaration: "function", function_definition: "function", function_item: "function",
  generator_function_declaration: "function", method_definition: "method", method_declaration: "method",
  class_declaration: "class", class_definition: "class", class_specifier: "class",
  interface_declaration: "interface", type_alias_declaration: "type", enum_declaration: "enum",
  enum_specifier: "enum", struct_specifier: "struct", struct_item: "struct", impl_item: "impl",
  trait_item: "trait", type_declaration: "type",
};

const DEF_LINE = /^(\s*)\(([a-z_]+)\s+\[(\d+),\s*\d+\]/;
const NAME_LINE = /name:\s*\((?:identifier|type_identifier|property_identifier|field_identifier|constant)\s+\[(\d+),\s*(\d+)\]\s*-\s*\[(\d+),\s*(\d+)\]/;

/**
 * SymbolsCommand — the `symbols` analysis: top-level definitions in a file via `tree-sitter parse`.
 * A {@link ShellAnalysisCommand}: the base owns the run/envelope/failure skeleton; this class supplies the
 * tree-sitter call and the S-expression → Symbol normalization. tree-sitter emits node *types* + positions but
 * not source text, so {@link interpret} re-reads the file and slices each definition's name-identifier span to
 * recover its name. tree-sitter exits non-zero on a missing grammar / parse error rather than a hard crash, so
 * {@link nonZeroIsFailure} is false and only a process that never ran (`code === null`) is fatal; an unreadable
 * file or a non-zero exit with no parseable output degrades to a SYMBOLS_FAILED diagnostic on a well-formed Trace.
 */
export class SymbolsCommand extends ShellAnalysisCommand<SymbolsRequest> {
  protected readonly tool = "tree-sitter";
  protected readonly command = "symbols.tree-sitter";
  protected readonly errorCode = Code.SYMBOLS_FAILED;
  protected readonly component = "symbols";
  protected override nonZeroIsFailure(): boolean { return false; }

  /** Resolve the request's file against its root (or cwd). */
  #abs(request: SymbolsRequest): string {
    return isAbsolute(request.file) ? request.file : resolve(request.root ?? process.cwd(), request.file);
  }

  protected invocation(request: SymbolsRequest): ToolInvocation {
    return { argv: ["parse", this.#abs(request)], cwd: request.root ?? process.cwd() };
  }

  protected interpret(toolRun: ToolRun, request: SymbolsRequest): AnalysisOutcome {
    let source: string;
    try { source = readFileSync(this.#abs(request), "utf8"); }
    catch (error: any) { throw new Error(`cannot read ${request.file}: ${String(error?.message ?? error).split("\n")[0]}`); }
    const symbols = SymbolsCommand.parseSexp(toolRun.stdout, source, request.file);
    if (!symbols.length && !toolRun.ok) {
      // No symbols and a non-zero exit usually means "no grammar for this file type" or a parse error.
      return { diagnostics: [Diagnostic.error(this.errorCode, toolRun.error || toolRun.stderr.split("\n")[0] || `tree-sitter exited ${toolRun.exitCode}`)] };
    }
    return { data: new TraceData({ symbols: { file: request.file, symbols } as SymbolReport }) };
  }

  /**
   * Parse a `tree-sitter parse` S-expression into definition Symbols. For each definition node we take the
   * first following `name:` identifier field (it precedes nested children in tree-sitter output) and slice the
   * source at that [row,column] span to recover the name. Greedy + line-based — robust for top-level + one level
   * of nesting (a class and its methods), which is what a symbol outline needs.
   */
  static parseSexp(sexp: string, source: string, file: string): SymbolEntry[] {
    const lines = source.split("\n");
    const entries: SymbolEntry[] = [];
    let pending: { kind: string; row: number } | null = null;

    for (const rawLine of sexp.split("\n")) {
      const defMatch = DEF_LINE.exec(rawLine);
      if (defMatch && DEF_KINDS[defMatch[2]]) { pending = { kind: DEF_KINDS[defMatch[2]], row: Number(defMatch[3]) }; continue; }
      const nameMatch = NAME_LINE.exec(rawLine);
      if (nameMatch && pending) {
        const nameRow = Number(nameMatch[1]);
        const colStart = Number(nameMatch[2]);
        const colEnd = Number(nameMatch[4]);
        const lineText = lines[nameRow] ?? "";
        const name = Number(nameMatch[3]) === nameRow ? lineText.slice(colStart, colEnd) : lineText.slice(colStart);
        if (name) entries.push({ name, kind: pending.kind, location: { file, line: pending.row + 1, column: colStart } });
        pending = null;
      }
    }
    return entries;
  }

  /** Human view: definitions grouped by kind, in source order. */
  render(trace: Trace): string {
    const maybeReport = trace.data.symbols as SymbolReport | undefined;
    const guard = this.emptyRender(trace, !!maybeReport?.symbols?.length, "symbols", "no definitions found");
    if (guard !== undefined) return guard;
    const report = maybeReport!;
    const lines = [`symbols — ${report.symbols.length} definitions in ${report.file}`, ""];
    for (const symbolEntry of report.symbols) lines.push(`  ${symbolEntry.kind.padEnd(10)} ${symbolEntry.name}  :${symbolEntry.location.line}`);
    return lines.join("\n");
  }
}
