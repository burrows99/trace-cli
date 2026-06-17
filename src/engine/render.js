// renderTrace(result): the human-readable execution trace (string). Generalized from the original
// engine's emit block — vendor-neutral (no member/auth/login specifics).

export function renderTrace(out) {
  const fmt = (v) => {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s == null ? String(v) : s.length > 140 ? s.slice(0, 140) + "…" : s;
  };
  const L = [];
  L.push(`\n═══ EXECUTION TRACE [${out.meta.target}] · ${out.meta.at} ═══`);
  if (out.meta.trigger) L.push(`trigger: ${out.meta.trigger}`);
  if (out.fatal) L.push(`FATAL: ${out.fatal.split("\n")[0]}`);

  for (const b of out.breakpoints) {
    L.push(`bp ${b.bound ? "●" : "○ (not bound" + (b.note ? " — " + b.note : "") + ")"} ${b.file}:${b.line}`);
  }
  if (!out.hits.length) {
    L.push(`\n⚠ no breakpoints hit — line(s) not on this path (right target/route? branch not taken? not bound?).`);
  }
  for (const h of out.hits) {
    L.push(`\n#${h.seq}  +${h.tMs}ms  ${h.cls ? h.cls + "." : ""}${h.fn}  ${h.at}${h.kind.startsWith("step") ? "  [" + h.kind + "]" : ""}`);
    L.push("   stack: " + h.stack.join("  ←  "));
    for (const [k, v] of Object.entries(h.locals)) L.push(`   • ${k} = ${fmt(v)}`);
    if (h.exprs) for (const [e, v] of Object.entries(h.exprs)) L.push(`   ⊢ ${e} = ${fmt(v)}`);
  }
  if (out.console?.length) {
    L.push(`\nconsole (${out.console.length}):`);
    for (const c of out.console.slice(0, 8)) L.push(`   ${c.type === "error" || c.type === "exception" ? "✗" : "⚠"} [${c.type}] ${c.text}`);
  }
  if (out.network?.length) {
    L.push(`\nfailed requests (${out.network.length}):`);
    for (const n of out.network.slice(0, 8)) L.push(`   ${n.status} ${n.url}`);
  }
  if (out.response) {
    L.push(`\nresponse: exit ${out.response.exitCode}${out.response.error ? " (" + out.response.error + ")" : ""}${out.response.body ? "  " + out.response.body.split("\n")[0].slice(0, 120) : ""}`);
  }
  if (out.finalUrl) L.push(`\nfinal url: ${out.finalUrl}`);
  if (out.screenshot) L.push(`screenshot → ${out.screenshot}`);
  return L.join("\n");
}
