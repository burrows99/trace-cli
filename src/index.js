// Public library entry point. Embed trace-cli in any program/agent:
//
//   import { traceNode } from "trace-cli";
//   const result = await traceNode({ port: 9229, curl: "curl -s localhost:3002/v1/dashboard",
//                                    breakpoints: ["src/dashboard/dashboard.service.ts:149"], root: "." });

export { traceNode, traceChrome, checkBreakpoint } from "./trace.js";
export { connect, resolveWsUrl, listTargets, renderRO } from "./cdp.js";
export {
  findGenerated, generatedToSource, consumerForScript,
  suffixMatch, pathOf, urlRegexFor,
} from "./sourcemaps.js";
export { parseBpSpec, parseBreakpoints, resolveLine } from "./breakpoints.js";
export { renderTrace } from "./render.js";
export { renderVideo, concatList, wrap } from "./record.js";
