import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { Trace, TraceData } from "../../domain/Trace.js";
import { Diagnostic } from "../../domain/Diagnostic.js";
import { logger } from "../../shared/logger.js";
import { runTool } from "../../shared/runTool.js";
import { TraceCommand } from "./TraceCommand.js";

const log = logger.child({ component: "symbols" });

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
 * tree-sitter emits node *types* + positions but not source text, so we read the file and slice each
 * definition's name-identifier span to recover its name. Each becomes a schema `Symbol` under `data.symbols`.
 * Best-effort + grammar-dependent: when tree-sitter (or the language grammar) is absent, it degrades to a
 * SYMBOLS_FAILED diagnostic on a well-formed Trace.
 */
export class SymbolsCommand extends TraceCommand<SymbolsRequest> {
  async run(req: SymbolsRequest): Promise<Trace> {
    const startedAtMs = this.started();
    const diagnostics: Diagnostic[] = [];
    let data = new TraceData({});

    const root = req.root ?? process.cwd();
    const abs = isAbsolute(req.file) ? req.file : resolve(root, req.file);
    let source: string;
    try {
      source = readFileSync(abs, "utf8");
    } catch (e: any) {
      diagnostics.push(Diagnostic.error("SYMBOLS_FAILED", `cannot read ${req.file}: ${String(e?.message ?? e).split("\n")[0]}`));
      return this.envelope({ command: "symbols.tree-sitter", data, diagnostics, args: req.args ?? {}, startedAtMs });
    }

    const res = await runTool("tree-sitter", ["parse", abs], { cwd: root });
    if (res.code === null) {
      diagnostics.push(Diagnostic.error("SYMBOLS_FAILED", res.error ?? "tree-sitter did not run"));
      log.error("tree-sitter failed", { file: req.file, err: res.error });
    } else {
      const symbols = SymbolsCommand.parseSexp(res.stdout, source, req.file);
      if (!symbols.length && !res.ok) {
        // No symbols and a non-zero exit usually means "no grammar for this file type" or a parse error.
        diagnostics.push(Diagnostic.error("SYMBOLS_FAILED", res.error || res.stderr.split("\n")[0] || `tree-sitter exited ${res.code}`));
      } else {
        data = new TraceData({ symbols: { file: req.file, symbols } as SymbolReport });
      }
    }

    return this.envelope({ command: "symbols.tree-sitter", data, diagnostics, args: req.args ?? {}, startedAtMs });
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
    const r = trace.data.symbols as SymbolReport | undefined;
    if (!r || !r.symbols?.length) {
      const err = trace.diagnostics.find((d) => d.level === "error");
      return err ? `symbols — failed: ${err.message}` : "symbols — no definitions found";
    }
    const lines = [`symbols — ${r.symbols.length} definitions in ${r.file}`, ""];
    for (const s of r.symbols) lines.push(`  ${s.kind.padEnd(10)} ${s.name}  :${s.loc.line}`);
    return lines.join("\n");
  }
}
