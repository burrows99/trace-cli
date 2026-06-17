import "reflect-metadata"; // class-transformer/@Type metadata must initialize before decorated classes

// Public, class-first API.
export * from "./domain/index.js";
export { Tracer } from "./engine/Tracer.js";
export type { CaptureResult, TraceOptions } from "./engine/Tracer.js";
export { SourceMaps } from "./engine/SourceMaps.js";
export { BreakpointResolver } from "./engine/BreakpointResolver.js";
export { Renderer } from "./engine/Renderer.js";
export { Recorder } from "./engine/Recorder.js";
export { CdpDriver } from "./transport/CdpDriver.js";
export { DapDriver } from "./transport/DapDriver.js";
export type { ProtocolDriver } from "./transport/ProtocolDriver.js";
export { LineageAnalyzer } from "./analysis/LineageAnalyzer.js";
export { S3ArtifactStore } from "./storage/S3ArtifactStore.js";
export type { ArtifactStore } from "./storage/ArtifactStore.js";
export { Collector } from "./collector/Collector.js";
export { PostgresSessionStore } from "./collector/PostgresSessionStore.js";
export { createSessionStore } from "./collector/createSessionStore.js";
export type { StoreOptions } from "./collector/createSessionStore.js";
export type { SessionStore, SessionSummary } from "./collector/SessionStore.js";
export { DynamicCommand } from "./cli/commands/DynamicCommand.js";
export { DoctorCommand } from "./cli/commands/DoctorCommand.js";
export { Cli } from "./cli/Cli.js";
export { VERSION } from "./shared/version.js";
