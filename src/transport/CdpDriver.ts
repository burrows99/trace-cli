import CDP from "chrome-remote-interface";
import type { ProtocolDriver } from "./ProtocolDriver.js";
import { Cdp } from "./cdp.js";
import { TargetKind, TARGET_LABEL } from "../domain/Target.js";
import { withDeadline } from "../shared/deadline.js";
import { DEFAULT_ATTACH_TIMEOUT_MS } from "../shared/defaults.js";
import { logger } from "../shared/logger.js";

const cdpLog = logger.child({ component: "cdp" });
/** Verbose transport trace — debug level, so it's quiet by default and surfaced with TRACE_LOG_LEVEL=debug. */
export const log = (...args: unknown[]) => cdpLog.debug(args.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" "));

export interface ScriptInfo { scriptId: string; url?: string; sourceMapURL?: string; [key: string]: unknown; }

/**
 * CdpDriver — the Chrome DevTools Protocol transport (Node `--inspect` + Chrome). Wraps the maintained
 * `chrome-remote-interface` client; we own only target discovery (the environment-specific bit) and a small
 * scriptParsed cache + paused-event queue. Implements ProtocolDriver so the engine never sees CDP directly.
 */
export class CdpDriver implements ProtocolDriver {
  readonly source = "cdp" as const;
  #client: any;
  #scripts = new Map<string, ScriptInfo>();

  private constructor(client: any) {
    this.#client = client;
    client.on(Cdp.Debugger.scriptParsed, (script: ScriptInfo) => { if (script?.url) this.#scripts.set(script.scriptId, script); });
  }

  static async connect(wsUrl: string, timeoutMs = DEFAULT_ATTACH_TIMEOUT_MS): Promise<CdpDriver> {
    let client: any;
    try {
      client = await withDeadline(CDP({ target: wsUrl, local: true }), timeoutMs, () =>
        `CDP connect to ${wsUrl} did not complete within ${timeoutMs}ms — the port accepts TCP but is not responding as a DevTools endpoint`);
    } catch (error: any) { throw new Error(`cannot connect to ${wsUrl} — ${error.message}`); }
    return new CdpDriver(client);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> { return this.#client.send(method, params); }
  on(event: string, callback: (params: any) => void): void { this.#client.on(event, callback); }
  close(): void { try { this.#client.close(); } catch { /* ignore */ } }

  // --- CDP-specific: the scriptParsed cache feeds source-map resolution ---
  scriptUrl(scriptId: string): string | undefined { return this.#scripts.get(scriptId)?.url; }
  script(scriptId: string): ScriptInfo | undefined { return this.#scripts.get(scriptId); }
  scripts(): Map<string, ScriptInfo> { return this.#scripts; }

  // --- target discovery (custom; environment-specific — libraries can't generalize this) ---
  static async listTargets(port: number, kind: TargetKind, timeoutMs = 4000): Promise<any[]> {
    const route = kind === TargetKind.Chrome ? "json" : "json/list";
    const targetLabel = TARGET_LABEL[kind];
    let response: Response;
    try { response = await fetch(`http://localhost:${port}/${route}`, { signal: AbortSignal.timeout(timeoutMs) }); }
    catch (error: any) {
      const reason = error?.name === "TimeoutError" ? `no HTTP response within ${timeoutMs}ms` : (error?.message || String(error));
      throw new Error(`cannot reach the ${kind} inspector on :${port} (${reason}) — is ${targetLabel} listening there?`);
    }
    return (await response.json()) as any[];
  }

  /**
   * Open a fresh page target on a Chrome `--remote-debugging-port` and return its descriptor (`{ id, url,
   * webSocketDebuggerUrl, … }`). Lets a caller attach to a debug Chrome that's up but has no tab, instead of
   * failing. The DevTools HTTP endpoint requires a PUT for `/json/new` on modern Chrome; the URL to open is
   * the raw query string (default `about:blank`, which the first navigation then replaces).
   */
  static async createPageTarget(port: number, url = "about:blank", timeoutMs = 4000): Promise<any> {
    let response: Response;
    try { response = await fetch(`http://localhost:${port}/json/new?${url}`, { method: "PUT", signal: AbortSignal.timeout(timeoutMs) }); }
    catch (error: any) { throw new Error(`cannot open a tab on :${port} (${error?.message || String(error)})`); }
    if (!response.ok) throw new Error(`Chrome refused to open a tab on :${port} (HTTP ${response.status})`);
    return await response.json();
  }

  static async resolveWsUrl(
    port: number,
    options: { kind?: TargetKind; urlMatch?: string; titleMatch?: string } = {},
  ): Promise<string> {
    const { kind = TargetKind.Node, urlMatch, titleMatch } = options;
    const targets = await CdpDriver.listTargets(port, kind);
    let candidates = Array.isArray(targets) ? targets : [];
    if (kind === TargetKind.Chrome) candidates = candidates.filter((candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl);
    let target: any;
    if (urlMatch) target = candidates.find((candidate) => (candidate.url || "").includes(urlMatch));
    if (!target && titleMatch) target = candidates.find((candidate) => (candidate.title || "").includes(titleMatch));
    target = target || candidates.find((candidate) => candidate.webSocketDebuggerUrl) || candidates[0];
    if (!target?.webSocketDebuggerUrl) {
      throw new Error(`no debuggable target on :${port} — is the ${TARGET_LABEL[kind]} up?`);
    }
    return target.webSocketDebuggerUrl as string;
  }
}
