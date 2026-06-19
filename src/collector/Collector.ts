import { logger } from "../shared/logger.js";
import { Code } from "../shared/codes.js";

const log = logger.child({ component: "collector" });
const CT_JSON = "application/json";

/**
 * The outcome of one emit. `ok` mirrors the old boolean; `status`/`body` (on an HTTP rejection) and `error`
 * (on a network/throw failure) let the caller surface *why* an emit failed — into the envelope's diagnostics
 * and the logs — instead of silently dropping it (a 400 used to log at `info` and the bool was swallowed).
 */
export interface EmitResult { ok: boolean; status?: number; body?: string; error?: string }

/** Well-known local collector URLs probed for auto-discovery, in priority order: the docker/dashboard port
 *  (14747, the compose-published host port from README/compose/scenarios), then the native `trace serve` default (4000). */
const DEFAULT_CANDIDATES = ["http://localhost:14747", "http://localhost:4000"];
const PROBE_TIMEOUT_MS = 500;
/** Cap on the rejection body kept in an {@link EmitResult}: enough to carry a real error message, bounded so a
 *  large error page can't bloat a caller that retains the result (e.g. across many onProgress emits). */
const MAX_BODY_CHARS = 10_000;

/**
 * Collector — the client-side emit helper for shipping trace envelopes to a remote collector.
 *
 * The collector *service* (ingest + persistence + realtime SSE + UI) is now the hosted Next.js dashboard
 * (`ui/`, `output: "standalone"`), launched by `trace serve` and deployed via the root Dockerfile. It exposes
 * the same `POST /v1/traces` contract. This class owns `emit()` plus the {@link resolve} auto-discovery that
 * lets a running dashboard catch every trace with zero configuration.
 */
export class Collector {
  /** POST an envelope to a collector's /v1/traces (used when TRACE_COLLECTOR_URL / --emit is set). */
  static async emit(url: string, envelope: unknown): Promise<EmitResult> {
    const endpoint = url.replace(/\/+$/, "") + "/v1/traces";
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": CT_JSON }, body: JSON.stringify(envelope) });
      if (response.ok) {
        log.info("emitted envelope", { endpoint, status: response.status });
        return { ok: true, status: response.status };
      }
      // A rejection is a real failure — log it at error with the collector's reason (e.g. "invalid envelope",
      // "trace store unavailable"), not at info. The caller folds this into the envelope's diagnostics.
      // Cap the retained body: callers hold onto the result, so a collector that answers with a giant HTML
      // error page shouldn't be able to bloat process memory (the log line truncates separately, to 500).
      const body = (await response.text().catch(() => "")).slice(0, MAX_BODY_CHARS);
      log.error("emit rejected", { code: Code.EMIT, endpoint, status: response.status, body: body.slice(0, 500) });
      return { ok: false, status: response.status, body };
    } catch (error: any) {
      log.error("emit failed", { code: Code.EMIT, endpoint, err: error });
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /** Is a collector listening at `url`? Any HTTP response (even a 404) counts as alive; a network error doesn't. */
  static async isAlive(url: string): Promise<boolean> {
    try {
      await fetch(url.replace(/\/+$/, ""), { method: "GET", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolve the collector to stream to. An explicit target (`--emit` / `TRACE_COLLECTOR_URL`) always wins and
   * is used as-is. Otherwise auto-discover: probe the well-known local collector ports and return the first
   * that answers, so a running `trace serve` dashboard catches every trace with zero config. Returns null when
   * nothing is configured and nothing is listening — a silent no-op (a missing collector never costs more than
   * an instant localhost connection-refused).
   */
  static async resolve(explicit?: string | null): Promise<string | null> {
    const configured = explicit?.trim() || process.env.TRACE_COLLECTOR_URL?.trim();
    if (configured) return configured;
    for (const url of DEFAULT_CANDIDATES) {
      if (await Collector.isAlive(url)) { log.info("auto-discovered collector", { url }); return url; }
    }
    return null;
  }
}
