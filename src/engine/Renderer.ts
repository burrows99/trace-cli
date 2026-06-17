import type { Trace } from "../domain/Trace.js";
import type { Lineage } from "../domain/Lineage.js";
import { LineageAnalyzer } from "../analysis/LineageAnalyzer.js";

const fmt = (v: unknown): string => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s == null ? String(v) : s.length > 140 ? s.slice(0, 140) + "…" : s;
};

/** Renderer — turns a Trace into the human-readable execution trace + a mutations summary. */
export class Renderer {
  static render(trace: Trace): string {
    const d = trace.data;
    const L: string[] = [];
    L.push(`\n═══ EXECUTION TRACE [${trace.target?.kind ?? "?"}] · ${trace.meta.at} ═══`);
    if (trace.target?.trigger) L.push(`trigger: ${trace.target.trigger}`);
    const fatal = trace.diagnostics.find((x) => x.code === "ENGINE_FATAL");
    if (fatal) L.push(`FATAL: ${fatal.message}`);
    for (const b of d.breakpoints ?? []) {
      L.push(`bp ${b.bound ? "●" : "○ (not bound" + (b.note ? " — " + b.note : "") + ")"} ${b.file}:${b.line}`);
    }
    if (!(d.events?.length)) L.push(`\n⚠ no breakpoints hit — line(s) not on this path (right target/route? branch not taken? not bound?).`);
    for (const h of d.events ?? []) {
      const a = (h.attrs ?? {}) as { cls?: string; stack?: string[]; locals?: Record<string, unknown>; exprs?: Record<string, unknown> };
      const at = h.loc ? `${h.loc.file}:${h.loc.line ?? ""}` : "";
      L.push(`\n#${h.seq}  +${h.t}ms  ${a.cls ? a.cls + "." : ""}${h.label}  ${at}${String(h.kind).startsWith("step") ? "  [" + h.kind + "]" : ""}`);
      if (a.stack) L.push("   stack: " + a.stack.join("  ←  "));
      for (const [k, v] of Object.entries(a.locals ?? {})) L.push(`   • ${k} = ${fmt(v)}`);
      if (a.exprs) for (const [e, v] of Object.entries(a.exprs)) L.push(`   ⊢ ${e} = ${fmt(v)}`);
    }
    if (d.console?.length) { L.push(`\nconsole (${d.console.length}):`); for (const c of d.console.slice(0, 8)) L.push(`   ${c.type === "error" || c.type === "exception" ? "✗" : "⚠"} [${c.type}] ${c.text}`); }
    if (d.network?.length) { L.push(`\nfailed requests (${d.network.length}):`); for (const n of d.network.slice(0, 8)) L.push(`   ${n.status} ${n.url}`); }
    if (d.response) L.push(`\nresponse: exit ${d.response.exitCode}${d.response.error ? " (" + d.response.error + ")" : ""}${d.response.body ? "  " + d.response.body.split("\n")[0].slice(0, 120) : ""}`);
    if (d.finalUrl) L.push(`\nfinal url: ${d.finalUrl}`);
    if (d.screenshot) L.push(`screenshot → ${d.screenshot}`);
    return L.join("\n");
  }

  static renderLineage(lineage?: Lineage[]): string {
    if (!lineage?.length) return "";
    const L = ["\n── mutations (how values changed as flow continued) ──"];
    for (const tr of lineage) {
      L.push(`   ${tr.kind === "expr" ? "⊢" : "•"} ${tr.name}: ${LineageAnalyzer.summary(tr)}   (${tr.changes} change${tr.changes === 1 ? "" : "s"} / ${tr.occurrences} hits)`);
    }
    return L.join("\n");
  }
}
