import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CdpDriver } from "../transport/CdpDriver.js";
import { Cdp } from "../transport/cdp.js";
import { ffmpeg, concatInput, h264Mp4, FRAMES_LIST_FILE } from "./ffmpeg.js";
import { DEFAULT_VIEWPORT } from "../shared/defaults.js";

interface Frame { data: Buffer; t: number; }

/**
 * Screencaster — records a continuous motion video of whatever page target is *currently active*, via
 * CDP `Page.startScreencast`. Unlike the breakpoint Recorder (one final screenshot + per-hit panels), this
 * captures the real screen over time, and it can `switch` the active target mid-journey (e.g. when a
 * `window.open` spawns a new tab) so a flow that spans tabs/apps renders as one seamless clip.
 *
 * Frames are stamped with wall-clock arrival time, so the assembled video preserves real pacing across a
 * target switch (different targets share no frame clock, but the host clock is common).
 */
export class Screencaster {
  #frames: Frame[] = [];
  #active: CdpDriver | null = null;
  #wired = new WeakSet<CdpDriver>();
  readonly #width: number;
  readonly #height: number;

  constructor(opts: { width?: number; height?: number } = {}) {
    this.#width = opts.width ?? DEFAULT_VIEWPORT.width;
    this.#height = opts.height ?? DEFAULT_VIEWPORT.height;
  }

  /** Pin a target to a stable viewport so every frame has the same dimensions. */
  async fit(driver: CdpDriver): Promise<void> {
    await driver.send(Cdp.Emulation.setDeviceMetricsOverride, { width: this.#width, height: this.#height, deviceScaleFactor: 1, mobile: false }).catch(() => {});
  }

  /** Make `driver` the recorded target. Stops the screencast on the previous one; frames accumulate into one timeline. */
  async switch(driver: CdpDriver): Promise<void> {
    if (this.#active === driver) return;
    if (this.#active) await this.#active.send(Cdp.Page.stopScreencast).catch(() => {});
    if (!this.#wired.has(driver)) {
      driver.on(Cdp.Page.screencastFrame, (p: any) => {
        if (this.#active !== driver) { driver.send(Cdp.Page.screencastFrameAck, { sessionId: p.sessionId }).catch(() => {}); return; }
        this.#frames.push({ data: Buffer.from(p.data, "base64"), t: Date.now() });
        driver.send(Cdp.Page.screencastFrameAck, { sessionId: p.sessionId }).catch(() => {});
      });
      this.#wired.add(driver);
    }
    await this.fit(driver);
    await driver.send(Cdp.Page.bringToFront).catch(() => {});
    await driver.send(Cdp.Page.startScreencast, { format: "jpeg", quality: 80, maxWidth: this.#width, maxHeight: this.#height, everyNthFrame: 1 });
    this.#active = driver;
  }

  async stop(): Promise<void> {
    if (this.#active) { await this.#active.send(Cdp.Page.stopScreencast).catch(() => {}); this.#active = null; }
  }

  frameCount(): number { return this.#frames.length; }

  /** The captured frames (image + wall-clock arrival time), for composing a side-by-side trace overlay. */
  frames(): { data: Buffer; t: number }[] { return this.#frames; }

  /** Assemble the captured frames into an mp4 with real per-frame durations. Returns null if nothing was captured. */
  async render(out: string, opts: { tailSecs?: number } = {}): Promise<string | null> {
    if (this.#frames.length < 2) return null;
    const dir = mkdtempSync(join(tmpdir(), "trace-cast-"));
    try {
      const lines: string[] = [];
      this.#frames.forEach((f, i) => {
        const file = join(dir, `f${String(i).padStart(5, "0")}.jpg`);
        writeFileSync(file, f.data);
        const next = this.#frames[i + 1];
        const dur = next ? Math.min(2, Math.max(0.03, (next.t - f.t) / 1000)) : (opts.tailSecs ?? 1.5);
        lines.push(`file '${file}'`, `duration ${dur.toFixed(3)}`);
      });
      lines.push(`file '${join(dir, `f${String(this.#frames.length - 1).padStart(5, "0")}.jpg`)}'`); // flush last
      const listFile = join(dir, FRAMES_LIST_FILE);
      writeFileSync(listFile, lines.join("\n") + "\n");
      await ffmpeg([...concatInput(listFile), "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p", ...h264Mp4(), out]);
      return out;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
}
