import { DebugClient } from "@vscode/debugadapter-testsupport";
import type { ProtocolDriver } from "./ProtocolDriver.js";
import { log } from "./CdpDriver.js";

/**
 * DapDriver — the Debug Adapter Protocol transport (Python/debugpy, and any DAP adapter). Wraps Microsoft's
 * official `DebugClient`; we never hand-roll the wire protocol. Implements ProtocolDriver so the engine's
 * capture loop is identical to the CDP path.
 */
export class DapDriver implements ProtocolDriver {
  readonly source = "dap" as const;
  #dc: any;
  #stoppedQueue: any[] = [];
  #stoppedWaiter: ((p: any) => void) | null = null;

  private constructor(dc: any) {
    this.#dc = dc;
    dc.on("stopped", (m: any) => {
      const body = m?.body ?? m;
      if (this.#stoppedWaiter) { const w = this.#stoppedWaiter; this.#stoppedWaiter = null; w(body); }
      else this.#stoppedQueue.push(body);
    });
  }

  static async connect(opts: { host?: string; port: number }): Promise<DapDriver> {
    const { host = "127.0.0.1", port } = opts;
    // runtime/executable are unused in socket mode; the published constructor type under-specifies the args.
    const dc = new (DebugClient as any)("node", "", "trace-cli");
    try { await dc.start(port, host); }
    catch (e: any) { throw new Error(`cannot connect to DAP ${host}:${port} — ${e.message} (is the debug server up? e.g. debugpy.listen)`); }
    return new DapDriver(dc);
  }

  send(command: string, args: Record<string, unknown> = {}): Promise<any> {
    return this.#dc.send(command, args).then((r: any) => {
      if (r && r.success === false) throw new Error(r.message || `${command} failed`);
      return r?.body ?? {};
    });
  }
  on(event: string, cb: (p: any) => void): void { this.#dc.on(event, (m: any) => cb(m?.body ?? m)); }

  waitForStop(ms: number): Promise<any | null> {
    return new Promise((res, rej) => {
      if (this.#stoppedQueue.length) return res(this.#stoppedQueue.shift());
      const t = setTimeout(() => { this.#stoppedWaiter = null; rej(new Error("timeout")); }, ms);
      this.#stoppedWaiter = (p) => { clearTimeout(t); res(p); };
    });
  }
  hasQueued(): boolean { return this.#stoppedQueue.length > 0; }
  interrupt(): void { if (this.#stoppedWaiter) { const w = this.#stoppedWaiter; this.#stoppedWaiter = null; w(null); } }
  close(): void { try { this.#dc._socket?.destroy?.(); } catch { /* ignore */ } }

  /**
   * DAP handshake (DAP spec order): initialize → attach (in flight) → wait `initialized` → [caller sets
   * breakpoints] → setExceptionBreakpoints → configurationDone → attach settles. attachArgs defaults to
   * `{ justMyCode: false }` (empty `{}` trips a debugpy bug). Returns a function that finishes configuration.
   */
  async handshake(opts: { adapterID?: string; attachArgs?: Record<string, unknown> } = {}): Promise<() => Promise<void>> {
    const { adapterID = "debugpy", attachArgs = { justMyCode: false } } = opts;
    const initialized = new Promise<void>((res) => this.on("initialized", () => res()));
    const caps = await this.send("initialize", {
      clientID: "trace-cli", clientName: "trace-cli", adapterID,
      pathFormat: "path", linesStartAt1: true, columnsStartAt1: true,
      supportsRunInTerminalRequest: false, supportsVariableType: true,
    });
    const attachP = this.send("attach", attachArgs).catch((e: any) => { log(`dap attach: ${e.message}`); });
    await initialized;
    return async () => {
      await this.send("setExceptionBreakpoints", { filters: [] }).catch(() => {});
      if (caps?.supportsConfigurationDoneRequest !== false) await this.send("configurationDone").catch(() => {});
      await attachP;
    };
  }
}
