import CDP from "chrome-remote-interface";
import type { ProtocolDriver } from "./ProtocolDriver.js";
import { withDeadline } from "../shared/deadline.js";

export const log = (...a: unknown[]) => console.error("[trace]", ...a);

export interface ScriptInfo { scriptId: string; url?: string; sourceMapURL?: string; [k: string]: unknown; }

/**
 * CdpDriver — the Chrome DevTools Protocol transport (Node `--inspect` + Chrome). Wraps the maintained
 * `chrome-remote-interface` client; we own only target discovery (the environment-specific bit) and a small
 * scriptParsed cache + paused-event queue. Implements ProtocolDriver so the engine never sees CDP directly.
 */
export class CdpDriver implements ProtocolDriver {
  readonly source = "cdp" as const;
  #client: any;
  #scripts = new Map<string, ScriptInfo>();
  #pausedQueue: any[] = [];
  #pausedWaiter: ((p: any) => void) | null = null;

  private constructor(client: any) {
    this.#client = client;
    client.on("Debugger.scriptParsed", (p: ScriptInfo) => { if (p?.url) this.#scripts.set(p.scriptId, p); });
    client.on("Debugger.paused", (p: any) => {
      if (this.#pausedWaiter) { const w = this.#pausedWaiter; this.#pausedWaiter = null; w(p); }
      else this.#pausedQueue.push(p);
    });
  }

  static async connect(wsUrl: string, timeoutMs = 8000): Promise<CdpDriver> {
    let client: any;
    try {
      client = await withDeadline(CDP({ target: wsUrl, local: true }), timeoutMs, () =>
        `CDP connect to ${wsUrl} did not complete within ${timeoutMs}ms — the port accepts TCP but is not responding as a DevTools endpoint`);
    } catch (e: any) { throw new Error(`cannot connect to ${wsUrl} — ${e.message}`); }
    return new CdpDriver(client);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> { return this.#client.send(method, params); }
  on(event: string, cb: (p: any) => void): void { this.#client.on(event, cb); }

  waitForStop(ms: number): Promise<any | null> {
    return new Promise((res, rej) => {
      if (this.#pausedQueue.length) return res(this.#pausedQueue.shift());
      const t = setTimeout(() => { this.#pausedWaiter = null; rej(new Error("timeout")); }, ms);
      this.#pausedWaiter = (p) => { clearTimeout(t); res(p); };
    });
  }
  hasQueued(): boolean { return this.#pausedQueue.length > 0; }
  interrupt(): void { if (this.#pausedWaiter) { const w = this.#pausedWaiter; this.#pausedWaiter = null; w(null); } }
  close(): void { try { this.#client.close(); } catch { /* ignore */ } }

  // --- CDP-specific: the scriptParsed cache feeds source-map resolution ---
  scriptUrl(id: string): string | undefined { return this.#scripts.get(id)?.url; }
  script(id: string): ScriptInfo | undefined { return this.#scripts.get(id); }
  scripts(): Map<string, ScriptInfo> { return this.#scripts; }

  // --- target discovery (custom; environment-specific — libraries can't generalize this) ---
  static async listTargets(port: number, kind: "node" | "chrome", timeoutMs = 4000): Promise<any[]> {
    const route = kind === "chrome" ? "json" : "json/list";
    const where = kind === "chrome" ? "Chrome --remote-debugging-port" : "Node --inspect";
    let res: Response;
    try { res = await fetch(`http://localhost:${port}/${route}`, { signal: AbortSignal.timeout(timeoutMs) }); }
    catch (e: any) {
      const why = e?.name === "TimeoutError" ? `no HTTP response within ${timeoutMs}ms` : (e?.message || String(e));
      throw new Error(`cannot reach the ${kind} inspector on :${port} (${why}) — is ${where} listening there?`);
    }
    return (await res.json()) as any[];
  }

  static async resolveWsUrl(
    port: number,
    opts: { kind?: "node" | "chrome"; urlMatch?: string; titleMatch?: string } = {},
  ): Promise<string> {
    const { kind = "node", urlMatch, titleMatch } = opts;
    const list = await CdpDriver.listTargets(port, kind);
    let candidates = Array.isArray(list) ? list : [];
    if (kind === "chrome") candidates = candidates.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
    let t: any;
    if (urlMatch) t = candidates.find((x) => (x.url || "").includes(urlMatch));
    if (!t && titleMatch) t = candidates.find((x) => (x.title || "").includes(titleMatch));
    t = t || candidates.find((x) => x.webSocketDebuggerUrl) || candidates[0];
    if (!t?.webSocketDebuggerUrl) {
      throw new Error(`no debuggable target on :${port} — is the ${kind === "chrome" ? "Chrome --remote-debugging-port" : "Node --inspect"} up?`);
    }
    return t.webSocketDebuggerUrl as string;
  }
}

/** renderRemoteObject — a compact, human-readable value for a CDP RemoteObject. */
export function renderRemoteObject(ro: any): unknown {
  if (!ro) return undefined;
  if ("value" in ro) return ro.value;
  if (ro.unserializableValue) return ro.unserializableValue;
  if (ro.type === "undefined") return undefined;
  if (ro.subtype === "null") return null;
  if (ro.type === "function") return `[Function${ro.className && ro.className !== "Function" ? ": " + ro.className : ""}]`;
  if (ro.subtype === "promise") return `[Promise <${ro.description || "pending"}>]`;
  const label = ro.className || ro.subtype || ro.type;
  if (ro.preview?.properties) {
    const props = ro.preview.properties.slice(0, 6).map((p: any) => `${p.name}: ${p.value}`).join(", ");
    return `${label} { ${props}${ro.preview.overflow ? ", …" : ""} }`;
  }
  return ro.description ? `${label} (${String(ro.description).slice(0, 80)})` : `[${label}]`;
}
