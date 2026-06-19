import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { Trace, Code } from "trace-cli/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Reject envelopes larger than this (matches the old collector's ingress guard). */
const MAX_BYTES = 64 * 1024 * 1024;

/**
 * POST /v1/traces — ingest a trace envelope. Path is `/v1/traces` (NOT under `/api`) to match the wire
 * contract the CLI emits to (`Collector.emit` → `<url>/v1/traces`). The ingress boundary: hydrate untrusted
 * JSON into a Trace and enforce the envelope contract (`validate()`) before it touches the store. Reuses the
 * CLI's domain so validation + persistence are identical to a direct `trace … --emit` against the old collector.
 *
 * Status codes separate fault domains so a caller can tell *whose* problem it is — and never has to string-match:
 *   • 4xx + a `code` ⇒ the CALLER's envelope is wrong (too large / malformed JSON / schema-invalid / no sessionId)
 *   • 503 STORE_UNAVAILABLE ⇒ the SERVER's store (Postgres) is down or misconfigured — a transient infra fault,
 *     NOT a bad envelope. Previously every failure (including a dead DB) collapsed to one 400, which made an
 *     infra outage indistinguishable from a schema error. The internal error is logged, never returned.
 */
export async function POST(request: Request) {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) return NextResponse.json({ error: "envelope too large", code: Code.INGEST }, { status: 413 });

  let body: string;
  try {
    body = await request.text();
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message, code: Code.INGEST }, { status: 400 });
  }
  if (body.length > MAX_BYTES) return NextResponse.json({ error: "envelope too large", code: Code.INGEST }, { status: 413 });

  // Parse + validate the untrusted envelope. Any failure here is the caller's fault → 4xx.
  let envelope: Trace;
  try {
    envelope = Trace.fromPlain(JSON.parse(body));
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message, code: Code.INGEST }, { status: 400 });
  }
  const problems = envelope.validate();
  if (problems.length) return NextResponse.json({ error: "invalid envelope", code: Code.INGEST_INVALID, problems }, { status: 400 });

  // Persist. A failure here is the server's fault (store/DB) → 503, with the real cause logged, not leaked.
  try {
    const summary = await getStore().ingest(envelope.toJSON());
    if (!summary) return NextResponse.json({ error: "envelope has no meta.sessionId", code: Code.INGEST_NO_SESSION }, { status: 400 });
    return NextResponse.json({ ok: true, sessionId: summary.sessionId });
  } catch (error) {
    console.error("[collector] ingest failed — trace store unavailable", error);
    return NextResponse.json({ error: "trace store unavailable", code: Code.STORE }, { status: 503 });
  }
}
