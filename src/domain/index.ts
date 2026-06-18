// Domain barrel — the ubiquitous language of a trace.
// reflect-metadata MUST initialize before any decorated class evaluates (class-transformer @Type needs it).
import "reflect-metadata";

export { Loc } from "./Loc.js";
export { Diagnostic } from "./Diagnostic.js";
export type { DiagnosticLevel } from "./Diagnostic.js";
export { Breakpoint } from "./Breakpoint.js";
export { TraceEvent } from "./TraceEvent.js";
export type { EventSource } from "./TraceEvent.js";
export { Lineage, LineagePoint } from "./Lineage.js";
export type { LineageKind } from "./Lineage.js";
export { Recording } from "./Recording.js";
export { Target, NodeTarget, ChromeTarget } from "./Target.js";
export type { TargetKind, ProtocolKind, TargetRef } from "./Target.js";
export { Trace, TraceMeta, TraceData, CurlResponse } from "./Trace.js";
export type { ConsoleLine, NetworkLine } from "./Trace.js";
