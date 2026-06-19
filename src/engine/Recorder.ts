import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpDriver } from "../transport/CdpDriver.js";
import { Cdp } from "../transport/cdp.js";
import { ChromeLauncher } from "./ChromeLauncher.js";
import { ffmpeg, concatInput, h264Mp4, FRAMES_LIST_FILE } from "./ffmpeg.js";
import type { TraceEvent } from "../domain/TraceEvent.js";
import { sleep } from "../shared/sleep.js";

const OUTPUT_WIDTH = 1360, OUTPUT_HEIGHT = 860;

/**
 * Demo pacing — the replay's length is *designed*, not an accident of how many frames Chrome happened to
 * paint. The timeline is built from breakpoint HITS (the story), each held long enough to read its
 * stack/locals/watch, framed by a lead-in title and a closing summary. A single static navigation and a
 * twelve-step journey both land a clip in this band.
 */
const TARGET = { min: 16, max: 24 };          // seconds
const LEAD_IN = 2.4, TAIL = 3.4;              // title card / closing summary, seconds
const DWELL = { min: 1.4, max: 3.4 };         // per-hit on-screen time, clamped so the total lands in TARGET
const MAX_HITS = 14;                          // a long journey is downsampled to this many readable beats (endpoints kept)
const FRAME_BIAS_MS = 320;                    // a hit computes just *before* React paints; bias frame-matching forward so the beat shows the rendered result, not the pre-paint blank

/**
 * Screen-capture viewport for the journey screencast. Sized to the replay's *left pane* (≈50% of OUTPUT_WIDTH,
 * full content height) so the live screen fills the pane instead of letterboxing into black bands — the
 * Screencaster reads this so capture and composition agree. A checkout-style page renders fine narrow.
 */
export const CAPTURE_VIEWPORT = { width: 760, height: 880 } as const;

const escapeHtml = (value: unknown) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const oneLine = (value: unknown) => { const serialized = typeof value === "string" ? value : JSON.stringify(value); return (serialized == null ? String(value) : serialized).replace(/\s+/g, " ").slice(0, 200); };
const locStr = (event: TraceEvent) => (event.location ? `${event.location.file}:${event.location.line ?? ""}` : "");
const attrsOf = (event: TraceEvent) => (event.attributes ?? {}) as { cls?: string; stack?: string[]; locals?: Record<string, unknown>; exprs?: Record<string, unknown> };
const labelOf = (event: TraceEvent) => `${attrsOf(event).cls ? attrsOf(event).cls + "." : ""}${event.label ?? ""}`;
const isNoise = (frame: string) => /node_modules|react-dom|\/cjs\/|internal\/|webpack|vite/.test(frame);   // framework frames, dimmed
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

interface Hit { ev: TraceEvent; t: number; }
interface Scene { kind: "intro" | "hit" | "tail"; frame: Buffer; event: TraceEvent | null; hold: number; idx?: number; of?: number; note?: string; }

const STYLE = `*{margin:0;box-sizing:border-box}
html,body{width:${OUTPUT_WIDTH}px;height:${OUTPUT_HEIGHT}px;background:#0b1220;color:#e6edf3;font:15px/1.6 ui-monospace,Menlo,Consolas,monospace;overflow:hidden}
.root{display:flex;flex-direction:column;height:100%}
.row{display:flex;flex:1;min-height:0}
.left{width:50%;background:#06080f;display:flex;align-items:center;justify-content:center;border-right:2px solid #1b2740;overflow:hidden}
.app{width:100%;height:100%;object-fit:contain}
.panel{flex:1;padding:26px 30px;overflow:hidden;display:flex;flex-direction:column}
.eyebrow{color:#8b949e;text-transform:uppercase;font-size:11px;letter-spacing:.14em;margin-bottom:14px}
.hdr{font-size:22px;font-weight:700;color:#7ee787}
.step{float:right;color:#8b949e;font-size:13px;font-weight:400}
.location{color:#79c0ff;margin:6px 0 14px;font-size:15px}
.sec{color:#8b949e;margin:16px 0 5px;text-transform:uppercase;font-size:11px;letter-spacing:.08em}
.fr{color:#c9d1d9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px}
.fr.dim{color:#586069}
.kv{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin:1px 0}
.k{color:#ffa657}.v{color:#a5d6ff}.expr .k{color:#d2a8ff}.expr{font-size:15px}
.cap{background:#101828;border-top:3px solid #44646b;padding:14px 22px;font-size:18px;font-weight:600;text-align:center;color:#fff;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
.center{flex:1;display:flex;flex-direction:column;justify-content:center}
.title{font-size:30px;font-weight:800;color:#fff;line-height:1.25;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin-bottom:16px}
.lead{color:#9da7b3;font-size:16px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
.target{margin-top:22px;padding:14px 16px;background:#0d1526;border:1px solid #1b2740;border-radius:8px}
.target .k{color:#79c0ff}
.story{margin-top:16px;font-size:18px;color:#ffa657}
.story b{color:#fff}
.found .hdr{color:#f0883e}`;

