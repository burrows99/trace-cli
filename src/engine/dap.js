// Debug Adapter Protocol (DAP) driver — the cross-language analogue of cdp.js. We do NOT hand-roll the
// wire protocol: framing (Content-Length), request/response sequencing, and capability negotiation are
// borrowed from Microsoft's official client, `DebugClient` (@vscode/debugadapter-testsupport), which
// `start(port)`s a TCP connection to an already-running adapter — e.g. a server that called
// `debugpy.listen((host, port))`, or dlv-dap / lldb-dap / java-debug. We wrap it behind the same shape as
// cdp.connect() (send/on/waitForStopped/close) so the engine's trigger+capture loop is protocol-agnostic.

import { DebugClient } from "@vscode/debugadapter-testsupport";
import { log } from "./cdp.js";

export { log };

// connectDap({ host="127.0.0.1", port }) → DAP driver. `send(command, args)` resolves the response BODY;
// `waitForStopped(ms)` yields the next `stopped` event body; `on(event, cb)` for everything else.
export async function connectDap({ host = "127.0.0.1", port } = {}) {
  // runtime/executable are unused in socket mode (start(port) connects instead of spawning).
  const dc = new DebugClient("node", "", "trace-cli");
  const stoppedQueue = [];
  let stoppedWaiter = null;

  dc.on("stopped", (m) => {
    const body = m?.body ?? m;
    if (stoppedWaiter) { const w = stoppedWaiter; stoppedWaiter = null; w(body); }
    else stoppedQueue.push(body);
  });

  try {
    await dc.start(port, host);
  } catch (e) {
    throw new Error(`cannot connect to DAP ${host}:${port} — ${e.message} (is the debug server up? e.g. debugpy.listen)`);
  }

  const send = (command, args = {}) => dc.send(command, args).then((r) => {
    if (r && r.success === false) throw new Error(r.message || `${command} failed`);
    return r?.body ?? {};
  });

  const waitForStopped = (ms) => new Promise((res, rej) => {
    if (stoppedQueue.length) return res(stoppedQueue.shift());
    const t = setTimeout(() => { stoppedWaiter = null; rej(new Error("timeout")); }, ms);
    stoppedWaiter = (p) => { clearTimeout(t); res(p); };
  });

  return {
    send, waitForStopped,
    on: (event, cb) => dc.on(event, (m) => cb(m?.body ?? m)),
    hasQueued: () => stoppedQueue.length > 0,
    // interrupt(): unblock a pending waitForStopped with null — used when the trigger finishes.
    interrupt: () => { if (stoppedWaiter) { const w = stoppedWaiter; stoppedWaiter = null; w(null); } },
    close: () => { try { dc._socket?.destroy?.(); } catch {} },
  };
}

// dapHandshake(client, { adapterID, attachArgs }) → resolves once the adapter has emitted `initialized`
// and is ready for setBreakpoints. Returns a function to finish configuration (configurationDone).
// Order follows the DAP spec: initialize → attach (in flight) → wait `initialized` → [caller sets bps] →
// setExceptionBreakpoints → configurationDone → attach response settles.
//
// attachArgs defaults to `{ justMyCode: false }`, NOT `{}`: an empty arguments object trips a debugpy
// serialization bug ("AttachRequest.__init__() missing 1 required positional argument: 'arguments'"),
// and justMyCode:false ensures our line breakpoints bind regardless of debugpy's user-code heuristics.
export async function dapHandshake(client, { adapterID = "debugpy", attachArgs = { justMyCode: false } } = {}) {
  const initialized = new Promise((res) => client.on("initialized", res));
  const caps = await client.send("initialize", {
    clientID: "trace-cli", clientName: "trace-cli", adapterID,
    pathFormat: "path", linesStartAt1: true, columnsStartAt1: true,
    supportsRunInTerminalRequest: false, supportsVariableType: true,
  });
  const attachP = client.send("attach", attachArgs).catch((e) => { log(`dap attach: ${e.message}`); });
  await initialized;
  return async function configurationDone() {
    await client.send("setExceptionBreakpoints", { filters: [] }).catch(() => {});
    if (caps?.supportsConfigurationDoneRequest !== false) await client.send("configurationDone").catch(() => {});
    await attachP;
  };
}
