import { Lineage, LineagePoint, type LineageKind } from "../domain/Lineage.js";
import type { TraceEvent } from "../domain/TraceEvent.js";
import { Analyzer } from "./Analyzer.js";

const norm = (value: unknown): string => { try { return JSON.stringify(value); } catch { return String(value); } };

/**
 * LineageAnalyzer — the runtime-value analysis. An {@link Analyzer} over the captured event timeline: for every
 * watched expression and local, the ordered series of its values, each occurrence flagged when it differs from
 * the previous. Drops values that never change (no lineage without flow). A pure, synchronous in-process
 * transform — TraceEvent[] → Lineage[].
 */
export class LineageAnalyzer extends Analyzer<TraceEvent[], Lineage[]> {
  readonly name = "lineage";

  analyze(events: TraceEvent[] = []): Lineage[] {
    const tracks = new Map<string, { name: string; kind: LineageKind; series: LineagePoint[] }>();

    for (const event of events) {
      const attributes = (event.attributes ?? {}) as { exprs?: Record<string, unknown>; locals?: Record<string, unknown> };
      const seen = new Set<string>();
      const record = (name: string, value: unknown, kind: LineageKind) => {
        if (seen.has(name)) return;
        seen.add(name);
        let track = tracks.get(name);
        if (!track) { track = { name, kind, series: [] }; tracks.set(name, track); }
        const previous = track.series.length ? track.series[track.series.length - 1].value : undefined;
        const changed = track.series.length > 0 && norm(value) !== norm(previous);
        track.series.push(new LineagePoint({ sequence: event.sequence, time: event.time, location: event.location, value, changed }));
      };
      for (const [name, value] of Object.entries(attributes.exprs ?? {})) record(name, value, "expr");
      for (const [name, value] of Object.entries(attributes.locals ?? {})) record(name, value, "local");
    }

    const lineages: Lineage[] = [];
    for (const track of tracks.values()) {
      const changes = track.series.filter((point) => point.changed).length;
      if (track.series.length > 1 && changes > 0) {
        lineages.push(new Lineage({ name: track.name, kind: track.kind, occurrences: track.series.length, changes, series: track.series }));
      }
    }
    lineages.sort((first, second) => (first.kind === second.kind ? second.changes - first.changes : first.kind === "expr" ? -1 : 1));
    return lineages;
  }

  /** "0 → 9.99 → 14.49" — compact value path (transitions only). */
  static summary(track: Lineage, max = 8): string {
    const transitions: unknown[] = [];
    for (const point of track.series) if (point.changed || transitions.length === 0) transitions.push(point.value);
    const shown = transitions.slice(0, max).map((value) => (typeof value === "string" ? value : norm(value)));
    return shown.join(" → ") + (transitions.length > max ? " → …" : "");
  }
}
