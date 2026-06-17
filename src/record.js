// record.js — turn a trace result into a "debug-replay" video. Each hit becomes one side-by-side frame
// [ app screenshot (or request panel) | trace panel ] with a caption. Frames are rendered as HTML in an
// ephemeral headless Chrome and screenshotted (Chrome does fonts/layout/captions — this ffmpeg has no text
// filter), then ffmpeg concatenates the PNGs into an mp4. Deps: a Chrome binary + ffmpeg (system tools).

import { execFile, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "./cdp.js";

const OW = 1360, OH = 860; // output frame size

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const oneLine = (v) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return (s == null ? String(v) : s).replace(/\s+/g, " ").slice(0, 240);
};

// wrap(line,width): word-wrap a line (exported for tests / non-HTML callers).
export function wrap(line, width) {
  const out = [];
  let s = String(line);
  while (s.length > width) {
    let cut = s.lastIndexOf(" ", width);
    if (cut <= 0) cut = width;
    out.push(s.slice(0, cut));
    s = s.slice(cut).replace(/^ /, "");
  }
  out.push(s);
  return out;
}

const captionFor = (hit) => `#${hit.seq}  ${hit.cls ? hit.cls + "." : ""}${hit.fn}  ${hit.at}${hit.kind?.startsWith("step") ? "  [" + hit.kind + "]" : ""}`;

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

function frameHtml(result, hit) {
  const left = hit.shot
    ? `<img class=app src="data:image/png;base64,${hit.shot}">`
    : `<div class=req><div class=h>REQUEST</div><pre>${esc(result.meta.trigger)}</pre>` +
      (result.response ? `<div class=h style="margin-top:14px">RESPONSE · curl exit ${result.response.exitCode}${result.response.error ? " (" + esc(result.response.error) + ")" : ""}</div><pre>${esc((result.response.body || "").slice(0, 1400))}</pre>` : "") + `</div>`;
  const stack = (hit.stack || []).map((f) => `<div class=fr>${esc(f)}</div>`).join("");
  const locals = Object.entries(hit.locals || {}).map(([k, v]) => `<div class=kv><span class=k>${esc(k)}</span> = <span class=v>${esc(oneLine(v))}</span></div>`).join("");
  const exprs = Object.entries(hit.exprs || {}).map(([e, v]) => `<div class="kv expr">⊢ <span class=k>${esc(e)}</span> = <span class=v>${esc(oneLine(v))}</span></div>`).join("");
  return `<!doctype html><meta charset=utf8><style>${STYLE}</style><div class=root>
    <div class=row><div class=left>${left}</div><div class=panel>
      <div class=hdr>#${hit.seq} &nbsp; +${hit.tMs}ms</div>
      <div class=loc>${esc((hit.cls ? hit.cls + "." : "") + hit.fn)} &nbsp;@ ${esc(hit.at)}</div>
      <div class=sec>stack</div>${stack}
      ${locals ? `<div class=sec>locals</div>${locals}` : ""}
      ${exprs ? `<div class=sec>watch</div>${exprs}` : ""}
    </div></div>
    <div class=cap>${esc(captionFor(hit))}</div>
  </div>`;
}

const titleHtml = (title) => `<!doctype html><meta charset=utf8><style>${STYLE}
.title{display:flex;align-items:center;justify-content:center;height:100%;font:600 34px/1.4 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;text-align:center;padding:0 60px}</style>
<div class=title>${esc(title)}</div>`;

function ffmpeg(args) {
  return new Promise((res, rej) => {
    execFile("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], (err, _o, stderr) => (err ? rej(new Error(stderr || err.message)) : res()));
  });
}

// concatList(frames, stepSecs, titleSecs): the ffmpeg concat-demuxer list (frame 0 uses titleSecs when
// truthy; the last frame is repeated so the demuxer flushes its final image).
export function concatList(frames, stepSecs, titleSecs) {
  const lines = [];
  frames.forEach((f, idx) => lines.push(`file '${f}'`, `duration ${idx === 0 && titleSecs ? titleSecs : stepSecs}`));
  if (frames.length) lines.push(`file '${frames[frames.length - 1]}'`);
  return lines.join("\n") + "\n";
}

async function launchRenderChrome() {
  const bin = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!bin) throw new Error("no Chrome found for frame rendering (set CHROME_BIN)");
  const port = 9700 + (process.pid % 250);
  const profile = mkdtempSync(join(tmpdir(), "trace-render-profile-"));
  const proc = spawn(bin, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--force-device-scale-factor=1", "about:blank"],
    { stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try { await (await fetch(`http://localhost:${port}/json/version`)).json(); break; } catch { await sleep(100); }
  }
  return { port, kill() { try { proc.kill("SIGKILL"); } catch {} try { rmSync(profile, { recursive: true, force: true }); } catch {} } };
}

async function renderFrame(client, html, out) {
  await client.send("Page.navigate", { url: "data:text/html;base64," + Buffer.from(html).toString("base64") });
  await sleep(280);
  const s = await client.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(out, Buffer.from(s.data, "base64"));
}

// renderVideo(result, { out, stepSecs, title, titleSecs }) → mp4 path (null if no hits).
export async function renderVideo(result, { out, stepSecs = 3, title, titleSecs = 2.5 } = {}) {
  if (!result.hits?.length) return null;
  const dir = mkdtempSync(join(tmpdir(), "trace-rec-"));
  const chrome = await launchRenderChrome();
  let client;
  try {
    const targets = await (await fetch(`http://localhost:${chrome.port}/json`)).json();
    const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl) || targets[0];
    if (!page?.webSocketDebuggerUrl) throw new Error("render Chrome exposed no page target");
    client = await connect(page.webSocketDebuggerUrl);
    await client.send("Page.enable");
    await client.send("Emulation.setDeviceMetricsOverride", { width: OW, height: OH, deviceScaleFactor: 1, mobile: false });

    const frames = [];
    if (title) { const f = join(dir, "frame_0.png"); await renderFrame(client, titleHtml(title), f); frames.push(f); }
    let i = 1;
    for (const hit of result.hits) { const f = join(dir, `frame_${i}.png`); await renderFrame(client, frameHtml(result, hit), f); frames.push(f); i++; }

    const listFile = join(dir, "frames.txt");
    writeFileSync(listFile, concatList(frames, stepSecs, title ? titleSecs : 0));
    await ffmpeg(["-f", "concat", "-safe", "0", "-i", listFile, "-r", "30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]);
    return out;
  } finally {
    try { client?.close(); } catch {}
    chrome.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}
