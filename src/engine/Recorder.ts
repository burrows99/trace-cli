import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpDriver } from "../transport/CdpDriver.js";
import { Cdp } from "../transport/cdp.js";
import { ChromeLauncher } from "./ChromeLauncher.js";
import { ffmpeg, concatInput, h264Mp4, FRAMES_LIST_FILE } from "./ffmpeg.js";
import type { TraceEvent } from "../domain/TraceEvent.js";
import { sleep } from "../shared/sleep.js";

const OW = 1360, OH = 860;

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const oneLine = (v: unknown) => { const s = typeof v === "string" ? v : JSON.stringify(v); return (s == null ? String(v) : s).replace(/\s+/g, " ").slice(0, 240); };
const locStr = (e: TraceEvent) => (e.loc ? `${e.loc.file}:${e.loc.line ?? ""}` : "");
const attrsOf = (e: TraceEvent) => (e.attrs ?? {}) as { cls?: string; stack?: string[]; locals?: Record<string, unknown>; exprs?: Record<string, unknown> };

const STYLE = `*{margin:0;box-sizing:border-box}
html,body{width:${OW}px;height:${OH}px;background:#0b1220;color:#e6edf3;font:14px/1.55 ui-monospace,Menlo,Consolas,monospace;overflow:hidden}
.root{display:flex;flex-direction:column;height:100%}
.row{display:flex;flex:1;min-height:0}
.left{width:46%;background:#06080f;display:flex;align-items:center;justify-content:center;border-right:2px solid #1b2740;overflow:hidden}
.app{max-width:100%;max-height:100%;object-fit:contain}
.req{align-self:stretch;width:100%;padding:20px;overflow:hidden}
.panel{flex:1;padding:18px 22px;overflow:hidden}
.hdr{font-size:19px;font-weight:700;color:#7ee787}
.loc{color:#79c0ff;margin-bottom:10px}
.sec{color:#8b949e;margin:12px 0 4px;text-transform:uppercase;font-size:11px;letter-spacing:.06em}
.fr{color:#c9d1d9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kv{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.k{color:#ffa657}.v{color:#a5d6ff}.expr .k{color:#d2a8ff}
.cap{background:#101828;border-top:3px solid #44646b;padding:15px 22px;font-size:18px;font-weight:600;text-align:center;color:#fff;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
.h{color:#7ee787;font-weight:700;margin-bottom:6px}
pre{white-space:pre-wrap;word-break:break-all;color:#9de0ad;font-size:12px}`;

/**
 * Recorder — composes a side-by-side replay mp4: the live screen on the left, and beside each moment the
 * active breakpoint's stack/locals/watch on the right. Frames are rendered as HTML in a headless Chrome,
 * then stitched with ffmpeg. Drives both `dynamic --record` and `journey` via `renderJourney`.
 */
