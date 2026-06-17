// Public library entry point. Embed trace-cli in any program/agent:
//
//   import { traceNode, tracePython } from "trace-cli";
//   const result = await traceNode({ port: 9229, curl: "curl -s localhost:3002/v1/dashboard",
//                                    breakpoints: ["src/dashboard/dashboard.service.ts:149"], root: "." });

// Engine — protocol-pluggable breakpoint tracer.
export { traceNode, traceChrome, tracePython, checkBreakpoint, checkPython } from "./engine/trace.js";
export { connect, resolveWsUrl, listTargets, renderRO } from "./engine/cdp.js";
export { connectDap } from "./engine/dap.js";
export {
  findGenerated, generatedToSource, consumerForScript,
  suffixMatch, pathOf, urlRegexFor,
} from "./engine/sourcemaps.js";
export { parseBpSpec, parseBreakpoints, resolveLine } from "./engine/breakpoints.js";
export { renderTrace } from "./engine/render.js";
export { renderVideo, concatList, wrap } from "./engine/record.js";

// Contract — the unified envelope every subcommand emits.
export { makeEnvelope, validate, VERSION, loc, parseLoc, event, metric, diag, newSessionId } from "./schema/envelope.js";

// Normalizers — engine result → envelope.
export { dynamicEnvelope } from "./commands/dynamic.js";
