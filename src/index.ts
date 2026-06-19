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
export type { ProtocolDriver } from "./transport/ProtocolDriver.js";
export { LineageAnalyzer } from "./analysis/LineageAnalyzer.js";
export { S3ArtifactStore } from "./storage/S3ArtifactStore.js";
export type { ArtifactStore } from "./storage/ArtifactStore.js";
export { Collector } from "./collector/Collector.js";
export { PostgresSessionStore } from "./collector/PostgresSessionStore.js";
export { createSessionStore } from "./collector/createSessionStore.js";
export type { StoreOptions } from "./collector/createSessionStore.js";
export type { SessionStore, SessionSummary } from "./collector/SessionStore.js";
export { RunCommand } from "./cli/commands/RunCommand.js";
export type { RunRequest, RunResult, RunTargetKind } from "./cli/commands/RunCommand.js";
export { DoctorCommand } from "./cli/commands/DoctorCommand.js";
export { ExportCommand } from "./cli/commands/ExportCommand.js";
export { Cli } from "./cli/Cli.js";
export { VERSION } from "./shared/version.js";
export { logger, Logger } from "./shared/logger.js";
export type { LogLevel } from "./shared/logger.js";
