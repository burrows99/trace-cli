/**
 * CDP method & event identifiers — the Chrome DevTools Protocol "domain.method" strings used across the
 * engine. Centralized so a typo is a compile error (an unknown property) rather than a silent runtime
 * rejection, and so the protocol surface this tool depends on is discoverable in one place. Commands are
 * passed to `driver.send(...)`; events (those documented `(event)` below) to `driver.on(...)`.
 */
export const Cdp = {
  Runtime: {
    enable: "Runtime.enable",
    evaluate: "Runtime.evaluate",
    getProperties: "Runtime.getProperties",
    consoleAPICalled: "Runtime.consoleAPICalled", // (event)
    exceptionThrown: "Runtime.exceptionThrown",   // (event)
  },
  Debugger: {
    enable: "Debugger.enable",
    resume: "Debugger.resume",
    setPauseOnExceptions: "Debugger.setPauseOnExceptions",
    setInstrumentationBreakpoint: "Debugger.setInstrumentationBreakpoint",
    setBreakpointByUrl: "Debugger.setBreakpointByUrl",
    removeBreakpoint: "Debugger.removeBreakpoint",
    evaluateOnCallFrame: "Debugger.evaluateOnCallFrame",
    stepOver: "Debugger.stepOver",
    stepInto: "Debugger.stepInto",
    stepOut: "Debugger.stepOut",
    paused: "Debugger.paused",             // (event)
    scriptParsed: "Debugger.scriptParsed", // (event)
  },
  Page: {
    enable: "Page.enable",
    navigate: "Page.navigate",
    captureScreenshot: "Page.captureScreenshot",
    bringToFront: "Page.bringToFront",
    startScreencast: "Page.startScreencast",
    stopScreencast: "Page.stopScreencast",
    screencastFrameAck: "Page.screencastFrameAck",
    screencastFrame: "Page.screencastFrame",   // (event)
    loadEventFired: "Page.loadEventFired",      // (event)
  },
  Network: {
    enable: "Network.enable",
    responseReceived: "Network.responseReceived", // (event)
  },
  DOM: {
    enable: "DOM.enable",
  },
  Emulation: {
    setDeviceMetricsOverride: "Emulation.setDeviceMetricsOverride",
  },
  Input: {
    dispatchMouseEvent: "Input.dispatchMouseEvent",
    insertText: "Input.insertText",
  },
} as const;
