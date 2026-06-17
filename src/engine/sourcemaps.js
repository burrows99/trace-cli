// Generic source-map resolution. Unlike the original engine (which hardcoded a `src/→dist/` rewrite and
// read maps off disk), this resolves maps from whatever each Debugger.scriptParsed reports
// (`sourceMapURL`: data:/file:///http, or a `<scriptUrl>.map` sibling) — so it works for any TS/bundler
// layout, for both Node and Chrome targets. Breakpoint files are matched to scripts/sources by path suffix.

import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { SourceMapConsumer } = require("source-map");

// pathOf(url): the path portion of a script/source URL (no scheme/authority/query). Falls back for
// bare or relative paths.
export function pathOf(u) {
  if (!u) return "";
  try { return new URL(u).pathname.replace(/^\/+/, ""); } catch { /* not an absolute URL */ }
  return u.replace(/\\/g, "/").split("?")[0].replace(/^[a-z][\w+.-]*:\/\/+/i, "");
}

const segs = (p) => pathOf(p).split("/").filter((s) => s && s !== "." && s !== "..");
const baseNoExt = (p) => (pathOf(p).split("/").pop() || "").replace(/\.[^.]+$/, "");

// `--root` = a local directory mirroring the running app's files. Lets the tool resolve source maps when
// the target reports paths that don't exist locally (e.g. a Node inspector inside a container reporting
// `file:///app/dist/…`, or remote debugging) — we read the map from the matching path under root.
let _root = null;
export function setRoot(root) { _root = root || null; }

// findMapUnderRoot(scriptUrl): look for `<script>.js.map` under _root, trying progressively shorter
// leading-path trims so a container/remote prefix (e.g. `/app`) is skipped. Returns a path or null.
function findMapUnderRoot(scriptUrl) {
  if (!_root) return null;
  const parts = pathOf(scriptUrl).split("/").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const candidate = join(_root, parts.slice(i).join("/") + ".map");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// suffixMatch(x, y): true if the shorter path is a trailing-segment suffix of the longer. Lets a user
// give `src/foo.ts` and match a map source `../src/foo.ts`, or give a repo-qualified path and still match.
export function suffixMatch(x, y) {
  const a = segs(x), b = segs(y);
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (!short.length) return false;
  for (let i = 1; i <= short.length; i++) if (long[long.length - i] !== short[short.length - i]) return false;
  return true;
}

// urlRegexFor(scriptUrl): a Debugger.setBreakpointByUrl regex matching the script's path (ignoring query).
export function urlRegexFor(url) {
  return pathOf(url).replace(/[.+?^${}()|[\]\\]/g, "\\$&") + "(\\?|$)";
}

async function rawMapForScript(script) {
  // 1) inline data: map
  const smu = script?.sourceMapURL;
  if (smu?.startsWith("data:")) {
    try { const [head, data] = smu.split(","); return JSON.parse(/;base64/.test(head) ? Buffer.from(data, "base64").toString() : decodeURIComponent(data)); } catch { /* fall through */ }
  }
  // 2) local copy under --root (handles container/remote paths that don't exist locally)
  const local = findMapUnderRoot(script?.url);
  if (local) { try { return JSON.parse(readFileSync(local, "utf8")); } catch { /* fall through */ } }
  // 3) the reported sourceMapURL (or a `<script>.map` sibling) as file:// or http
  const tryUrls = [];
  if (smu && !smu.startsWith("data:")) tryUrls.push(smu);
  if (script?.url) tryUrls.push(script.url.split("?")[0] + ".map");
  for (const u of tryUrls) {
    try {
      const abs = new URL(u, script.url || "file:///").href;
      if (abs.startsWith("file://")) { const p = fileURLToPath(abs); if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")); }
      else if (/^https?:/.test(abs)) return await (await fetch(abs)).json();
    } catch { /* try the next candidate */ }
  }
  return null;
}

const _consumers = new Map(); // scriptId -> SourceMapConsumer | null (lazy + cached)

export async function consumerForScript(client, scriptId) {
  if (_consumers.has(scriptId)) return _consumers.get(scriptId);
  let consumer = null;
  try { const raw = await rawMapForScript(client.script(scriptId)); if (raw) consumer = await new SourceMapConsumer(raw); } catch { consumer = null; }
  _consumers.set(scriptId, consumer);
  return consumer;
}

export function disposeConsumers() {
  for (const c of _consumers.values()) if (c) { try { c.destroy(); } catch {} }
  _consumers.clear();
}

// generatedToSource(client, scriptId, line0, col): map a generated frame position back to
// { sourceRel, line } for display. Falls back to the raw script path when there is no map.
export async function generatedToSource(client, scriptId, line0, col) {
  const url = client.script(scriptId)?.url;
  const c = await consumerForScript(client, scriptId);
  if (c) {
    const o = c.originalPositionFor({ line: line0 + 1, column: col, bias: SourceMapConsumer.GREATEST_LOWER_BOUND });
    if (o.source != null && o.line != null) return { sourceRel: pathOf(o.source) || o.source, line: o.line };
  }
  return url ? { sourceRel: pathOf(url), line: line0 + 1 } : null;
}

// findGenerated(client, file, line): resolve source `file:line` to a CDP breakpoint location. Tries a
// DIRECT match first (a loaded script whose URL suffix-matches `file` — plain JS), then a MAPPED match
// (a loaded script whose source map lists a source suffix-matching `file`). Returns
// { urlRegex, lineNumber, columnNumber, scriptUrl, mapped } or null if nothing matches a loaded script.
async function tryMapScript(client, scriptId, s, file, line) {
  const c = await consumerForScript(client, scriptId);
  if (!c) return null;
  const src = c.sources.find((x) => suffixMatch(x, file));
  if (!src) return null;
  let g = c.generatedPositionFor({ source: src, line, column: 0, bias: SourceMapConsumer.LEAST_UPPER_BOUND });
  if (g.line == null) g = c.generatedPositionFor({ source: src, line, column: 0, bias: SourceMapConsumer.GREATEST_LOWER_BOUND });
  if (g.line == null) return null;
  return { urlRegex: urlRegexFor(s.url), lineNumber: g.line - 1, columnNumber: g.column || 0, scriptUrl: s.url, mapped: true };
}

export async function findGenerated(client, file, line) {
  const bn = baseNoExt(file);
  const all = [...client.scripts()];
  // 1) MAPPED (fast): a loaded script whose basename matches AND whose source map lists `file` as a source.
  //    Tried BEFORE direct so that transformed code served at the SOURCE url — e.g. a Vite dev server
  //    serving TS/TSX at the `.ts`/`.tsx` path with an inline source map — resolves through the map instead
  //    of being treated as plain JS at the raw line (which would mis-place or fail to bind the breakpoint).
  const primary = all.filter(([, s]) => s.url && baseNoExt(s.url) === bn);
  for (const [scriptId, s] of primary) { const r = await tryMapScript(client, scriptId, s, file, line); if (r) return r; }
  // 2) DIRECT: a loaded script IS the file (plain JS, or a runtime executing the source directly, no map).
  for (const [, s] of client.scripts()) {
    if (s.url && suffixMatch(s.url, file)) {
      return { urlRegex: urlRegexFor(s.url), lineNumber: line - 1, columnNumber: 0, scriptUrl: s.url, mapped: false };
    }
  }
  // 3) MAPPED (fallback): any remaining script whose source map lists `file` as a source.
  const seen = new Set(primary.map(([id]) => id));
  for (const [scriptId, s] of all) { if (seen.has(scriptId)) continue; const r = await tryMapScript(client, scriptId, s, file, line); if (r) return r; }
  return null;
}
