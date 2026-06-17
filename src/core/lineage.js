// Normalization tier (core/) — derived views computed over the Event timeline, not captured by any single
// collector. This is where "a deterministic execution recorder" beats "an event dump": debugging is one
// query mode over the dataset; mutation lineage is another.
//
// computeLineage(events) answers "how did this value change as flow continued?" — for every watched
// expression and local, the ordered series of its values across hits, with each occurrence marked when it
// differs from the previous one (a mutation). Names that never change (a single static value) are dropped,
// so what surfaces is exactly the data that moved.

const norm = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };

// computeLineage(events) → [{ name, kind, occurrences, changes, series: [{ seq, t, loc, value, changed }] }]
// sorted watched-exprs first, then by how much they mutated. Returns [] when nothing mutates (e.g. a
// single-hit trace) — there's no lineage without flow.
export function computeLineage(events = []) {
  const tracks = new Map(); // name → { name, kind, series }

  for (const e of events) {
    const a = e.attrs || {};
    const seen = new Set();
    const record = (name, value, kind) => {
      if (seen.has(name)) return;     // one occurrence per name per event — expr wins (recorded first)
      seen.add(name);
      let tr = tracks.get(name);
      if (!tr) { tr = { name, kind, series: [] }; tracks.set(name, tr); }
      const prev = tr.series.length ? tr.series[tr.series.length - 1].value : undefined;
      const changed = tr.series.length > 0 && norm(value) !== norm(prev);
      tr.series.push({ seq: e.seq, t: e.t, loc: e.loc, value, changed });
    };
    // watched expressions are the explicit "track this" signal — record them before locals.
    for (const [k, v] of Object.entries(a.exprs || {})) record(k, v, "expr");
    for (const [k, v] of Object.entries(a.locals || {})) record(k, v, "local");
  }

  const out = [];
  for (const tr of tracks.values()) {
    const changes = tr.series.filter((s) => s.changed).length;
    if (tr.series.length > 1 && changes > 0) out.push({ ...tr, occurrences: tr.series.length, changes });
  }
  out.sort((x, y) => (x.kind === y.kind ? y.changes - x.changes : x.kind === "expr" ? -1 : 1));
  return out;
}

// lineageSummary(track) → "0 → 9.99 → 19.98 → …" compact value path (deduped to transitions).
export function lineageSummary(track, max = 8) {
  const vals = [];
  for (const s of track.series) if (s.changed || vals.length === 0) vals.push(s.value);
  const shown = vals.slice(0, max).map((v) => (typeof v === "string" ? v : norm(v)));
  return shown.join(" → ") + (vals.length > max ? " → …" : "");
}
