import { logger } from "../shared/logger.js";
import { Code } from "../shared/codes.js";

const log = logger.child({ component: "collector" });
const CT_JSON = "application/json";

/**
 * Collector — the client-side emit helper for shipping trace envelopes to a remote collector.
 *
 * The collector *service* (ingest + persistence + realtime SSE + UI) is now the hosted Next.js dashboard
 * (`ui/`, `output: "standalone"`), launched by `trace serve` and deployed via the root Dockerfile. It exposes
 * the same `POST /v1/traces` contract. This class retains only `emit()`, used by the CLI when `--emit` /
 * `TRACE_COLLECTOR_URL` points a trace run at that dashboard.
 */
export class Collector {
  /** POST an envelope to a collector's /v1/traces (used when TRACE_COLLECTOR_URL / --emit is set). */
  static async emit(url: string, envelope: unknown): Promise<boolean> {
    const endpoint = url.replace(/\/+$/, "") + "/v1/traces";
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": CT_JSON }, body: JSON.stringify(envelope) });
      log.info("emitted envelope", { endpoint, status: response.status });
      return response.ok;
    } catch (error: any) {
      log.error("emit failed", { code: Code.EMIT, endpoint, err: error });
      return false;
    }
  }
}
