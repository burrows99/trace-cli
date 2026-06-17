// CDP WebSocket client + target discovery. Dependency-free: Node 18+ global WebSocket/fetch.
// `connect()` and `renderRO()` are lifted (vendor-neutral) from the original debug engine.

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

// connect(wsUrl): open a CDP session. Returns { send, on, waitForPaused, hasQueued, script(s), close }.
export async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const scripts = new Map();
  const listeners = new Map();
  const pausedQueue = [];
  let pausedWaiter = null;

  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      return m.error ? rej(new Error(m.error.message || JSON.stringify(m.error))) : res(m.result);
    }
    if (m.method === "Debugger.scriptParsed" && m.params?.url) scripts.set(m.params.scriptId, m.params);
    if (m.method === "Debugger.paused") {
      if (pausedWaiter) { const w = pausedWaiter; pausedWaiter = null; w(m.params); }
      else pausedQueue.push(m.params);
    }
    if (m.method) { const set = listeners.get(m.method); if (set) for (const cb of set) cb(m.params); }
  });

  await new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", () => rej(new Error(`cannot connect to ${wsUrl}`)));
  });

  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const waitForPaused = (ms) => new Promise((res, rej) => {
    if (pausedQueue.length) return res(pausedQueue.shift());
    const t = setTimeout(() => { pausedWaiter = null; rej(new Error("timeout")); }, ms);
    pausedWaiter = (p) => { clearTimeout(t); res(p); };
  });
  const on = (method, cb) => { if (!listeners.has(method)) listeners.set(method, new Set()); listeners.get(method).add(cb); };

  return {
    send, on, waitForPaused,
    hasQueued: () => pausedQueue.length > 0,
    scriptUrl: (id) => scripts.get(id)?.url,
    script: (id) => scripts.get(id),
    scripts: () => scripts,
    close: () => { try { ws.close(); } catch {} },
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
