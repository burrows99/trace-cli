// CDP driver. We OWN the environment-specific parts — target discovery (listTargets/resolveWsUrl) and the
// RemoteObject renderer (renderRO) — and DELEGATE the wire protocol (WebSocket transport, message framing,
// request ids, pending promises, event dispatch) to chrome-remote-interface, the maintained CDP client.
// Symmetric with dap.js, which wraps the official DAP client. See docs/MIGRATION.md §8.

import CDP from "chrome-remote-interface";

const log = (...a) => console.error("[trace]", ...a);
export { log };

// listTargets(port, kind): Node inspector → GET /json/list ; Chrome → GET /json.
export async function listTargets(port, kind) {
  const route = kind === "chrome" ? "json" : "json/list";
  const res = await fetch(`http://localhost:${port}/${route}`);
  return res.json();
}

// resolveWsUrl(port, { kind, urlMatch, titleMatch }): pick a target and return its
// webSocketDebuggerUrl — by url substring, then title substring, else the first debuggable target.
export async function resolveWsUrl(port, { kind = "node", urlMatch, titleMatch } = {}) {
  const list = await listTargets(port, kind);
  let candidates = Array.isArray(list) ? list : [];
  if (kind === "chrome") candidates = candidates.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  let t;
  if (urlMatch) t = candidates.find((x) => (x.url || "").includes(urlMatch));
  if (!t && titleMatch) t = candidates.find((x) => (x.title || "").includes(titleMatch));
  t = t || candidates.find((x) => x.webSocketDebuggerUrl) || candidates[0];
  if (!t?.webSocketDebuggerUrl) {
    throw new Error(`no debuggable target on :${port} — is the ${kind === "chrome" ? "Chrome --remote-debugging-port" : "Node --inspect"} up?`);
  }
  return t.webSocketDebuggerUrl;
}

// connect(wsUrl): open a CDP session on the given WebSocket URL (we resolved it via resolveWsUrl, the
// app-specific bit CRI can't generalize). Returns the same shape as dap.js's driver:
// { send, on, waitForPaused, hasQueued, interrupt, scriptUrl, script, scripts, close }. We keep a small
// scriptParsed cache + a paused-event queue on top of CRI so the engine's capture loop is protocol-agnostic.
export async function connect(wsUrl) {
  let client;
  try {
    client = await CDP({ target: wsUrl, local: true });   // local: use the bundled protocol, no extra fetch
  } catch (e) {
    throw new Error(`cannot connect to ${wsUrl} — ${e.message}`);
  }

  const scripts = new Map();
  const pausedQueue = [];
  let pausedWaiter = null;

  client.on("Debugger.scriptParsed", (p) => { if (p?.url) scripts.set(p.scriptId, p); });
  client.on("Debugger.paused", (p) => {
    if (pausedWaiter) { const w = pausedWaiter; pausedWaiter = null; w(p); }
    else pausedQueue.push(p);
  });

  const waitForPaused = (ms) => new Promise((res, rej) => {
    if (pausedQueue.length) return res(pausedQueue.shift());
    const t = setTimeout(() => { pausedWaiter = null; rej(new Error("timeout")); }, ms);
    pausedWaiter = (p) => { clearTimeout(t); res(p); };
  });

  return {
    send: (method, params = {}) => client.send(method, params),
    on: (method, cb) => client.on(method, cb),
    waitForPaused,
    hasQueued: () => pausedQueue.length > 0,
    // interrupt(): unblock a pending waitForPaused with null — used when the trigger finishes so we don't
    // sit out the full timeout waiting for a pause that will never come.
    interrupt: () => { if (pausedWaiter) { const w = pausedWaiter; pausedWaiter = null; w(null); } },
    scriptUrl: (id) => scripts.get(id)?.url,
    script: (id) => scripts.get(id),
    scripts: () => scripts,
    close: () => { try { client.close(); } catch {} },
  };
}

// renderRO(remoteObject): a compact, human-readable value for a CDP RemoteObject.
export function renderRO(ro) {
  if (!ro) return undefined;
  if ("value" in ro) return ro.value;
  if (ro.unserializableValue) return ro.unserializableValue;
  if (ro.type === "undefined") return undefined;
  if (ro.subtype === "null") return null;
  if (ro.type === "function") return `[Function${ro.className && ro.className !== "Function" ? ": " + ro.className : ""}]`;
  if (ro.subtype === "promise") return `[Promise <${ro.description || "pending"}>]`;
  const label = ro.className || ro.subtype || ro.type;
  if (ro.preview?.properties) {
    const props = ro.preview.properties.slice(0, 6).map((p) => `${p.name}: ${p.value}`).join(", ");
    return `${label} { ${props}${ro.preview.overflow ? ", …" : ""} }`;
  }
  return ro.description ? `${label} (${String(ro.description).slice(0, 80)})` : `[${label}]`;
}
