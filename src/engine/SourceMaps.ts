import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { CdpDriver, ScriptInfo } from "../transport/CdpDriver.js";

const require = createRequire(import.meta.url);
// source-map ships CommonJS; load it through createRequire so it works under NodeNext ESM.
const { SourceMapConsumer } = require("source-map");

export interface GeneratedLocation {
  urlRegex: string;
  lineNumber: number;
  columnNumber: number;
  scriptUrl: string;
  scriptId: string;
  mapped: boolean;
}

/**
 * SourceMaps — resolves source `file:line` ⇄ generated code via whatever maps the CDP target reports.
 * One instance per CDP trace (it caches a SourceMapConsumer per script and holds the `--root`); the driver
 * is injected (DIP). Pure path helpers are static.
 */
export class SourceMaps {
  #consumers = new Map<string, any>();

  constructor(private readonly driver: CdpDriver, private readonly root?: string) {}

  /** The path portion of a script/source URL (no scheme/authority/query). */
  static pathOf(u?: string): string {
    if (!u) return "";
    try { return new URL(u).pathname.replace(/^\/+/, ""); } catch { /* not an absolute URL */ }
    return u.replace(/\\/g, "/").split("?")[0].replace(/^[a-z][\w+.-]*:\/\/+/i, "");
  }

  static #segs(p: string): string[] { return SourceMaps.pathOf(p).split("/").filter((s) => s && s !== "." && s !== ".."); }
  static #baseNoExt(p: string): string { return (SourceMaps.pathOf(p).split("/").pop() || "").replace(/\.[^.]+$/, ""); }

  /** True if the shorter path is a trailing-segment suffix of the longer. */
  static suffixMatch(x: string, y: string): boolean {
    const a = SourceMaps.#segs(x), b = SourceMaps.#segs(y);
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    if (!short.length) return false;
    for (let i = 1; i <= short.length; i++) if (long[long.length - i] !== short[short.length - i]) return false;
    return true;
  }

  /** A setBreakpointByUrl regex matching the script's path (ignoring query). */
  static urlRegexFor(url: string): string {
    return SourceMaps.pathOf(url).replace(/[.+?^${}()|[\]\\]/g, "\\$&") + "(\\?|$)";
  }

  #findMapUnderRoot(scriptUrl?: string): string | null {
    if (!this.root) return null;
    const parts = SourceMaps.pathOf(scriptUrl).split("/").filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const candidate = join(this.root, parts.slice(i).join("/") + ".map");
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  async #rawMapForScript(script?: ScriptInfo): Promise<any> {
    const smu = script?.sourceMapURL;
    if (smu?.startsWith("data:")) {
      try { const [head, data] = smu.split(","); return JSON.parse(/;base64/.test(head) ? Buffer.from(data, "base64").toString() : decodeURIComponent(data)); } catch { /* fall through */ }
    }
    const local = this.#findMapUnderRoot(script?.url);
    if (local) { try { return JSON.parse(readFileSync(local, "utf8")); } catch { /* fall through */ } }
    const tryUrls: string[] = [];
    if (smu && !smu.startsWith("data:")) tryUrls.push(smu);
    if (script?.url) tryUrls.push(script.url.split("?")[0] + ".map");
    for (const u of tryUrls) {
      try {
        const abs = new URL(u, script?.url || "file:///").href;
        if (abs.startsWith("file://")) { const p = fileURLToPath(abs); if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")); }
        else if (/^https?:/.test(abs)) return await (await fetch(abs)).json();
      } catch { /* try next */ }
    }
    return null;
  }

  async #consumerForScript(scriptId: string): Promise<any> {
    if (this.#consumers.has(scriptId)) return this.#consumers.get(scriptId);
    let consumer: any = null;
    try { const raw = await this.#rawMapForScript(this.driver.script(scriptId)); if (raw) consumer = await new SourceMapConsumer(raw); } catch { consumer = null; }
    this.#consumers.set(scriptId, consumer);
    return consumer;
  }

  dispose(): void {
    for (const c of this.#consumers.values()) if (c) { try { c.destroy(); } catch { /* ignore */ } }
    this.#consumers.clear();
  }

  /**
   * Resolve a runtime stack frame (a URL + generated position, as found in `new Error().stack`) back to a
   * `file:line` source location. Used by the non-pausing logpoint path, where the call stack arrives as a
   * stack string rather than CDP `callFrames`. Returns null when the URL matches no parsed script (e.g. a
   * node internal or the injected condition wrapper), so the caller can drop that frame.
   */
  async frameToSource(url: string, line1: number, col0: number): Promise<{ sourceRel: string; line: number } | null> {
    const path = SourceMaps.pathOf(url);
    for (const [scriptId, s] of this.driver.scripts()) {
      if (!s.url) continue;
      if (s.url === url || SourceMaps.pathOf(s.url) === path) {
        const mapped = await this.generatedToSource(scriptId, line1 - 1, col0);
        if (mapped) return mapped;
      }
    }
    return null;
  }

  /** Map a generated frame position back to { sourceRel, line } for display. */
  async generatedToSource(scriptId: string, line0: number, col: number): Promise<{ sourceRel: string; line: number } | null> {
    const url = this.driver.script(scriptId)?.url;
    const c = await this.#consumerForScript(scriptId);
    if (c) {
      const o = c.originalPositionFor({ line: line0 + 1, column: col, bias: SourceMapConsumer.GREATEST_LOWER_BOUND });
      if (o.source != null && o.line != null) return { sourceRel: SourceMaps.pathOf(o.source) || o.source, line: o.line };
    }
    return url ? { sourceRel: SourceMaps.pathOf(url), line: line0 + 1 } : null;
  }

  async #tryMapScript(scriptId: string, s: ScriptInfo, file: string, line: number): Promise<GeneratedLocation | null> {
    const c = await this.#consumerForScript(scriptId);
    if (!c) return null;
    const src = c.sources.find((x: string) => SourceMaps.suffixMatch(x, file));
    if (!src) return null;
    let g = c.generatedPositionFor({ source: src, line, column: 0, bias: SourceMapConsumer.LEAST_UPPER_BOUND });
    if (g.line == null) g = c.generatedPositionFor({ source: src, line, column: 0, bias: SourceMapConsumer.GREATEST_LOWER_BOUND });
    if (g.line == null) return null;
    return { urlRegex: SourceMaps.urlRegexFor(s.url!), lineNumber: g.line - 1, columnNumber: g.column || 0, scriptUrl: s.url!, scriptId, mapped: true };
  }

  /** Resolve source `file:line` to a CDP breakpoint location — mapped scripts FIRST, then direct (plain JS). */
  async findGenerated(file: string, line: number): Promise<GeneratedLocation | null> {
    const bn = SourceMaps.#baseNoExt(file);
    const all = [...this.driver.scripts()];
    const primary = all.filter(([, s]) => s.url && SourceMaps.#baseNoExt(s.url) === bn);
    for (const [scriptId, s] of primary) { const r = await this.#tryMapScript(scriptId, s, file, line); if (r) return r; }
    for (const [scriptId, s] of this.driver.scripts()) {
      if (s.url && SourceMaps.suffixMatch(s.url, file)) {
        return { urlRegex: SourceMaps.urlRegexFor(s.url), lineNumber: line - 1, columnNumber: 0, scriptUrl: s.url, scriptId, mapped: false };
      }
    }
    const seen = new Set(primary.map(([id]) => id));
    for (const [scriptId, s] of all) { if (seen.has(scriptId)) continue; const r = await this.#tryMapScript(scriptId, s, file, line); if (r) return r; }
    return null;
  }
}
