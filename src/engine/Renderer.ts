import type { Trace } from "../domain/Trace.js";
import type { Lineage } from "../domain/Lineage.js";
import { LineageAnalyzer } from "../analysis/LineageAnalyzer.js";

const formatValue = (value: unknown): string => {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return serialized == null ? String(value) : serialized.length > 140 ? serialized.slice(0, 140) + "…" : serialized;
};

/** Renderer — turns a Trace into the human-readable execution trace + a mutations summary. */
export class Renderer {
  static render(trace: Trace): string {
    const data = trace.data;
    const lines: string[] = [];
    lines.push(`\n═══ EXECUTION TRACE [${trace.target?.kind ?? "?"}] · ${trace.meta.at} ═══`);
    if (trace.target?.trigger) lines.push(`trigger: ${trace.target.trigger}`);
    const fatal = trace.diagnostics.find((diagnostic) => diagnostic.code === "ENGINE_FATAL");
    if (fatal) lines.push(`FATAL: ${fatal.message}`);
    for (const breakpoint of data.breakpoints ?? []) {
      lines.push(`bp ${breakpoint.bound ? "●" : "○ (not bound" + (breakpoint.note ? " — " + breakpoint.note : "") + ")"} ${breakpoint.file}:${breakpoint.line}`);
    }
    if (!(data.events?.length)) lines.push(`\n⚠ no breakpoints hit — line(s) not on this path (right target/route? branch not taken? not bound?).`);
    for (const event of data.events ?? []) {
      const attributes = (event.attributes ?? {}) as { cls?: string; stack?: string[]; locals?: Record<string, unknown>; exprs?: Record<string, unknown> };
      const locationLabel = event.location ? `${event.location.file}:${event.location.line ?? ""}` : "";
      lines.push(`\n#${event.sequence}  +${event.time}ms  ${attributes.cls ? attributes.cls + "." : ""}${event.label}  ${locationLabel}${String(event.kind).startsWith("step") ? "  [" + event.kind + "]" : ""}`);
      if (attributes.stack) lines.push("   stack: " + attributes.stack.join("  ←  "));
      for (const [name, value] of Object.entries(attributes.locals ?? {})) lines.push(`   • ${name} = ${formatValue(value)}`);
      if (attributes.exprs) for (const [expression, value] of Object.entries(attributes.exprs)) lines.push(`   ⊢ ${expression} = ${formatValue(value)}`);
    }
    if (data.console?.length) { lines.push(`\nconsole (${data.console.length}):`); for (const consoleEntry of data.console.slice(0, 8)) lines.push(`   ${consoleEntry.type === "error" || consoleEntry.type === "exception" ? "✗" : "⚠"} [${consoleEntry.type}] ${consoleEntry.text}`); }
    if (data.network?.length) { lines.push(`\nfailed requests (${data.network.length}):`); for (const request of data.network.slice(0, 8)) lines.push(`   ${request.status} ${request.url}`); }
    if (data.response) lines.push(`\nresponse: exit ${data.response.exitCode}${data.response.error ? " (" + data.response.error + ")" : ""}${data.response.body ? "  " + data.response.body.split("\n")[0].slice(0, 120) : ""}`);
    if (data.finalUrl) lines.push(`\nfinal url: ${data.finalUrl}`);
    if (data.screenshot) lines.push(`screenshot → ${data.screenshot}`);
    return lines.join("\n");
  }

  static renderLineage(lineage?: Lineage[]): string {
    if (!lineage?.length) return "";
    const lines = ["\n── mutations (how values changed as flow continued) ──"];
    for (const mutation of lineage) {
      lines.push(`   ${mutation.kind === "expr" ? "⊢" : "•"} ${mutation.name}: ${LineageAnalyzer.summary(mutation)}   (${mutation.changes} change${mutation.changes === 1 ? "" : "s"} / ${mutation.occurrences} hits)`);
    }
    return lines.join("\n");
  }
}
