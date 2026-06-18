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
  static pathOf(url?: string): string {
    if (!url) return "";
    try { return new URL(url).pathname.replace(/^\/+/, ""); } catch { /* not an absolute URL */ }
    return url.replace(/\\/g, "/").split("?")[0].replace(/^[a-z][\w+.-]*:\/\/+/i, "");
  }

  static #segs(path: string): string[] { return SourceMaps.pathOf(path).split("/").filter((segment) => segment && segment !== "." && segment !== ".."); }
  static #baseNoExt(path: string): string { return (SourceMaps.pathOf(path).split("/").pop() || "").replace(/\.[^.]+$/, ""); }

  /** True if the shorter path is a trailing-segment suffix of the longer. */
  static suffixMatch(pathA: string, pathB: string): boolean {
    const segmentsA = SourceMaps.#segs(pathA), segmentsB = SourceMaps.#segs(pathB);
    const [shorter, longer] = segmentsA.length <= segmentsB.length ? [segmentsA, segmentsB] : [segmentsB, segmentsA];
    if (!shorter.length) return false;
    for (let suffixIndex = 1; suffixIndex <= shorter.length; suffixIndex++) if (longer[longer.length - suffixIndex] !== shorter[shorter.length - suffixIndex]) return false;
    return true;
  }

  /** A setBreakpointByUrl regex matching the script's path (ignoring query). */
  static urlRegexFor(url: string): string {
    return SourceMaps.pathOf(url).replace(/[.+?^${}()|[\]\\]/g, "\\$&") + "(\\?|$)";
  }

  #findMapUnderRoot(scriptUrl?: string): string | null {
    if (!this.root) return null;
    const parts = SourceMaps.pathOf(scriptUrl).split("/").filter(Boolean);
    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const candidate = join(this.root, parts.slice(partIndex).join("/") + ".map");
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  async #rawMapForScript(script?: ScriptInfo): Promise<any> {
    const sourceMapUrl = script?.sourceMapURL;
    if (sourceMapUrl?.startsWith("data:")) {
      try { const [header, data] = sourceMapUrl.split(","); return JSON.parse(/;base64/.test(header) ? Buffer.from(data, "base64").toString() : decodeURIComponent(data)); } catch { /* fall through */ }
    }
    const localMapPath = this.#findMapUnderRoot(script?.url);
    if (localMapPath) { try { return JSON.parse(readFileSync(localMapPath, "utf8")); } catch { /* fall through */ } }
    const candidateUrls: string[] = [];
    if (sourceMapUrl && !sourceMapUrl.startsWith("data:")) candidateUrls.push(sourceMapUrl);
    if (script?.url) candidateUrls.push(script.url.split("?")[0] + ".map");
    for (const candidateUrl of candidateUrls) {
      try {
        const absoluteUrl = new URL(candidateUrl, script?.url || "file:///").href;
        if (absoluteUrl.startsWith("file://")) { const filePath = fileURLToPath(absoluteUrl); if (existsSync(filePath)) return JSON.parse(readFileSync(filePath, "utf8")); }
        else if (/^https?:/.test(absoluteUrl)) return await (await fetch(absoluteUrl)).json();
      } catch { /* try next */ }
    }
    return null;
  }

  async #consumerForScript(scriptId: string): Promise<any> {
    if (this.#consumers.has(scriptId)) return this.#consumers.get(scriptId);
    let consumer: any = null;
    try { const rawMap = await this.#rawMapForScript(this.driver.script(scriptId)); if (rawMap) consumer = await new SourceMapConsumer(rawMap); } catch { consumer = null; }
    this.#consumers.set(scriptId, consumer);
    return consumer;
  }

  dispose(): void {
    for (const consumer of this.#consumers.values()) if (consumer) { try { consumer.destroy(); } catch { /* ignore */ } }
    this.#consumers.clear();
  }

  /**
   * Resolve a runtime stack frame (a URL + generated position, as found in `new Error().stack`) back to a
   * `file:line` source location. Used by the non-pausing logpoint path, where the call stack arrives as a
   * stack string rather than CDP `callFrames`. Returns null when the URL matches no parsed script (e.g. a
   * node internal or the injected condition wrapper), so the caller can drop that frame.
   */
  async frameToSource(url: string, line1: number, column0: number): Promise<{ sourceRel: string; line: number } | null> {
    const path = SourceMaps.pathOf(url);
    for (const [scriptId, script] of this.driver.scripts()) {
      if (!script.url) continue;
      if (script.url === url || SourceMaps.pathOf(script.url) === path) {
        const mapped = await this.generatedToSource(scriptId, line1 - 1, column0);
        if (mapped) return mapped;
      }
    }
    return null;
  }

  /** Map a generated frame position back to { sourceRel, line } for display. */
  async generatedToSource(scriptId: string, line0: number, column: number): Promise<{ sourceRel: string; line: number } | null> {
    const url = this.driver.script(scriptId)?.url;
    const consumer = await this.#consumerForScript(scriptId);
    if (consumer) {
      const originalPosition = consumer.originalPositionFor({ line: line0 + 1, column: column, bias: SourceMapConsumer.GREATEST_LOWER_BOUND });
      if (originalPosition.source != null && originalPosition.line != null) return { sourceRel: SourceMaps.pathOf(originalPosition.source) || originalPosition.source, line: originalPosition.line };
    }
    return url ? { sourceRel: SourceMaps.pathOf(url), line: line0 + 1 } : null;
  }

  async #tryMapScript(scriptId: string, script: ScriptInfo, file: string, line: number): Promise<GeneratedLocation | null> {
    const consumer = await this.#consumerForScript(scriptId);
    if (!consumer) return null;
    const source = consumer.sources.find((candidateSource: string) => SourceMaps.suffixMatch(candidateSource, file));
    if (!source) return null;
    let generatedPosition = consumer.generatedPositionFor({ source, line, column: 0, bias: SourceMapConsumer.LEAST_UPPER_BOUND });
    if (generatedPosition.line == null) generatedPosition = consumer.generatedPositionFor({ source, line, column: 0, bias: SourceMapConsumer.GREATEST_LOWER_BOUND });
    if (generatedPosition.line == null) return null;
    return { urlRegex: SourceMaps.urlRegexFor(script.url!), lineNumber: generatedPosition.line - 1, columnNumber: generatedPosition.column || 0, scriptUrl: script.url!, scriptId, mapped: true };
  }

  /** Resolve source `file:line` to a CDP breakpoint location — mapped scripts FIRST, then direct (plain JS). */
  async findGenerated(file: string, line: number): Promise<GeneratedLocation | null> {
    const baseName = SourceMaps.#baseNoExt(file);
    const allScripts = [...this.driver.scripts()];
    const primaryScripts = allScripts.filter(([, script]) => script.url && SourceMaps.#baseNoExt(script.url) === baseName);
    for (const [scriptId, script] of primaryScripts) { const mapped = await this.#tryMapScript(scriptId, script, file, line); if (mapped) return mapped; }
    for (const [scriptId, script] of this.driver.scripts()) {
      if (script.url && SourceMaps.suffixMatch(script.url, file)) {
        return { urlRegex: SourceMaps.urlRegexFor(script.url), lineNumber: line - 1, columnNumber: 0, scriptUrl: script.url, scriptId, mapped: false };
      }
    }
    const seenScriptIds = new Set(primaryScripts.map(([scriptId]) => scriptId));
    for (const [scriptId, script] of allScripts) { if (seenScriptIds.has(scriptId)) continue; const mapped = await this.#tryMapScript(scriptId, script, file, line); if (mapped) return mapped; }
    return null;
  }
}