/**
 * Recorder — composes the Chrome debug-replay mp4: the live screen on the left, the active breakpoint's
 * stack/locals/watch on the right. Frames are rendered as HTML in a headless Chrome, then stitched with
 * ffmpeg. The timeline is hit-driven (see {@link renderJourney}), so the clip is reliably long enough to
 * follow the bug rather than collapsing to whatever Chrome painted.
 */
export class Recorder {
  /** Bottom-bar caption for a scene. */
  static #caption(scene: Scene): string {
    if (scene.kind === "intro") return "trace-cli — recording debug replay";
    if (scene.kind === "tail") return scene.note ?? "trace complete";
    const event = scene.event!;
    return `#${event.sequence}  ${labelOf(event)}  ${locStr(event)}  ·  hit ${scene.idx}/${scene.of}`;
  }

  static async #renderFrame(driver: CdpDriver, html: string, outputPath: string): Promise<void> {
    await driver.send(Cdp.Page.navigate, { url: "data:text/html;base64," + Buffer.from(html).toString("base64") });
    await sleep(220);
    const screenshot = await driver.send(Cdp.Page.captureScreenshot, { format: "png" });
    writeFileSync(outputPath, Buffer.from(screenshot.data, "base64"));
  }

  /** A breakpoint-hit beat: the screen as it looked when the hit fired, beside that hit's stack/locals/watch. */
  static #hitHtml(scene: Scene): string {
    const event = scene.event!, attributes = attrsOf(event);
    const stack = (attributes.stack || []).map((frame) => `<div class="fr${isNoise(frame) ? " dim" : ""}">${escapeHtml(frame)}</div>`).join("");
    const locals = Object.entries(attributes.locals || {}).map(([name, value]) => `<div class=kv><span class=k>${escapeHtml(name)}</span> = <span class=v>${escapeHtml(oneLine(value))}</span></div>`).join("");
    const exprs = Object.entries(attributes.exprs || {}).map(([expression, value]) => `<div class="kv expr">⊢ <span class=k>${escapeHtml(expression)}</span> = <span class=v>${escapeHtml(oneLine(value))}</span></div>`).join("");
    return `<div class=panel>
      <div class=hdr>#${event.sequence} &nbsp; +${event.time}ms<span class=step>hit ${scene.idx} / ${scene.of}</span></div>
      <div class=location>${escapeHtml(labelOf(event))} &nbsp;@ ${escapeHtml(locStr(event))}</div>
      <div class=sec>call stack</div>${stack}
      ${locals ? `<div class=sec>locals</div>${locals}` : ""}
      ${exprs ? `<div class=sec>watch</div>${exprs}` : ""}
    </div>`;
  }

  /** Lead-in title card: what this replay is chasing, derived from the first hit. */
  static #introHtml(first: TraceEvent | null): string {
    const target = first ? `<div class=target><span class=k>breakpoint</span> &nbsp;${escapeHtml(locStr(first))}<br><span class=k>in</span> &nbsp;${escapeHtml(labelOf(first))}</div>` : "";
    return `<div class=panel><div class=center>
      <div class=eyebrow>trace-cli · live debug replay</div>
      <div class=title>Watching the bug<br>happen, line by line.</div>
      <div class=lead>Breakpoints capture every hit's call stack, locals and watched expressions — without pausing the app — and lay them beside the live screen.</div>
      ${target}
    </div></div>`;
  }

  /** Closing card: the captured progression of the most telling watched value, e.g. "sum: 0 → 19 → 43". */
  static #tailHtml(last: TraceEvent | null, hits: Hit[], total: number): string {
    const story = Recorder.#progression(hits);
    const where = last ? `${labelOf(last)} @ ${locStr(last)}` : "";
    return `<div class="panel found"><div class=center>
      <div class=eyebrow>trace complete</div>
      <div class=hdr>${total} breakpoint hit${total === 1 ? "" : "s"} captured</div>
      ${where ? `<div class=location>${escapeHtml(where)}</div>` : ""}
      ${story ? `<div class=story>${escapeHtml(story.key)}: <b>${escapeHtml(story.path)}</b></div>` : ""}
      <div class=lead style="margin-top:18px">Every hit, in order, with full state — one JSON envelope an agent can read and re-aim.</div>
    </div></div>`;
  }

  /** Pick the watched expression (else local) that changes the most across hits, and trace its value path. */
  static #progression(hits: Hit[]): { key: string; path: string } | null {
    if (!hits.length) return null;
    const valuesOf = (event: TraceEvent) => { const attributes = attrsOf(event); return { ...(attributes.exprs || {}), ...(attributes.locals || {}) }; };
    let best: { key: string; path: string; distinct: number } | null = null;
    for (const key of Object.keys(valuesOf(hits[0].ev))) {
      const sequence = hits.map((hit) => oneLine(valuesOf(hit.ev)[key]));
      const collapsed = sequence.filter((value, index) => index === 0 || value !== sequence[index - 1]);   // drop consecutive repeats
      const distinct = new Set(sequence).size;
      // Keep the climax: if there are many steps, elide the middle so the path still ends on the final value.
      const path = collapsed.length > 7 ? [...collapsed.slice(0, 4), "…", collapsed[collapsed.length - 1]].join(" → ") : collapsed.join(" → ");
      if (distinct > 1 && (!best || distinct > best.distinct)) best = { key, path, distinct };
    }
    return best && { key: best.key, path: best.path };
  }

  static #sceneHtml(scene: Scene, first: TraceEvent | null, hits: Hit[], total: number): string {
    const left = `<img class=app src="data:image/jpeg;base64,${scene.frame.toString("base64")}">`;
    const right = scene.kind === "intro" ? Recorder.#introHtml(first)
      : scene.kind === "tail" ? Recorder.#tailHtml(scene.event, hits, total)
      : Recorder.#hitHtml(scene);
    return `<!doctype html><meta charset=utf8><style>${STYLE}</style><div class=root>
      <div class=row><div class=left>${left}</div>${right}</div>
      <div class=cap>${escapeHtml(Recorder.#caption(scene))}</div>
    </div>`;
  }

  /** Evenly sample `count` items from `list`, always keeping the first and last. */
  static #sample<T>(list: T[], count: number): T[] {
    if (list.length <= count) return list;
    return Array.from({ length: count }, (_, index) => list[Math.round((index * (list.length - 1)) / (count - 1))]);
  }

  /**
   * Build the designed timeline: a lead-in title, one held beat per breakpoint hit (the screen as it looked
   * when the hit fired, beside that hit's panel), and a closing summary. Per-hit dwell is chosen so the total
   * lands in {@link TARGET}; a sparse trace pads its tail to the floor, a long journey is downsampled to
   * {@link MAX_HITS} readable beats. With no hits at all, it falls back to a few motion frames.
   */
  static #buildScenes(frames: { data: Buffer; t: number }[], traced: Hit[]): { scenes: Scene[]; first: TraceEvent | null; hits: Hit[]; total: number } {
    const sorted = [...traced].sort((a, b) => a.t - b.t);
    const nearest = (t: number) => frames.reduce((best, frame) => (Math.abs(frame.t - t) < Math.abs(best.t - t) ? frame : best), frames[0]);
    const firstFrame = frames[0], lastFrame = frames[frames.length - 1];

    if (!sorted.length) {
      // No breakpoint hits — still show the screen rather than nothing: sample motion frames across the run.
      const motion = Recorder.#sample(frames, 10);
      const hold = clamp((TARGET.min - LEAD_IN - TAIL) / Math.max(1, motion.length), 0.4, 2);
      const scenes: Scene[] = [{ kind: "intro", frame: firstFrame.data, event: null, hold: LEAD_IN }];
      motion.forEach((frame) => scenes.push({ kind: "hit", frame: frame.data, event: null, hold }));
      scenes.push({ kind: "tail", frame: lastFrame.data, event: null, hold: TAIL, note: "trace complete — no breakpoint hits" });
      return { scenes, first: null, hits: [], total: 0 };
    }

    const hits = Recorder.#sample(sorted, MAX_HITS);
    const body = (TARGET.min + TARGET.max) / 2 - LEAD_IN - TAIL;
    const dwell = clamp(body / hits.length, DWELL.min, DWELL.max);
    let tail = TAIL;
    const total = LEAD_IN + tail + dwell * hits.length;
    if (total < TARGET.min) tail += TARGET.min - total;   // sparse trace: hold the final state longer

    const scenes: Scene[] = [{ kind: "intro", frame: firstFrame.data, event: null, hold: LEAD_IN }];
    hits.forEach((hit, index) => scenes.push({ kind: "hit", frame: nearest(hit.t + FRAME_BIAS_MS).data, event: hit.ev, hold: dwell, idx: index + 1, of: hits.length }));
    scenes.push({ kind: "tail", frame: lastFrame.data, event: hits[hits.length - 1].ev, hold: tail, note: `trace complete — ${sorted.length} hits` });
    return { scenes, first: hits[0].ev, hits, total: sorted.length };
  }

  /**
   * Compose the side-by-side journey clip. The motion screencast supplies the left side; the breakpoint hits
   * drive the pacing on the right. Returns null if nothing at all was captured.
   */
  static async renderJourney(frames: { data: Buffer; t: number }[], traced: Hit[], outputPath: string): Promise<string | null> {
    if (!frames.length) return null;
    const { scenes, first, hits, total } = Recorder.#buildScenes(frames, traced);
    if (!scenes.length) return null;

    const tempDir = mkdtempSync(join(tmpdir(), "trace-journey-"));
    const chrome = await ChromeLauncher.acquire({ launch: true, extraArgs: ["--force-device-scale-factor=1"], purpose: "video render" });
    let driver: CdpDriver | undefined;
    try {
      const page = (await chrome.pageTargets())[0];
      if (!page?.webSocketDebuggerUrl) throw new Error("render Chrome exposed no page target");
      driver = await CdpDriver.connect(page.webSocketDebuggerUrl);
      await driver.send(Cdp.Page.enable);
      await driver.send(Cdp.Emulation.setDeviceMetricsOverride, { width: OUTPUT_WIDTH, height: OUTPUT_HEIGHT, deviceScaleFactor: 1, mobile: false });
      const lines: string[] = [];
      for (let index = 0; index < scenes.length; index++) {
        const framePath = join(tempDir, `f${String(index).padStart(5, "0")}.png`);
        await Recorder.#renderFrame(driver, Recorder.#sceneHtml(scenes[index], first, hits, total), framePath);
        lines.push(`file '${framePath}'`, `duration ${scenes[index].hold.toFixed(3)}`);
      }
      lines.push(`file '${join(tempDir, `f${String(scenes.length - 1).padStart(5, "0")}.png`)}'`); // flush last frame
      const listFile = join(tempDir, FRAMES_LIST_FILE);
      writeFileSync(listFile, lines.join("\n") + "\n");
      await ffmpeg([...concatInput(listFile), ...h264Mp4({ pixFmt: "yuv420p" }), outputPath]);
      return outputPath;
    } finally {
      try { driver?.close(); } catch { /* ignore */ }
      chrome.kill();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}
