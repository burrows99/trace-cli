import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { Trace, TraceData } from "../../domain/Trace.js";
import { Diagnostic } from "../../domain/Diagnostic.js";
import type { ToolRun } from "../../shared/runTool.js";
import { ShellAnalysisCommand, type AnalysisOutcome, type ToolInvocation } from "./ShellAnalysisCommand.js";

export interface SymbolsRequest {
  file: string;           // a single source file
  root?: string;
  args?: Record<string, unknown>;
}

interface SymbolEntry { name: string; kind: string; loc: { file: string; line: number; col?: number }; }
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
 * SymbolsCommand — the `static symbols` analysis: top-level definitions in a file via `tree-sitter parse`.
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
  protected readonly errorCode = "SYMBOLS_FAILED";
  protected readonly component = "symbols";
  protected override nonZeroIsFailure(): boolean { return false; }

  /** Resolve the request's file against its root (or cwd). */
  #abs(req: SymbolsRequest): string {
    return isAbsolute(req.file) ? req.file : resolve(req.root ?? process.cwd(), req.file);
  }

  protected invocation(req: SymbolsRequest): ToolInvocation {
    return { argv: ["parse", this.#abs(req)], cwd: req.root ?? process.cwd() };
  }

  protected interpret(res: ToolRun, req: SymbolsRequest): AnalysisOutcome {
    let source: string;
    try { source = readFileSync(this.#abs(req), "utf8"); }
    catch (e: any) { throw new Error(`cannot read ${req.file}: ${String(e?.message ?? e).split("\n")[0]}`); }
    const symbols = SymbolsCommand.parseSexp(res.stdout, source, req.file);
    if (!symbols.length && !res.ok) {
      // No symbols and a non-zero exit usually means "no grammar for this file type" or a parse error.
      return { diagnostics: [Diagnostic.error(this.errorCode, res.error || res.stderr.split("\n")[0] || `tree-sitter exited ${res.code}`)] };
    }
    return { data: new TraceData({ symbols: { file: req.file, symbols } as SymbolReport }) };
  }

  /**
   * Parse a `tree-sitter parse` S-expression into definition Symbols. For each definition node we take the
   * first following `name:` identifier field (it precedes nested children in tree-sitter output) and slice the
   * source at that [row,col] span to recover the name. Greedy + line-based — robust for top-level + one level
   * of nesting (a class and its methods), which is what a symbol outline needs.
   */
  static parseSexp(sexp: string, source: string, file: string): SymbolEntry[] {
    const lines = source.split("\n");
    const out: SymbolEntry[] = [];
    let pending: { kind: string; row: number } | null = null;

    for (const raw of sexp.split("\n")) {
      const def = DEF_LINE.exec(raw);
      if (def && DEF_KINDS[def[2]]) { pending = { kind: DEF_KINDS[def[2]], row: Number(def[3]) }; continue; }
      const nm = NAME_LINE.exec(raw);
      if (nm && pending) {
        const row = Number(nm[1]);
        const colStart = Number(nm[2]);
        const colEnd = Number(nm[4]);
        const lineText = lines[row] ?? "";
        const name = Number(nm[3]) === row ? lineText.slice(colStart, colEnd) : lineText.slice(colStart);
        if (name) out.push({ name, kind: pending.kind, loc: { file, line: pending.row + 1, col: colStart } });
        pending = null;
      }
    }
    return out;
  }

  /** Human view: definitions grouped by kind, in source order. */
  render(trace: Trace): string {
    const maybe = trace.data.symbols as SymbolReport | undefined;
    const guard = this.emptyRender(trace, !!maybe?.symbols?.length, "symbols", "no definitions found");
    if (guard !== undefined) return guard;
    const r = maybe!;
    const lines = [`symbols — ${r.symbols.length} definitions in ${r.file}`, ""];
    for (const s of r.symbols) lines.push(`  ${s.kind.padEnd(10)} ${s.name}  :${s.loc.line}`);
    return lines.join("\n");
  }
}
