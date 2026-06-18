import { registerOTel } from "@vercel/otel";
import type { Instrumentation } from "next";

/**
 * OpenTelemetry self-observability. Next auto-instruments request/render/route-handler spans; this exports
 * them via OTLP to whatever collector `OTEL_EXPORTER_OTLP_ENDPOINT` points at (Jaeger / Grafana Tempo / an
 * OTel Collector). With no endpoint set it is a no-op, so dev and tests stay quiet.
 *
 * Nice symmetry: the tracing dashboard is itself traced with the same OTel primitives it visualizes.
 */
export function register() {
  registerOTel({ serviceName: "trace-dashboard" });
}

/** Surface server-side errors (Route Handlers + RSC) to the same observability backend. */
export const onRequestError: Instrumentation.onRequestError = (err, request, context) => {
  // Structured error breadcrumb; an OTel logs exporter can pick this up from stdout.
  console.error("[onRequestError]", {
    message: err instanceof Error ? err.message : String(err),
    path: request.path,
    method: request.method,
    routePath: context.routePath,
    routeType: context.routeType,
  });
};
