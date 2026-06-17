import { Lineage, LineagePoint, type LineageKind } from "../domain/Lineage.js";
import type { TraceEvent } from "../domain/TraceEvent.js";

const norm = (v: unknown): string => { try { return JSON.stringify(v); } catch { return String(v); } };

/**
 * LineageAnalyzer — the normalization tier. Derives mutation lineage (value-over-time) from the event
 * timeline: for every watched expression and local, the ordered series of its values, with each occurrence
 * flagged when it differs from the previous. Drops values that never change (no lineage without flow).
 */
export class LineageAnalyzer {
  static compute(events: TraceEvent[] = []): Lineage[] {
    const tracks = new Map<string, { name: string; kind: LineageKind; series: LineagePoint[] }>();

    for (const e of events) {
      const a = (e.attrs ?? {}) as { exprs?: Record<string, unknown>; locals?: Record<string, unknown> };
      const seen = new Set<string>();
      const record = (name: string, value: unknown, kind: LineageKind) => {
        if (seen.has(name)) return;
        seen.add(name);
        let tr = tracks.get(name);
        if (!tr) { tr = { name, kind, series: [] }; tracks.set(name, tr); }
        const prev = tr.series.length ? tr.series[tr.series.length - 1].value : undefined;
        const changed = tr.series.length > 0 && norm(value) !== norm(prev);
        tr.series.push(new LineagePoint({ seq: e.seq, t: e.t, loc: e.loc, value, changed }));
      };
      for (const [k, v] of Object.entries(a.exprs ?? {})) record(k, v, "expr");
      for (const [k, v] of Object.entries(a.locals ?? {})) record(k, v, "local");
    }

    const out: Lineage[] = [];
    for (const tr of tracks.values()) {
      const changes = tr.series.filter((s) => s.changed).length;
      if (tr.series.length > 1 && changes > 0) {
        out.push(new Lineage({ name: tr.name, kind: tr.kind, occurrences: tr.series.length, changes, series: tr.series }));
      }
    }
    out.sort((x, y) => (x.kind === y.kind ? y.changes - x.changes : x.kind === "expr" ? -1 : 1));
    return out;
  }

  /** "0 → 9.99 → 14.49" — compact value path (transitions only). */
  static summary(track: Lineage, max = 8): string {
    const vals: unknown[] = [];
    for (const s of track.series) if (s.changed || vals.length === 0) vals.push(s.value);
    const shown = vals.slice(0, max).map((v) => (typeof v === "string" ? v : norm(v)));
    return shown.join(" → ") + (vals.length > max ? " → …" : "");
  }
}