export class Recorder {
  static #caption(e: TraceEvent): string {
    const a = attrsOf(e);
    return `#${e.seq}  ${a.cls ? a.cls + "." : ""}${e.label}  ${locStr(e)}${String(e.kind).startsWith("step") ? "  [" + e.kind + "]" : ""}`;
  }

  static async #renderFrame(driver: CdpDriver, html: string, out: string): Promise<void> {
    await driver.send(Cdp.Page.navigate, { url: "data:text/html;base64," + Buffer.from(html).toString("base64") });
    await sleep(280);
    const s = await driver.send(Cdp.Page.captureScreenshot, { format: "png" });
    writeFileSync(out, Buffer.from(s.data, "base64"));
  }

  /** One journey frame: the live screencast image on the left, the active breakpoint's panel on the right. */
  static #journeyFrameHtml(frameB64: string, e: TraceEvent | null): string {
    const left = `<img class=app src="data:image/jpeg;base64,${frameB64}">`;
    if (!e) return `<!doctype html><meta charset=utf8><style>${STYLE}</style><div class=root><div class=row><div class=left>${left}</div><div class=panel><div class=sec>trace</div><div class=fr>watching for breakpoint hits…</div></div></div><div class=cap>journey — screen + live trace</div></div>`;
    const a = attrsOf(e);
    const stack = (a.stack || []).map((f) => `<div class=fr>${esc(f)}</div>`).join("");
    const locals = Object.entries(a.locals || {}).map(([k, v]) => `<div class=kv><span class=k>${esc(k)}</span> = <span class=v>${esc(oneLine(v))}</span></div>`).join("");
    const exprs = Object.entries(a.exprs || {}).map(([ex, v]) => `<div class="kv expr">⊢ <span class=k>${esc(ex)}</span> = <span class=v>${esc(oneLine(v))}</span></div>`).join("");
    return `<!doctype html><meta charset=utf8><style>${STYLE}</style><div class=root>
      <div class=row><div class=left>${left}</div><div class=panel>
        <div class=hdr>#${e.seq} &nbsp; +${e.t}ms</div>
        <div class=loc>${esc((a.cls ? a.cls + "." : "") + e.label)} &nbsp;@ ${esc(locStr(e))}</div>
        <div class=sec>stack</div>${stack}
        ${locals ? `<div class=sec>locals</div>${locals}` : ""}
        ${exprs ? `<div class=sec>watch</div>${exprs}` : ""}
      </div></div>
      <div class=cap>${esc(Recorder.#caption(e))}</div>
    </div>`;
  }

  /**
   * Compose a side-by-side journey clip: the motion screencast on the left, and beside each moment the most
   * recent breakpoint hit (matched by wall-clock time). Frames are downsampled to keep the render bounded.
   */
  static async renderJourney(frames: { data: Buffer; t: number }[], traced: { ev: TraceEvent; t: number }[], out: string): Promise<string | null> {
    if (frames.length < 2) return null;
    const MAX = 160;
    const pick = frames.length > MAX ? Array.from({ length: MAX }, (_, i) => frames[Math.floor(i * (frames.length / MAX))]) : frames;
    const dir = mkdtempSync(join(tmpdir(), "trace-journey-"));
    const chrome = await ChromeLauncher.launch(["--force-device-scale-factor=1"], { purpose: "video render" });
    let driver: CdpDriver | undefined;
    try {
      const targets = await (await fetch(`http://localhost:${chrome.port}/json`)).json() as any[];
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl) || targets[0];
      if (!page?.webSocketDebuggerUrl) throw new Error("render Chrome exposed no page target");
      driver = await CdpDriver.connect(page.webSocketDebuggerUrl);
      await driver.send(Cdp.Page.enable);
      await driver.send(Cdp.Emulation.setDeviceMetricsOverride, { width: OW, height: OH, deviceScaleFactor: 1, mobile: false });
      const files: string[] = [];
      for (let i = 0; i < pick.length; i++) {
        const f = pick[i];
        const active = [...traced].reverse().find((h) => h.t <= f.t)?.ev ?? null;
        const file = join(dir, `f${String(i).padStart(5, "0")}.png`);
        await Recorder.#renderFrame(driver, Recorder.#journeyFrameHtml(f.data.toString("base64"), active), file);
        files.push(file);
      }
      const lines: string[] = [];
      pick.forEach((f, i) => { const next = pick[i + 1]; const dur = next ? Math.min(2, Math.max(0.05, (next.t - f.t) / 1000)) : 1.5; lines.push(`file '${files[i]}'`, `duration ${dur.toFixed(3)}`); });
      lines.push(`file '${files[files.length - 1]}'`);
      const listFile = join(dir, FRAMES_LIST_FILE);
      writeFileSync(listFile, lines.join("\n") + "\n");
      await ffmpeg([...concatInput(listFile), ...h264Mp4({ pixFmt: "yuv420p" }), out]);
      return out;
    } finally {
      try { driver?.close(); } catch { /* ignore */ }
      chrome.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
